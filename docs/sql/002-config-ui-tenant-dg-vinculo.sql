-- =============================================================================
-- 002-config-ui-tenant-dg-vinculo.sql
-- Feature: config-ui-tenant — FASE-1b: Migração D&G (vínculo ao Grupo)
-- Entregue ao operador para aplicar no banco — NÃO executar automaticamente.
--
-- PRÉ-REQUISITO: aplicar ANTES o 001-config-ui-tenant-schema.sql
--   (cria as tabelas "Grupo"/"Branding" e a coluna "Empresa".id_grupo).
--
-- Como aplicar:
--   psql $DATABASE_URL -f docs/sql/002-config-ui-tenant-dg-vinculo.sql
--
-- IDs da D&G confirmados pelo operador (2026-06-05):
--   id 2  D&G EXPRESS LTDA                              -> PAI (matriz)
--   id 3  D&G EXPRESS LTDA - São Bernardo do Campo      -> filho
--   id 4  D&G EXPRESS LTDA - Campinas                   -> filho
--   id 5  D&G EXPRESS LTDA - Santo André                -> filho
--   id 7  D&G EXPRESS LTDA - Belo Horizonte             -> filho
--   id 8  D&G EXPRESS LTDA - Curitiba                   -> filho
--
-- Idempotente: re-execução não duplica o grupo nem rouba empresas de outro grupo.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- (PRÉ-CHECK) Rode isto ANTES de aplicar, para confirmar que os 6 ids são da
-- D&G e que nenhum já pertence a outro grupo. Esperado: id_grupo NULL em todos
-- (ou já = ao grupo D&G, em re-execução). Se algum apontar para OUTRO grupo,
-- PARE e me avise.
-- ---------------------------------------------------------------------------
-- SELECT id, nome_empresa, id_grupo
-- FROM "Empresa"
-- WHERE id IN (2,3,4,5,7,8)
-- ORDER BY id;

BEGIN;

-- 1. Cria o grupo D&G (pai = empresa id 2), só se ainda não existir.
--    id_empresa_pai é UNIQUE → guard NOT EXISTS evita duplicar em re-run.
INSERT INTO "Grupo" (nome, id_empresa_pai)
SELECT 'D&G EXPRESS LTDA', 2
WHERE NOT EXISTS (SELECT 1 FROM "Grupo" WHERE id_empresa_pai = 2);

-- 2. Vincula matriz + filiais ao grupo D&G.
--    - Resolve o id do grupo pelo pai (id_empresa_pai = 2).
--    - Só toca empresas SEM grupo ou já no grupo D&G (NUNCA rouba de outro grupo
--      — respeita FR-004 / FR-INFRA-LOCK).
UPDATE "Empresa" e
SET    id_grupo = g.id
FROM   "Grupo" g
WHERE  g.id_empresa_pai = 2
  AND  e.id IN (2,3,4,5,7,8)
  AND  (e.id_grupo IS NULL OR e.id_grupo = g.id);

COMMIT;

-- ---------------------------------------------------------------------------
-- (PÓS-CHECK) Confirme o resultado: os 6 ids devem mostrar o MESMO id_grupo.
-- ---------------------------------------------------------------------------
-- SELECT e.id, e.nome_empresa, e.id_grupo, g.nome AS grupo, g.id_empresa_pai
-- FROM "Empresa" e
-- JOIN "Grupo" g ON g.id = e.id_grupo
-- WHERE e.id IN (2,3,4,5,7,8)
-- ORDER BY e.id;

-- Recarregar schema do PostgREST (apenas dados mudaram aqui, mas inofensivo):
-- NOTIFY pgrst, 'reload schema';

-- Branding da D&G: NÃO inserida aqui de propósito. O pai (id 2) configura
-- logo/cores/nome pela tela /dashboard/configuracoes/aparencia (PUT faz upsert).
-- Enquanto não configurar, o grupo herda o fallback MOVEE_DEFAULTS.
