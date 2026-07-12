-- 0042 — RPC de busca de entregador por nome (hub-motorista-canonico FASE 2
-- / WS-B, tasks.md 2.1.2, contracts/api-motorista-canonico.md §WS-B,
-- research.md Decision 3). Idempotente (CREATE OR REPLACE FUNCTION +
-- CREATE INDEX IF NOT EXISTS). Aplicada por migrate.sh, que registra em
-- "SchemaMigration" e envia SIGUSR1 ao PostgREST.
--
-- NOTA DE NUMERAÇÃO: plan.md (Structure Decision) previa "novas = 0042+"
-- reservadas para WS-C (0042_conta_motorista_senha.sql/
-- 0043_seed_permissao_motoristas_credencial.sql), assumindo que WS-B não
-- precisaria de migration nenhuma. Na implementação, o contrato
-- (api-motorista-canonico.md §WS-B) exige `ILIKE hub_normaliza_nome(nome)`
-- — o PostgREST não expõe filtro de coluna transformada por função sem
-- RPC/computed column — então esta migration toma o próximo número
-- disponível (0042) e as migrations de WS-C (ainda não criadas nesta
-- execução) tomam 0043/0044 quando a FASE 3 rodar (numeração sequencial
-- por ordem de aplicação, não reserva fixa — mesmo padrão de todo o
-- histórico 0000-0041).
--
-- Mecanismo obrigatório: RPC parametrizada do PostgREST (mesmo padrão de
-- `hub_motoristas_busca`, migration 0023) — o termo de busca SEMPRE
-- trafega como parâmetro de bind nativo (`p_termo`), NUNCA concatenado em
-- querystring/SQL (mandato S1, gate owasp-security A05 Injection).
-- SECURITY INVOKER (não DEFINER): a função roda com os privilégios do role
-- `authenticated` chamador — a RLS de "Entregador" (0015, `id_empresa = ANY
-- (hub_jwt_escopo_ids())`) se aplica normalmente dentro da função, nenhum
-- bypass de isolamento multi-tenant. `p_id_empresa` é redundante por design
-- (mesmo racional de `hub_faturamento_totais`, 0027): o backend passa o
-- `id_empresa` resolvido do token, mas mesmo que passasse outro valor, a
-- RLS ainda filtra por `hub_jwt_escopo_ids()` e a função retorna zero
-- linhas — entregador de outra empresa nunca vaza (FR-007).
--
-- Índice trgm em hub_normaliza_nome(nome) — mesmo padrão de
-- idx_conta_motorista_nome_trgm (0021) — acelera o `LIKE` de substring
-- normalizada; "Entregador" só tinha o índice btree (id_empresa, nome) da
-- 0010, adequado para igualdade/ordenação mas não para busca por
-- substring.

CREATE INDEX IF NOT EXISTS idx_entregador_nome_trgm
    ON "Entregador" USING gin (hub_normaliza_nome(nome) gin_trgm_ops);

CREATE OR REPLACE FUNCTION hub_entregadores_busca(p_id_empresa int, p_termo text, p_limit int)
RETURNS TABLE (id int, nome text)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
    SELECT id, nome
    FROM "Entregador"
    WHERE id_empresa = p_id_empresa
      AND nome IS NOT NULL
      AND hub_normaliza_nome(nome) LIKE '%' || hub_normaliza_nome(p_termo) || '%'
    ORDER BY nome
    LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION hub_entregadores_busca(int, text, int) TO authenticated;
