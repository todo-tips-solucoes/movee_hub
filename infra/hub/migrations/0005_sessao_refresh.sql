-- 0005 — Sessão de refresh do hub (data-model.md §SessaoRefresh; tasks.md 1.2).
-- Hash-only (research.md Decision 9): token_hash guarda o hash do refresh
-- token, nunca o valor bruto. Idempotente.

CREATE TABLE IF NOT EXISTS "SessaoRefresh" (
    id           serial PRIMARY KEY,
    usuario_id   int NOT NULL REFERENCES "Usuario"(id),
    token_hash   text UNIQUE NOT NULL,
    expira_em    timestamptz NOT NULL,
    revogado_em  timestamptz NULL,
    user_agent   text NULL,
    ip           inet NULL,
    criado_em    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessaorefresh_usuario_id ON "SessaoRefresh"(usuario_id);

-- GRANTs explícitos ao role do PostgREST (lição 42501). Sem DELETE: a
-- revogação é via UPDATE (revogado_em), nunca remoção física da linha.
GRANT SELECT, INSERT, UPDATE ON "SessaoRefresh" TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE "SessaoRefresh_id_seq" TO authenticated;
