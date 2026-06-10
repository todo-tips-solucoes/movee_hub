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

-- 4. (Hardening — OWASP A07) UNIQUE em email.
--    O cadastro de filiais checa unicidade de email no app (SELECT antes do
--    INSERT), o que e TOCTOU sob concorrencia. Uma UNIQUE constraint no banco
--    fecha a janela de corrida e e o failsafe que o backend JA espera
--    (POST /grupo/empresas trata violacao de unique em email como 400).
--
--    SEGURO PARA O DEPLOY: roda FORA da transacao do cnpj (acima, ja commitada)
--    e e GUARDADO por verificacao de duplicados — se ja existirem emails
--    repetidos, o bloco apenas EMITE AVISO e NAO aplica a constraint (em vez de
--    abortar). Esta secao nunca quebra o deploy do cnpj.
--
--    Se houver duplicados, o operador deve dedup-licar e re-rodar:
--      SELECT email, count(*) FROM "Empresa" GROUP BY email HAVING count(*) > 1;
DO $$
DECLARE
  _dups integer;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'empresa_email_unique') THEN
    RAISE NOTICE 'empresa_email_unique ja existe — nada a fazer.';
  ELSE
    SELECT count(*) INTO _dups
    FROM (SELECT email FROM "Empresa" WHERE email IS NOT NULL
          GROUP BY email HAVING count(*) > 1) d;
    IF _dups > 0 THEN
      RAISE NOTICE 'ATENCAO: % email(s) duplicado(s) em "Empresa" — empresa_email_unique NAO aplicada. Dedup-lique e re-rode este bloco.', _dups;
    ELSE
      ALTER TABLE "Empresa" ADD CONSTRAINT empresa_email_unique UNIQUE (email);
      RAISE NOTICE 'empresa_email_unique aplicada com sucesso.';
    END IF;
  END IF;
END$$;

-- 5. Recarregar o schema/privilegios no PostgREST
NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- Verificacao (manual, apos aplicar):
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'Empresa' AND column_name = 'cnpj';
--   SELECT conname FROM pg_constraint
--     WHERE conname IN ('empresa_cnpj_unique', 'empresa_email_unique');
-- =============================================================================
