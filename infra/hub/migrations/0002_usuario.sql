-- 0002 — Contas de usuário do hub (data-model.md §Usuario; tasks.md 1.2).
-- Idempotente (IF NOT EXISTS / DO $$ guards). Aplicada por migrate.sh (S1),
-- que registra em "SchemaMigration" e envia SIGUSR1 ao PostgREST.
--
-- Bootstrap do role `authenticated` (reconciliação dec-027/dec-029): o
-- research.md Decision 4 atribui a CRIAÇÃO do role a 0006_rls_policies.sql,
-- mas tasks.md 1.2.3/1.3.2/1.4.3 exigem GRANT explícito "authenticated" já
-- nas migrations 0002/0003/0004 (FASE 1) — antes de 0006 (FASE 5) rodar.
-- Um GRANT ... TO authenticated antes do role existir falharia com
-- "role authenticated does not exist". Resolução: o role é criado aqui
-- (idempotente, mesmo padrão de hub_web_anon em 0001), e 0006 apenas
-- HABILITA RLS + cria as policies sobre um role que já existe — não
-- recria o role. distinct de hub_web_anon (anônimo, sem GRANTs) criado em
-- 0001.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO authenticated;

-- citext: e-mail case-insensitive (evita duplicidade Foo@x.com / foo@x.com)
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS "Usuario" (
    id                       serial PRIMARY KEY,
    email                    citext UNIQUE NOT NULL,
    senha_hash               text NOT NULL,
    nome                     text NOT NULL,
    ativo                    boolean NOT NULL DEFAULT true,
    tentativas_login         int NOT NULL DEFAULT 0,
    bloqueado_ate            timestamptz NULL,
    token_recuperacao_hash   text NULL,
    token_recuperacao_expira timestamptz NULL,
    criado_em                timestamptz NOT NULL DEFAULT now(),
    atualizado_em            timestamptz NOT NULL DEFAULT now(),
    criado_por               int NULL REFERENCES "Usuario"(id)
);

-- GRANTs explícitos ao role do PostgREST (lição 42501 — precedente
-- docs/sql/003-config-ui-tenant-grants.sql). Sem DELETE: nenhum fluxo desta
-- fundação remove conta (desativação é via `ativo=false`).
GRANT SELECT, INSERT, UPDATE ON "Usuario" TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE "Usuario_id_seq" TO authenticated;
