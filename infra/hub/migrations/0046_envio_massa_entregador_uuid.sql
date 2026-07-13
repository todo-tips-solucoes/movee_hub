-- 0046 — "EnvioMassa".entregador_uuid (motorista canônico, WS-C
-- atividades; tasks.md FASE 6, 6.1.1; data-model.md §Entity Atividade;
-- research.md Decision 7). Idempotente (ADD COLUMN IF NOT EXISTS).
--
-- Identificação da(s) tabela(s) de atividade que precisam da coluna nova
-- (task 6.1.1, decisão registrada em state-decisions.sh dec dedicada):
--   - "FaturamentoLancamento" (0013) e "PerformanceTurno" (0014) JÁ
--     correlacionam por uuid HOJE: `entregador_id` (FK física para
--     "Entregador".id) + "Entregador".id_externo (uuid, 0010) — nenhuma
--     coluna nova é necessária, a correlação é um JOIN, não uma coluna
--     solta. Não tocadas por esta migration.
--   - "EnvioMassa" (validação de NF do app motorista) é o espelho do
--     schema LEGADO dentro do banco isolado do hub (migration 0033,
--     exclusiva de hub_homolog/hub_test — NUNCA chatmasterveloz/produção
--     real, cláusula pétrea). Essa tabela usa `cnpj_prestador` como chave,
--     sem qualquer referência a "Entregador" — é aqui que a correlação por
--     uuid precisa da coluna aditiva nova (FR-022A).
--
-- Coluna NULL: uma atividade de validação de NF cujo uuid ainda não tem
-- motorista cadastrado no hub continua sendo gravada normalmente, sem
-- bloqueio nem erro (data-model.md, clarify Q4) — só fica sem correlação
-- até o cadastro existir.
--
-- Aplicada SOMENTE no hub_homolog_db/hub-test (recursos hub-*, exceção G1
-- CLAUDE.md) via infra/hub/scripts/migrate.sh -f
-- infra/hub/compose.hub.homolog.yml (registra "SchemaMigration" + SIGUSR1
-- ao PostgREST do hub). NUNCA aplicada em chatmasterveloz/produção — a
-- "EnvioMassa" real de produção não é tocada por esta série de migrations.

ALTER TABLE "EnvioMassa" ADD COLUMN IF NOT EXISTS entregador_uuid uuid NULL;

-- Índice: a seção "Atividades" do detalhe do motorista (GET
-- /api/v1/motoristas/:id, task 6.4) correlaciona por
-- `entregador_uuid=eq.<idExterno>` ordenado desc por data — mesma
-- justificativa de performance (6.4.5) dos índices de
-- FaturamentoLancamento/PerformanceTurno (0013/0014): índice em coluna de
-- correlação evita full scan à medida que o histórico cresce.
CREATE INDEX IF NOT EXISTS idx_enviomassa_entregador_uuid
    ON "EnvioMassa"(entregador_uuid);

-- Recarrega o schema do PostgREST do hub (mesmo padrão de todas as
-- migrations anteriores).
NOTIFY pgrst, 'reload schema';
