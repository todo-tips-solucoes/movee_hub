-- 0010 — Dimensão Entregador (data-model.md Entity Entregador; research.md
-- Decision 1/9; tasks.md 1.1). Idempotente (CREATE TABLE IF NOT EXISTS +
-- CREATE INDEX IF NOT EXISTS). Aplicada por migrate.sh, que registra em
-- "SchemaMigration" e envia SIGUSR1 ao PostgREST.
--
-- Pessoa-entregadora dos CSVs de faturamento/performance — entidade DISTINTA
-- de "Motorista" (base de login/validação de NF do app motorista, tabela
-- legada em outro banco). Vínculo opcional via `motorista_id`: referência
-- LÓGICA (Decision 9), SEM FK física — "Motorista" mora fora do banco do hub,
-- mesmo padrão já usado para `empresa_id` em 0003 (ModuloEntidade/
-- UsuarioEntidade: "referência lógica a Empresa.id... sem FK física").
-- `id_empresa` idem: referência lógica a "Empresa.id" (legada, outro banco).

CREATE TABLE IF NOT EXISTS "Entregador" (
    id            serial PRIMARY KEY,
    id_empresa    int NOT NULL,
    id_externo    uuid NOT NULL,
    nome          text NULL,
    motorista_id  int NULL,
    ativo         boolean NOT NULL DEFAULT true,
    criado_em     timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id_empresa, id_externo)
);

CREATE INDEX IF NOT EXISTS idx_entregador_empresa_nome ON "Entregador"(id_empresa, nome);

-- GRANTs explícitos ao role `authenticated` (padrão S2, lição 42501). Sem
-- DELETE: entregador é dimensão upsert-only (Decision 9), desativação via
-- `ativo=false`.
GRANT SELECT, INSERT, UPDATE ON "Entregador" TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE "Entregador_id_seq" TO authenticated;
