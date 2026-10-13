-- 0109 — Lote do repasse enxerga movimentos entrados por PLANILHA.
-- Corrige a 0108: hub_repasse_lote_avaliar só olhava "ApuracaoRepasseMovimento"
-- (preenchida apenas por "Gerar notas da semana"), mas em produção os movimentos
-- entram pela planilha do Envio em Massa, sem linha nessa trilha -> todos
-- NOTA_PENDENTE. Agora a nota vem de DOIS caminhos, unidos e deduplicados por
-- EnvioMassa.id: (a) hub, via trilha; (b) planilha, por CNPJ do entregador
-- (Entregador.motorista_id -> ContaMotorista) + período da apuração + escopo.
-- TRANSITÓRIO: o caminho (b) existe até o movimento nascer no hub.
-- Regra do operador: nota aprovada em TODOS os movimentos do conjunto unido.
-- Movimento da trilha com EnvioMassa apagada continua contando no total
-- (sem a linha não há prova da nota: o conservador é não pagar).
-- Entregador sem motorista_id/ContaMotorista não casa por (b): inalterado.
-- Mesma assinatura da 0108 (CREATE OR REPLACE, sem sobrecarga); GRANTs mantidos.
-- Índice comum (não CONCURRENTLY): migrate.sh aplica com `psql -1` (transação).
-- ROLLBACK: reaplicar a função da 0108; DROP INDEX IF EXISTS idx_envio_massa_cnpj_periodo;

CREATE INDEX IF NOT EXISTS idx_envio_massa_cnpj_periodo
    ON "EnvioMassa" (cnpj_prestador, dt_inicial, dt_final);

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
               i.valor_pago, cb.id AS conta_id,
               mov.total, mov.aprovadas, mov.reprovadas,
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
            SELECT count(u.eid) AS total,
                   count(em.id) FILTER (WHERE NULLIF(btrim(em.nota_ok, E' \t\r\n'), '') IS NOT NULL
                                          AND NULLIF(btrim(em.erro_validacao, E' \t\r\n'), '') IS NULL) AS aprovadas,
                   count(em.id) FILTER (WHERE NULLIF(btrim(em.erro_validacao, E' \t\r\n'), '') IS NOT NULL) AS reprovadas
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
                WHEN b.fechado_em IS NULL THEN 'APURACAO_ABERTA'
                WHEN b.valor_pago IS NULL OR b.valor_pago <= 0 THEN 'VALOR_INVALIDO'
                WHEN b.reprovadas > 0 THEN 'NOTA_REPROVADA'
                WHEN b.total = 0 OR b.aprovadas < b.total THEN 'NOTA_PENDENTE'
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
