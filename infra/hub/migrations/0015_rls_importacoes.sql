-- 0015 — RLS das 5 tabelas novas de hub-importacoes (data-model.md Migration
-- 0015; Constitution Princípio II NON-NEGOTIABLE; mesmo padrão de
-- 0006_rls_policies.sql). Idempotente (ENABLE ROW LEVEL SECURITY é
-- reexecutável; DROP POLICY IF EXISTS antes de cada CREATE POLICY).
--
-- Reusa `hub_jwt_escopo_ids()` (já criada em 0006) — NÃO recriada aqui.
-- Nega-por-padrão: claim `escopo` ausente/nula/vazia -> hub_jwt_escopo_ids()
-- = ARRAY[]::int[] -> nenhuma linha casa. Owner das migrations mantém bypass
-- de RLS (sem FORCE ROW LEVEL SECURITY), necessário para seeds/administração
-- — mesma decisão de 0006.
--
-- Cobertura: TODAS as 5 tabelas carregam id_empresa (incl. ImportacaoLinhaErro
-- denormalizado, research.md Decision 4) -> RLS uniforme em todas.

-- ─────────────────────────────────────────────────────────────────────────
-- Entregador — SELECT/INSERT/UPDATE (upsert por rota de processamento).
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "Entregador" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS entregador_select_por_escopo ON "Entregador";
CREATE POLICY entregador_select_por_escopo ON "Entregador"
    FOR SELECT
    USING (id_empresa = ANY (hub_jwt_escopo_ids()));

DROP POLICY IF EXISTS entregador_insert_por_escopo ON "Entregador";
CREATE POLICY entregador_insert_por_escopo ON "Entregador"
    FOR INSERT
    WITH CHECK (id_empresa = ANY (hub_jwt_escopo_ids()));

DROP POLICY IF EXISTS entregador_update_por_escopo ON "Entregador";
CREATE POLICY entregador_update_por_escopo ON "Entregador"
    FOR UPDATE
    USING (id_empresa = ANY (hub_jwt_escopo_ids()))
    WITH CHECK (id_empresa = ANY (hub_jwt_escopo_ids()));

-- ─────────────────────────────────────────────────────────────────────────
-- ImportacaoArquivo — SELECT/INSERT/UPDATE (transições de status/mutex,
-- 0011).
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "ImportacaoArquivo" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS importacaoarquivo_select_por_escopo ON "ImportacaoArquivo";
CREATE POLICY importacaoarquivo_select_por_escopo ON "ImportacaoArquivo"
    FOR SELECT
    USING (id_empresa = ANY (hub_jwt_escopo_ids()));

DROP POLICY IF EXISTS importacaoarquivo_insert_por_escopo ON "ImportacaoArquivo";
CREATE POLICY importacaoarquivo_insert_por_escopo ON "ImportacaoArquivo"
    FOR INSERT
    WITH CHECK (id_empresa = ANY (hub_jwt_escopo_ids()));

DROP POLICY IF EXISTS importacaoarquivo_update_por_escopo ON "ImportacaoArquivo";
CREATE POLICY importacaoarquivo_update_por_escopo ON "ImportacaoArquivo"
    FOR UPDATE
    USING (id_empresa = ANY (hub_jwt_escopo_ids()))
    WITH CHECK (id_empresa = ANY (hub_jwt_escopo_ids()));

-- ─────────────────────────────────────────────────────────────────────────
-- ImportacaoLinhaErro — SELECT/INSERT apenas (fato imutável, 0012).
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "ImportacaoLinhaErro" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS importacaolinhaerro_select_por_escopo ON "ImportacaoLinhaErro";
CREATE POLICY importacaolinhaerro_select_por_escopo ON "ImportacaoLinhaErro"
    FOR SELECT
    USING (id_empresa = ANY (hub_jwt_escopo_ids()));

DROP POLICY IF EXISTS importacaolinhaerro_insert_por_escopo ON "ImportacaoLinhaErro";
CREATE POLICY importacaolinhaerro_insert_por_escopo ON "ImportacaoLinhaErro"
    FOR INSERT
    WITH CHECK (id_empresa = ANY (hub_jwt_escopo_ids()));

-- ─────────────────────────────────────────────────────────────────────────
-- FaturamentoLancamento — SELECT/INSERT apenas (fato append-only, 0013).
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "FaturamentoLancamento" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS faturamentolancamento_select_por_escopo ON "FaturamentoLancamento";
CREATE POLICY faturamentolancamento_select_por_escopo ON "FaturamentoLancamento"
    FOR SELECT
    USING (id_empresa = ANY (hub_jwt_escopo_ids()));

DROP POLICY IF EXISTS faturamentolancamento_insert_por_escopo ON "FaturamentoLancamento";
CREATE POLICY faturamentolancamento_insert_por_escopo ON "FaturamentoLancamento"
    FOR INSERT
    WITH CHECK (id_empresa = ANY (hub_jwt_escopo_ids()));

-- ─────────────────────────────────────────────────────────────────────────
-- PerformanceTurno — SELECT/INSERT apenas (fato append-only, 0014).
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "PerformanceTurno" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS performanceturno_select_por_escopo ON "PerformanceTurno";
CREATE POLICY performanceturno_select_por_escopo ON "PerformanceTurno"
    FOR SELECT
    USING (id_empresa = ANY (hub_jwt_escopo_ids()));

DROP POLICY IF EXISTS performanceturno_insert_por_escopo ON "PerformanceTurno";
CREATE POLICY performanceturno_insert_por_escopo ON "PerformanceTurno"
    FOR INSERT
    WITH CHECK (id_empresa = ANY (hub_jwt_escopo_ids()));
