-- 0004 — Trilha de auditoria imutável (data-model.md §Auditoria; tasks.md 1.4;
-- research.md Decision 6 — reforço em duas camadas). Idempotente.

CREATE TABLE IF NOT EXISTS "Auditoria" (
    id          bigserial PRIMARY KEY,
    id_empresa  int NULL,
    usuario_id  int NULL REFERENCES "Usuario"(id),
    acao        text NOT NULL,
    recurso     text NOT NULL,
    recurso_id  text NULL,
    detalhes    jsonb NOT NULL DEFAULT '{}',
    ip          inet NULL,
    criado_em   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auditoria_usuario_id ON "Auditoria"(usuario_id);
CREATE INDEX IF NOT EXISTS idx_auditoria_criado_em ON "Auditoria"(criado_em);

-- GRANT apenas SELECT/INSERT (Decision 6b) — nenhum endpoint do hub expõe
-- edição/remoção de Auditoria (Decision 6a, reforçado em hub-me.js/routers).
GRANT SELECT, INSERT ON "Auditoria" TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE "Auditoria_id_seq" TO authenticated;

-- Reforço de imutabilidade em duas camadas (FR-024, block-001):
-- (a) REVOKE explícito de UPDATE/DELETE do role de aplicação — defesa em
--     profundidade mesmo que nunca tenham sido concedidos acima.
REVOKE UPDATE, DELETE ON "Auditoria" FROM authenticated;

-- (b) Trigger que bloqueia INCONDICIONALMENTE qualquer UPDATE/DELETE, mesmo
--     que executado por um role com bypass de GRANT (ex.: dono da tabela).
CREATE OR REPLACE FUNCTION hub_bloqueia_alteracao_auditoria()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Auditoria e imutavel: UPDATE/DELETE bloqueados (FR-024)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auditoria_bloqueia_alteracao ON "Auditoria";
CREATE TRIGGER trg_auditoria_bloqueia_alteracao
    BEFORE UPDATE OR DELETE ON "Auditoria"
    FOR EACH ROW EXECUTE FUNCTION hub_bloqueia_alteracao_auditoria();
