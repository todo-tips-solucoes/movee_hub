-- 0119_repasse_lote_nota_zero.sql
-- Feature `repasse-gera-movimento` (dec-054, decisao do operador 28/10) — a semana cuja NOTA zerou por DEDUCAO do pago
-- por fora, mas com gorjeta, gera um movimento "so gorjeta" (valor 0, nota nao emitida). Esse movimento nunca tera
-- nota validada; sem esta migration o lote o devolveria NOTA_PENDENTE para sempre (aprovadas 0 < total 1).
--
-- Mudanca MINIMA sobre a versao viva (0117 secao 9): o item entra no SELECT com `nota_a_emitir` (0118) e o
-- NOTA_PENDENTE nao vale quando `nota_a_emitir = 0` (nada a emitir — por definicao da 0118 a coluna ja inclui o saldo
-- de nota carregado, entao um saldo de producao retido sem nota continua com nota_a_emitir > 0 e segue pendente).
-- GATE ESTREITO (revisao): a dispensa por `nota_a_emitir = 0` so vale se NENHUM movimento da semana (trilha ou
-- planilha) tem valor > 0 (`com_valor`); `nota_a_emitir = 0` tambem ocorre sem pago por fora, e um movimento de planilha com
-- valor e nota nunca emitida nao pode sair apto. Continua lendo `nota_a_emitir` (0118) — a dependencia 0118->0119 FICA.
-- NULL (item pre-0118 ou sem categorias_nota) => `IS DISTINCT FROM 0` e verdadeiro => comportamento anterior intacto.
-- NOTA_REPROVADA e JA_PAGO_CONCILIADO etc. nao mudam. Assinatura e retorno iguais => CREATE OR REPLACE preserva GRANT.
-- ROLLBACK: reaplicar a funcao da 0117 secao 9.

CREATE OR REPLACE FUNCTION hub_repasse_lote_avaliar(p_apuracoes bigint[], p_entregadores int[])
RETURNS TABLE (
    apuracao_id bigint, entregador_id int, entregador_nome text,
    periodo_inicio date, periodo_fim date, id_empresa int,
    valor_pago numeric, conta_bancaria_id bigint, apta boolean, motivo_pendencia text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH base AS (
        SELECT i.apuracao_id, i.entregador_id, ent.nome AS entregador_nome,
               ar.periodo_inicio, ar.periodo_fim, ar.fechado_em, i.id_empresa,
               i.valor_pago, i.creditos, i.lancamentos_externos, i.nota_a_emitir, cb.id AS conta_id,
               mov.total, mov.com_valor, mov.aprovadas, mov.reprovadas, mov.conciliadas,
               EXISTS (SELECT 1 FROM "RepasseLoteItem" li
                       WHERE li.apuracao_id = i.apuracao_id AND li.entregador_id = i.entregador_id
                         AND li.situacao IN ('incluido', 'pago')) AS em_lote
        FROM "ApuracaoRepasseItem" i
        JOIN "ApuracaoRepasse" ar ON ar.id = i.apuracao_id
        JOIN "Entregador" ent ON ent.id = i.entregador_id
        LEFT JOIN "ContaBancariaMotorista" cb
               ON cb.entregador_id = i.entregador_id AND cb.status = 'APROVADA'
        LEFT JOIN LATERAL (
            -- conjunto UNIDO, distinto por id de EnvioMassa (UNION deduplica: o
            -- mesmo movimento nos dois caminhos conta UMA vez). A linha da
            -- trilha entra mesmo sem EnvioMassa (excluída pelo legado): o LEFT
            -- JOIN abaixo a mantém no total e fora das aprovadas = NOTA_PENDENTE.
            -- Chave unica "ha nota a emitir" = EnvioMassa.valor > 0 (a mesma do app do motorista, motorista.js
            -- VALOR_EMITIVEL): movimento de valor <= 0 NAO conta em total/aprovadas — o motorista nao o enxerga e
            -- ele nunca tera nota. Linha da trilha sem EnvioMassa (em.id NULL) continua contando (segue pendente).
            SELECT count(u.eid) FILTER (WHERE em.id IS NULL OR COALESCE(em.valor, 0) > 0) AS total,
                   -- movimentos com nota a emitir de fato (valor > 0): a dispensa de `nota_a_emitir = 0` NAO vale
                   -- se algum movimento da semana (trilha OU planilha) ainda tem valor positivo sem nota.
                   count(em.id) FILTER (WHERE COALESCE(em.valor, 0) > 0) AS com_valor,
                   count(em.id) FILTER (WHERE COALESCE(em.valor, 0) > 0
                                          AND NULLIF(btrim(em.nota_ok, E' \t\r\n'), '') IS NOT NULL
                                          AND NULLIF(btrim(em.erro_validacao, E' \t\r\n'), '') IS NULL) AS aprovadas,
                   count(em.id) FILTER (WHERE NULLIF(btrim(em.erro_validacao, E' \t\r\n'), '') IS NOT NULL) AS reprovadas,
                   count(em.id) FILTER (WHERE em.conciliada_em IS NOT NULL) AS conciliadas
            FROM (
                -- (a) hub: trilha de "Gerar notas da semana"
                SELECT m.envio_massa_id AS eid
                FROM "ApuracaoRepasseMovimento" m
                WHERE m.apuracao_id = i.apuracao_id AND m.entregador_id = i.entregador_id
                UNION
                -- (b) planilha: CNPJ do entregador + período da apuração, SEMPRE
                -- no escopo (a RLS da EnvioMassa é USING (true): não filtra nada).
                -- Período = dia de dt_inicial/dt_final == periodo_inicio/fim,
                -- escrito como faixa para usar o índice (mesmo resultado de ::date).
                SELECT em2.id
                FROM "ContaMotorista" cm
                JOIN "EnvioMassa" em2 ON em2.cnpj_prestador = cm.cnpj_prestador
                WHERE cm.id = ent.motorista_id
                  AND em2.id_empresa = ANY (hub_jwt_escopo_ids())
                  AND em2.dt_inicial >= ar.periodo_inicio AND em2.dt_inicial < ar.periodo_inicio + 1
                  AND em2.dt_final   >= ar.periodo_fim    AND em2.dt_final   < ar.periodo_fim + 1
            ) u
            LEFT JOIN "EnvioMassa" em ON em.id = u.eid
        ) mov ON true
        WHERE i.id_empresa = ANY (hub_jwt_escopo_ids())
          AND (
              (p_apuracoes IS NULL AND i.valor_pago > 0)
              OR EXISTS (SELECT 1 FROM unnest(p_apuracoes, p_entregadores) AS par(a, e)
                         WHERE par.a = i.apuracao_id AND par.e = i.entregador_id)
          )
    ), motivo AS (
        SELECT b.*,
            CASE
                WHEN b.em_lote THEN 'JA_EM_LOTE'
                WHEN b.conciliadas > 0 THEN 'JA_PAGO_CONCILIADO'
                WHEN b.fechado_em IS NULL THEN 'APURACAO_ABERTA'
                WHEN b.valor_pago IS NULL OR b.valor_pago <= 0 THEN 'VALOR_INVALIDO'
                WHEN b.reprovadas > 0 THEN 'NOTA_REPROVADA'
                -- H1: sem movimento (total = 0) a nota é pendente, EXCETO para crédito externo puro
                -- (nenhuma produção no item e `lancamentos_externos > 0`): não há nota a emitir.
                -- ALTO 1 (rodada 3): a dispensa vale SÓ para o próprio crédito. `valor_pago = remanescente +
                -- saldo_anterior`: sem o último termo, R$ 0,01 de crédito destravava qualquer saldo retido de
                -- PRODUÇÃO sem nota (W1 produz R$ 5,00 sem nota e fica retido; W2 recebe um crédito de R$ 0,01 e
                -- pagava R$ 5,01). `valor_pago <= lancamentos_externos` <=> nada além do crédito está sendo pago.
                -- Escolhida em vez de `saldo_anterior = 0` por não depender de ler outra coluna do item e por
                -- continuar certa se o piso mudar; e NÃO por `saldo_anterior_nota`, que é NULL/0 quando
                -- `categorias_nota` não está configurada (a dispensa abriria exatamente no caso sem classificação).
                -- Efeito colateral aceito: crédito + saldo transportado numa semana SEM produção volta a
                -- NOTA_PENDENTE, igual a um saldo transportado sozinho já é hoje (0112) — não é regressão.
                WHEN (b.nota_a_emitir IS DISTINCT FROM 0 OR b.com_valor > 0)
                     AND (b.aprovadas < b.total
                          OR (b.total = 0 AND NOT (b.creditos = 0 AND b.lancamentos_externos > 0
                                                   AND b.valor_pago <= b.lancamentos_externos))) THEN 'NOTA_PENDENTE'
                WHEN b.conta_id IS NULL THEN 'SEM_CONTA'
                ELSE NULL
            END AS m
        FROM base b
    )
    SELECT apuracao_id, entregador_id, entregador_nome, periodo_inicio, periodo_fim, id_empresa,
           valor_pago, conta_id, (m IS NULL), m
    FROM motivo
    -- modo "listar": quem já está em lote ativo não é candidato, é histórico
    WHERE NOT (p_apuracoes IS NULL AND em_lote)
$$;
