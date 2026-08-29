-- 0054 — Remove as CHECK constraints que impedem importar valores como recebidos.
--
-- POR QUE ESTA MIGRATION EXISTE
-- Em 2026-08-29 o operador decidiu que a importação deve gravar o dado como o
-- portal EntreGô manda: valores negativos/zero entram como recebidos (PR #132)
-- e texto em campo numérico vira 0 (PR #134). A validação foi afrouxada em
-- `lib/hub-import-normalizer.js`.
--
-- 🔴 O QUE FALTOU E ESTA MIGRATION CORRIGE
-- O BANCO tem CHECK constraints espelhando as mesmas regras. Com a aplicação
-- aceitando `-1` e o banco recusando, o INSERT do LOTE falha e a importação
-- INTEIRA termina em `failed` — pior que antes, quando só a linha ruim era
-- descartada e o resto entrava (`completed_with_errors`).
--
-- Reproduzido no hub-homolog antes de chegar a produção (importação id=79):
--   contadores = {"total":4, "validas":4, "invalidas":0}   <- normalizer OK
--   erroResumo = 'new row for relation "PerformanceTurno" violates check
--                 constraint "PerformanceTurno_corridas_rejeitadas_check"'
--   status     = failed                                     <- as 4 linhas perdidas
--
-- ESCOPO: exatamente as 7 constraints dos campos cuja validação foi afrouxada.
-- NÃO mexe em `atingido` (0-1000) nem `tempo_disponivel_pct` (0-150): esses
-- CONTINUAM bloqueando no normalizer ('fora da faixa'), então suas constraints
-- nunca são violadas e seguem protegendo o banco.
--
-- Idempotente (`IF EXISTS`), aditiva, sem reescrita de dados: `DROP CONSTRAINT`
-- não toca nas linhas existentes.
--
-- ⚠️ Trade-off aceito conscientemente: sem estas constraints, o banco deixa de
-- ser a última barreira contra número negativo nestes campos. A barreira passa
-- a ser só a aplicação — que, por decisão de produto, agora aceita de
-- propósito. O rastro de cada valor estranho fica em `ImportacaoLinhaErro`.

ALTER TABLE "PerformanceTurno" DROP CONSTRAINT IF EXISTS "PerformanceTurno_corridas_ofertadas_check";
ALTER TABLE "PerformanceTurno" DROP CONSTRAINT IF EXISTS "PerformanceTurno_corridas_aceitas_check";
ALTER TABLE "PerformanceTurno" DROP CONSTRAINT IF EXISTS "PerformanceTurno_corridas_rejeitadas_check";
ALTER TABLE "PerformanceTurno" DROP CONSTRAINT IF EXISTS "PerformanceTurno_corridas_completadas_check";
ALTER TABLE "PerformanceTurno" DROP CONSTRAINT IF EXISTS "PerformanceTurno_corridas_canceladas_check";
ALTER TABLE "PerformanceTurno" DROP CONSTRAINT IF EXISTS "PerformanceTurno_min_entregadores_escala_check";

-- Faturamento: `valor > 0` impedia gravar lançamento de valor zero, que o
-- portal emite de fato (observado como `0**0` mascarado na importação id=7).
ALTER TABLE "FaturamentoLancamento" DROP CONSTRAINT IF EXISTS "FaturamentoLancamento_valor_check";
