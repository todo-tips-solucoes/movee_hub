-- 0000 — série única de migrations do hub (§4.6/§4.10; decisão D1).
-- Cria o registro de versão do schema. Idempotente (IF NOT EXISTS): é o
-- bootstrap que o migrate.sh aplica antes de consultar a própria tabela.
CREATE TABLE IF NOT EXISTS "SchemaMigration" (
    id          serial PRIMARY KEY,
    nome        text UNIQUE NOT NULL,
    aplicado_em timestamptz NOT NULL DEFAULT now()
);
