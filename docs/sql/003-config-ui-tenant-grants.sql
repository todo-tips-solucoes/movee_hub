-- =============================================================================
-- 003-config-ui-tenant-grants.sql
-- Feature: config-ui-tenant — GRANTs faltantes nas tabelas novas
-- Entregue ao operador para aplicar no banco — NÃO executar automaticamente.
--
-- PROBLEMA: o 001 criou "Grupo"/"Branding", mas o papel do PostgREST
-- (`authenticated`, usado pelo backend via JWT role) não recebeu GRANT →
-- toda query nessas tabelas retorna 42501 "permission denied for table Grupo".
-- Sintoma: login do pai não reconhece is_grupo_pai; /empresa/branding falha.
--
-- Como aplicar:
--   psql $DATABASE_URL -f docs/sql/003-config-ui-tenant-grants.sql
--   (depois recarregue o schema do PostgREST — NOTIFY já incluído abaixo)
--
-- Idempotente: GRANT é seguro re-executar.
-- =============================================================================

BEGIN;

-- Tabelas: o backend faz SELECT/INSERT/UPDATE (e DELETE em /grupo/filhos)
GRANT SELECT, INSERT, UPDATE, DELETE ON "Grupo"    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Branding" TO authenticated;

-- Sequences (bigserial) — necessárias para INSERT (POST) via PostgREST
GRANT USAGE, SELECT ON SEQUENCE "Grupo_id_seq"    TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE "Branding_id_seq" TO authenticated;

COMMIT;

-- Recarregar o schema/privilégios no PostgREST
NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- (Verificação opcional) Confirme os privilégios concedidos:
--
-- SELECT grantee, table_name, privilege_type
-- FROM information_schema.role_table_grants
-- WHERE table_name IN ('Grupo','Branding') AND grantee = 'authenticated'
-- ORDER BY table_name, privilege_type;
--
-- Se o seu PostgREST usar OUTRO papel além de 'authenticated' (ex.: um papel
-- anônimo para leitura), repita os GRANTs trocando o destino. O backend desta
-- app sempre assina o JWT do PostgREST com role='authenticated', então este
-- papel cobre todas as rotas (empresa e motorista).
-- =============================================================================
