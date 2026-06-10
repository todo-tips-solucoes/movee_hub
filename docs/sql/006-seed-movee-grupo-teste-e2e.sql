-- =============================================================================
-- 006-seed-movee-grupo-teste-e2e.sql
-- Feature: movimento-por-filial — SEED DE TESTE para validação E2E multi-filial
-- Entregue ao operador para aplicar no banco — NAO executar automaticamente.
--
-- OBJETIVO: a conta admin@movee.com.br (Empresa id=6) hoje NAO e grupo-pai e
-- NAO tem filiais em homologacao, entao o cenario multi-filial (combobox com
-- >1 opcao, trocar de filial, import por filial) nao pode ser exercitado.
--
-- Este seed:
--   1. cria uma linha "Grupo" com id_empresa_pai=6  -> Movee vira grupo-pai
--      (no proximo login, o token recebe is_grupo_pai=true + id_grupo)
--   2. cria 1 Empresa filial de teste vinculada a esse grupo
--
-- Apos aplicar, o agente re-loga como admin@movee.com.br e roda o E2E
-- multi-filial. AO FINAL, aplicar 006b-cleanup para remover este dado de teste.
--
-- Como aplicar:
--   psql $DATABASE_URL -f docs/sql/006-seed-movee-grupo-teste-e2e.sql
--
-- Idempotente: guardado por NOT EXISTS; re-aplicar é no-op.
-- DADO DE TESTE — REMOVER com 006b apos a validacao.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  _grupo_id integer;
  _pai_id   integer := 6;  -- Empresa "MOVEE SOLUÇÕES LOGISTICAS LTDA"
BEGIN
  -- 1. Grupo do pai (Movee). Cria se ainda nao existir (idempotente).
  SELECT id INTO _grupo_id FROM "Grupo" WHERE id_empresa_pai = _pai_id LIMIT 1;
  IF _grupo_id IS NULL THEN
    INSERT INTO "Grupo" (nome, id_empresa_pai)
    VALUES ('Grupo Movee (TESTE E2E movimento-por-filial)', _pai_id)
    RETURNING id INTO _grupo_id;
    RAISE NOTICE 'Grupo de teste criado: id=%', _grupo_id;
  ELSE
    RAISE NOTICE 'Grupo ja existia para pai=%: id=%', _pai_id, _grupo_id;
  END IF;

  -- 2. Filial de teste vinculada ao grupo. Cria se o email ainda nao existir.
  IF NOT EXISTS (SELECT 1 FROM "Empresa" WHERE email = 'filial.teste.e2e@movee.com.br') THEN
    INSERT INTO "Empresa" (nome_empresa, email, pass, cnpj, id_grupo)
    VALUES (
      'FILIAL TESTE E2E (movimento-por-filial)',
      'filial.teste.e2e@movee.com.br',
      '$2b$10$Ys3kWOH/XWNAXjeH.5.TduvIw8Lz1veqt7vlskLm4kT7lq5f9hRBO', -- senha: teste123
      '00000000000191',  -- CNPJ ficticio de teste (14 digitos)
      _grupo_id
    );
    RAISE NOTICE 'Filial de teste criada e vinculada ao grupo id=%', _grupo_id;
  ELSE
    RAISE NOTICE 'Filial de teste ja existia (email filial.teste.e2e@movee.com.br).';
  END IF;
END$$;

COMMIT;

-- Recarregar schema/privilegios no PostgREST (padrao dos demais SQL).
NOTIFY pgrst, 'reload schema';
