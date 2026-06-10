-- =============================================================================
-- 006b-cleanup-movee-grupo-teste-e2e.sql
-- Feature: movimento-por-filial — LIMPEZA do seed de teste E2E (006)
-- Entregue ao operador para aplicar APOS a validacao E2E multi-filial.
--
-- Remove a filial de teste, qualquer movimento (EnvioMassa) que ela tenha
-- gerado durante o E2E, e o Grupo de teste — restaurando o estado da Movee
-- (volta a ser single-empresa, sem grupo).
--
-- Como aplicar:
--   psql $DATABASE_URL -f docs/sql/006b-cleanup-movee-grupo-teste-e2e.sql
--
-- Idempotente: se o seed ja foi removido, é no-op.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  _grupo_id  integer;
  _filial_id integer;
BEGIN
  SELECT id INTO _filial_id FROM "Empresa" WHERE email = 'filial.teste.e2e@movee.com.br' LIMIT 1;
  SELECT id INTO _grupo_id  FROM "Grupo"   WHERE id_empresa_pai = 6 LIMIT 1;

  -- 1. Apagar movimento gerado pela filial de teste (se houve import no E2E).
  IF _filial_id IS NOT NULL THEN
    DELETE FROM "EnvioMassa" WHERE id_empresa = _filial_id;
    RAISE NOTICE 'EnvioMassa da filial de teste (id_empresa=%) removido.', _filial_id;
    -- 2. Apagar a filial de teste.
    DELETE FROM "Empresa" WHERE id = _filial_id;
    RAISE NOTICE 'Filial de teste (id=%) removida.', _filial_id;
  ELSE
    RAISE NOTICE 'Nenhuma filial de teste encontrada — nada a remover.';
  END IF;

  -- 3. Apagar o Grupo de teste (so se nao restarem outras filiais vinculadas).
  IF _grupo_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM "Empresa" WHERE id_grupo = _grupo_id) THEN
      DELETE FROM "Grupo" WHERE id = _grupo_id;
      RAISE NOTICE 'Grupo de teste (id=%) removido — Movee volta a single-empresa.', _grupo_id;
    ELSE
      RAISE NOTICE 'Grupo id=% ainda tem filiais vinculadas — NAO removido.', _grupo_id;
    END IF;
  END IF;
END$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
