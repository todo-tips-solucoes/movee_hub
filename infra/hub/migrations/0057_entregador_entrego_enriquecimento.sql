-- 0057 — Colunas de enriquecimento de dados EntreGô em "Entregador"
-- (hub-motorista-360, tasks.md 2.1; data-model.md §Entregador; spec.md
-- FR-001..FR-004, FR-016). Idempotente (ADD COLUMN IF NOT EXISTS). Aplicada
-- por migrate.sh, que registra em "SchemaMigration" e envia SIGUSR1 ao
-- PostgREST.
--
-- `dados_entrego_json`: payload bruto retornado pela consulta ao EntreGô
-- (dados pessoais sensíveis — CPF, telefone, endereço etc.), armazenado como
-- jsonb para não exigir nova migration a cada campo novo que o EntreGô
-- exponha. Leitura restrita pela permissão RBAC `motoristas.dados_sensiveis`
-- (seed 0058) no nível de aplicação — RLS por escopo já cobre isolamento
-- multi-tenant (a coluna vive na mesma linha de "Entregador", já protegida
-- pelas policies de 0010).
--
-- `dados_entrego_enriquecidos_em`: timestamp do último enriquecimento
-- bem-sucedido; NULL = nunca enriquecido.
-- `dados_entrego_solicitado_em`: timestamp da solicitação de enriquecimento
-- sob demanda (fila, FR-005); NULL = nenhuma solicitação pendente. Marca o
-- estado "na fila" sem precisar de uma tabela de fila separada — a própria
-- linha de "Entregador" é o registro de fila (mesmo padrão upsert-only já
-- usado nesta tabela).
--
-- Retenção/expurgo destes dados pessoais é DÍVIDA ASSUMIDA (dec-038,
-- CHK019 aberto por design) — esta migration não implementa TTL nem
-- anonimização.

ALTER TABLE "Entregador"
    ADD COLUMN IF NOT EXISTS dados_entrego_json jsonb NULL,
    ADD COLUMN IF NOT EXISTS dados_entrego_enriquecidos_em timestamptz NULL,
    ADD COLUMN IF NOT EXISTS dados_entrego_solicitado_em timestamptz NULL;
