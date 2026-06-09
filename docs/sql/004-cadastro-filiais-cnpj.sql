-- =============================================================================
-- 004-cadastro-filiais-cnpj.sql
-- Feature: cadastro-filiais — coluna CNPJ por empresa (filial) + UNIQUE
-- Entregue ao operador para aplicar no banco — NAO executar automaticamente.
--
-- CONTEXTO: o cadastro de filiais (POST /grupo/empresas) grava o CNPJ da
-- empresa filial. A tabela "Empresa" hoje NAO possui a coluna cnpj.
--
-- Como aplicar:
--   psql $DATABASE_URL -f docs/sql/004-cadastro-filiais-cnpj.sql
--   (o NOTIFY de reload do schema do PostgREST ja esta incluido abaixo)
--
-- ORDEM DE DEPLOY: aplicar ESTE DDL ANTES de subir o backend que usa a coluna
-- cnpj (ver plano de deploy). O endpoint POST /grupo/empresas depende da coluna.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS + constraint guardada por DO-block.
-- =============================================================================

BEGIN;

-- 1. Coluna cnpj (text — preserva zeros a esquerda; formato de 14 digitos
--    validado no backend, nao no banco).
ALTER TABLE "Empresa"
  ADD COLUMN IF NOT EXISTS cnpj text;

-- 2. Constraint UNIQUE em cnpj.
--    PostgreSQL permite MULTIPLOS NULL sob UNIQUE → empresas existentes sem
--    cnpj permanecem validas; apenas novos cadastros (com cnpj) competem.
--    Guardado por DO-block para ser idempotente (ADD CONSTRAINT nao tem IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'empresa_cnpj_unique'
  ) THEN
    ALTER TABLE "Empresa"
      ADD CONSTRAINT empresa_cnpj_unique UNIQUE (cnpj);
  END IF;
END$$;

-- 3. GRANT ao role do PostgREST (authenticated) — mesmo padrao do 003.
--    A coluna cnpj e parte da tabela "Empresa"; se o GRANT em "Empresa" ja
--    cobre todas as colunas, este passo e defensivo/no-op. Mantido por
--    paridade com o padrao estabelecido (003-config-ui-tenant-grants.sql).
GRANT SELECT, INSERT, UPDATE ON "Empresa" TO authenticated;

COMMIT;

-- 4. Recarregar o schema/privilegios no PostgREST
NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- Verificacao (manual, apos aplicar):
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'Empresa' AND column_name = 'cnpj';
--   SELECT conname FROM pg_constraint WHERE conname = 'empresa_cnpj_unique';
-- =============================================================================
