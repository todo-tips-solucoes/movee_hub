-- 008_cadastro_motorista_base.sql
-- Feature: cadastro-motorista-base-validada
-- Objetivo: a tabela "Motorista" passa a ser a base curada do cliente. Ela é
--   populada pelo upload do movimento (pré-cadastro: linha com nome+CNPJ e SEM
--   senha) e o motorista só "ativa" o acesso definindo a senha no /register.
-- Pré-requisito: senha precisa ser NULLABLE (pré-cadastro nasce sem senha).
-- Idempotente. Rodar no banco (psql/pgadmin) e recarregar o schema do PostgREST.
--
-- NOTA: cnpj_prestador já é UNIQUE NOT NULL (001) e SELECT/INSERT já foram
--   concedidos a `authenticated` (001). Aqui só falta DROP NOT NULL + UPDATE.

-- 1) senha nullable — permite pré-cadastro vindo do upload (linha sem senha).
--    Login e /register tratam senha NULL como "ainda não cadastrado".
ALTER TABLE "Motorista" ALTER COLUMN senha DROP NOT NULL;

COMMENT ON COLUMN "Motorista".senha IS
  'Hash bcrypt (nunca texto plano — Constituição I). NULL = pré-cadastro vindo do upload, motorista ainda não definiu senha (não loga).';

-- 2) GRANT UPDATE: necessário para (a) /register definir a senha no pré-cadastro
--    e (b) CRUD admin editar nome/ativo e resetar senha (senha=NULL).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE grantee = 'authenticated'
      AND table_name = 'Motorista'
      AND privilege_type = 'UPDATE'
  ) THEN
    GRANT UPDATE ON "Motorista" TO authenticated;
  END IF;
END
$$;

-- Recarrega o cache de schema do PostgREST (nullability mudou).
NOTIFY pgrst, 'reload schema';
