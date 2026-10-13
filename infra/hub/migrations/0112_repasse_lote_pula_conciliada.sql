-- 0112 — Lote do repasse NÃO paga de novo movimento já pago fora da plataforma.
-- A 0110 marcou como conciliados ("EnvioMassa".conciliada_em) os movimentos
-- fechados que a planilha UneCont provou pagos (nota_ok='UNECONT:<chave>',
-- erro_validacao NULL). A 0109 os contava como `aprovadas` -> o item virava apto
-- e, ao criar apuração de semana antiga, seria PAGO DUAS VEZES. Agora qualquer
-- movimento conciliado no conjunto do item bloqueia com JA_PAGO_CONCILIADO
-- (logo após JA_EM_LOTE: o que já está em lote segue sendo JA_EM_LOTE).
-- Única mudança no corpo vs. 0109: coluna `conciliadas` no LATERAL + um WHEN.
-- Mesma assinatura (CREATE OR REPLACE, GRANTs mantidos). Idempotente, aditiva.
-- ROLLBACK: reaplicar a função da 0109.

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
               mov.total, mov.aprovadas, mov.reprovadas, mov.conciliadas,
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
