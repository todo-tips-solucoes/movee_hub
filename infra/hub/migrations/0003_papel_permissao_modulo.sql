-- 0003 — RBAC: papéis, permissões, módulos (data-model.md §Papel/§Permissao/
-- §PapelPermissao/§Modulo/§ModuloEntidade/§UsuarioEntidade; tasks.md 1.3).
-- Idempotente. O reload do schema cache do PostgREST (SIGUSR1) é feito
-- automaticamente por migrate.sh ao final de cada corrida — não repetido aqui.

CREATE TABLE IF NOT EXISTS "Papel" (
    id         serial PRIMARY KEY,
    nome       text UNIQUE NOT NULL,
    escopo     text NOT NULL CHECK (escopo IN ('global', 'entidade')),
    is_sistema boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS "Modulo" (
    id     serial PRIMARY KEY,
    codigo text UNIQUE NOT NULL,
    nome   text NOT NULL,
    icone  text NULL,
    ordem  int NOT NULL DEFAULT 0,
    ativo  boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS "Permissao" (
    id        serial PRIMARY KEY,
    codigo    text UNIQUE NOT NULL,
    modulo_id int NOT NULL REFERENCES "Modulo"(id)
);

CREATE TABLE IF NOT EXISTS "PapelPermissao" (
    papel_id     int NOT NULL REFERENCES "Papel"(id),
    permissao_id int NOT NULL REFERENCES "Permissao"(id),
    PRIMARY KEY (papel_id, permissao_id)
);

-- empresa_id: referência LÓGICA a "Empresa.id" (tabela legada, fora do banco
-- do hub) — sem FK física, mesma decisão de UsuarioEntidade abaixo.
CREATE TABLE IF NOT EXISTS "ModuloEntidade" (
    modulo_id  int NOT NULL REFERENCES "Modulo"(id),
    empresa_id int NOT NULL,
    ativo      boolean NOT NULL DEFAULT true,
    UNIQUE (modulo_id, empresa_id)
);

CREATE TABLE IF NOT EXISTS "UsuarioEntidade" (
    id         serial PRIMARY KEY,
    usuario_id int NOT NULL REFERENCES "Usuario"(id),
    empresa_id int NOT NULL,
    papel_id   int NOT NULL REFERENCES "Papel"(id),
    ativo      boolean NOT NULL DEFAULT true,
    criado_em  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (usuario_id, empresa_id)
);

CREATE INDEX IF NOT EXISTS idx_usuarioentidade_empresa_id ON "UsuarioEntidade"(empresa_id);

-- GRANTs explícitos ao role do PostgREST (lição 42501). Sem DELETE: gestão de
-- papéis/permissões/vínculos é por `ativo=false`/administração S3+, não
-- remoção física nesta fundação.
GRANT SELECT, INSERT, UPDATE ON "Papel", "Modulo", "Permissao", "PapelPermissao", "ModuloEntidade", "UsuarioEntidade" TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE "Papel_id_seq" TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE "Modulo_id_seq" TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE "Permissao_id_seq" TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE "UsuarioEntidade_id_seq" TO authenticated;
