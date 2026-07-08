-- 0020 — Indices de subpraca nos fatos de faturamento/performance (S5 /
-- hub-motoristas, tasks.md 1.2, data-model.md "Area de atuacao (subpraca)",
-- research.md Decision 5). Idempotente (CREATE INDEX IF NOT EXISTS).
-- Aplicada por migrate.sh, que registra em "SchemaMigration" e envia
-- SIGUSR1 ao PostgREST.
--
-- Objetivo: suportar com indice as duas consultas de FR-002/FR-003 —
-- filtro de lista por area (id_empresa, subpraca, entregador_id) e as
-- areas distintas por entregador ordenadas por recencia no detalhe.
-- Nenhuma coluna/tabela nova; apenas indices sobre "FaturamentoLancamento"
-- e "PerformanceTurno" (ja existentes desde 0013/0014).

CREATE INDEX IF NOT EXISTS idx_faturamento_empresa_subpraca
    ON "FaturamentoLancamento"(id_empresa, subpraca, entregador_id);

CREATE INDEX IF NOT EXISTS idx_performance_empresa_subpraca
    ON "PerformanceTurno"(id_empresa, subpraca, entregador_id);
