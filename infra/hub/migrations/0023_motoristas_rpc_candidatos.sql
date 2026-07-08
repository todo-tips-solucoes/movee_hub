-- 0023 — Funcoes RPC de similaridade/busca para vinculo Entregador<->
-- ContaMotorista (S5 / hub-motoristas, tasks.md 1.5, data-model.md "Uso
-- combinado nas consultas de vinculo", research.md Decisions 10-11, gate
-- owasp-security). Idempotente (CREATE OR REPLACE FUNCTION). Aplicada por
-- migrate.sh, que registra em "SchemaMigration" e envia SIGUSR1 ao
-- PostgREST.
--
-- Mecanismo obrigatorio: sugestao/busca manual sao RPCs do PostgREST — o
-- PostgREST faz bind de parametros nativamente (mesma garantia de uma
-- prepared statement), NUNCA SQL montado por concatenacao de string no
-- backend Node (OWASP A05). SECURITY INVOKER (nao DEFINER): as funcoes
-- rodam com os privilegios do role authenticated chamador, entao a RLS de
-- "Entregador" (0015) se aplica normalmente dentro da funcao — nenhum
-- bypass de isolamento multi-tenant. Elegibilidade de grupo (FR-010/
-- FR-011) resolvida DENTRO das duas funcoes via JOIN "EmpresaGrupoMovee":
-- entidade fora do grupo nunca chega ao CROSS JOIN "ContaMotorista"
-- (retorna 0 linhas, backend responde entidadeElegivel:false, items:[],
-- nunca erro). Entregador fora do escopo do token -> RLS filtra a CTE
-- "alvo" -> 0 linhas -> backend traduz em 404 (mesmo padrao de
-- GET /motoristas/:id).

CREATE OR REPLACE FUNCTION hub_motoristas_candidatos(p_entregador_id int)
RETURNS TABLE (
    conta_motorista_id int, nome text, cnpj_prestador text,
    similaridade real, ja_vinculado_a int, ja_vinculado_a_nome text
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
    WITH alvo AS (
        SELECT id_empresa, nome FROM "Entregador" WHERE id = p_entregador_id
    )
    SELECT cm.id, cm.nome, cm.cnpj_prestador,
           similarity(hub_normaliza_nome(cm.nome), hub_normaliza_nome(alvo.nome)),
           e2.id, e2.nome
    FROM alvo
    JOIN "EmpresaGrupoMovee" g ON g.id_empresa = alvo.id_empresa
    CROSS JOIN "ContaMotorista" cm
    LEFT JOIN "Entregador" e2 ON e2.motorista_id = cm.id AND e2.id <> p_entregador_id
    WHERE similarity(hub_normaliza_nome(cm.nome), hub_normaliza_nome(alvo.nome)) >= 0.3
    ORDER BY 4 DESC
    LIMIT 10;
$$;

CREATE OR REPLACE FUNCTION hub_motoristas_busca(p_entregador_id int, p_termo text, p_limit int, p_offset int)
RETURNS TABLE (
    conta_motorista_id int, nome text, cnpj_prestador text,
    ja_vinculado_a int, ja_vinculado_a_nome text, total bigint
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
    WITH alvo AS (
        SELECT id_empresa FROM "Entregador" WHERE id = p_entregador_id
    ), elegivel AS (
        SELECT 1 FROM alvo JOIN "EmpresaGrupoMovee" g ON g.id_empresa = alvo.id_empresa
    ), base AS (
        SELECT cm.id, cm.nome, cm.cnpj_prestador, e2.id AS vinc_id, e2.nome AS vinc_nome
        FROM "ContaMotorista" cm
        LEFT JOIN "Entregador" e2 ON e2.motorista_id = cm.id AND e2.id <> p_entregador_id
        WHERE EXISTS (SELECT 1 FROM elegivel)
          AND hub_normaliza_nome(cm.nome) LIKE '%' || hub_normaliza_nome(p_termo) || '%'
    )
    SELECT id, nome, cnpj_prestador, vinc_id, vinc_nome, count(*) OVER ()
    FROM base ORDER BY nome LIMIT p_limit OFFSET p_offset;
$$;

GRANT EXECUTE ON FUNCTION hub_motoristas_candidatos(int) TO authenticated;
GRANT EXECUTE ON FUNCTION hub_motoristas_busca(int, text, int, int) TO authenticated;
