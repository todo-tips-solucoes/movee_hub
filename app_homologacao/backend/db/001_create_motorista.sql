-- Migração: cria tabela Motorista para o App Motorista (PWA)
-- Idempotente: usa CREATE TABLE IF NOT EXISTS + DO $$ para permissões
-- Feature: app-motorista-nfse | Data: 2026-06-04

CREATE TABLE IF NOT EXISTS "Motorista" (
  id          bigserial PRIMARY KEY,
  cnpj_prestador text UNIQUE NOT NULL,
  senha       text NOT NULL,
  nome        text,
  ativo       boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE "Motorista" IS 'Identidade que autentica no App Motorista PWA. cnpj_prestador casa com EnvioMassa.cnpj_prestador.';
COMMENT ON COLUMN "Motorista".cnpj_prestador IS 'Chave de login; sempre armazenado sem pontuação (somente dígitos).';
COMMENT ON COLUMN "Motorista".senha IS 'Hash bcrypt (nunca texto plano — Constituição I).';
COMMENT ON COLUMN "Motorista".ativo IS 'Login negado se false.';

-- Permissões PostgREST: role "authenticated" coerente com o padrão da tabela Empresa
DO $$
BEGIN
  -- SELECT: motorista autenticado pode ler seus próprios dados via filtro no backend
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE grantee = 'authenticated'
      AND table_name = 'Motorista'
      AND privilege_type = 'SELECT'
  ) THEN
    GRANT SELECT ON "Motorista" TO authenticated;
  END IF;

  -- INSERT: necessário para auto-cadastro via backend
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE grantee = 'authenticated'
      AND table_name = 'Motorista'
      AND privilege_type = 'INSERT'
  ) THEN
    GRANT INSERT ON "Motorista" TO authenticated;
  END IF;

  -- USAGE na sequence do id
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_usage_grants
    WHERE grantee = 'authenticated'
      AND object_name = 'Motorista_id_seq'
  ) THEN
    GRANT USAGE ON SEQUENCE "Motorista_id_seq" TO authenticated;
  END IF;
END
$$;
