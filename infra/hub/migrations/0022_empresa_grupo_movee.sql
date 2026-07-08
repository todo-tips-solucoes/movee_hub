-- 0022 — EmpresaGrupoMovee: allowlist minima de id_empresa do grupo Movee
-- (S5 / hub-motoristas, tasks.md 1.4, data-model.md Entity
-- EmpresaGrupoMovee, research.md Decision 2). Idempotente (CREATE TABLE IF
-- NOT EXISTS). Aplicada por migrate.sh, que registra em "SchemaMigration"
-- e envia SIGUSR1 ao PostgREST.
--
-- Resolve elegibilidade de grupo (FR-010/FR-011) sem reconstruir
-- mesmoGrupoQue/Empresa/Grupo dentro do banco isolado do hub — evidencia em
-- 0006_rls_policies.sql: "mesmoGrupoQue/resolveScope NAO se aplicam ao
-- hub". id_empresa e referencia LOGICA (mesmo padrao ja usado em
-- Entregador.id_empresa), sem FK fisica — a entidade de origem mora fora
-- do banco do hub. Sem RLS: allowlist global nao sensivel, mesma classe de
-- Papel/Modulo. Populada por seed por ambiente (FASE 2).

CREATE TABLE IF NOT EXISTS "EmpresaGrupoMovee" (
    id_empresa int PRIMARY KEY,
    criado_em  timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON "EmpresaGrupoMovee" TO authenticated;
