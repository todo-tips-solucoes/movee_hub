-- Confere o rollback da 0097 (papel financeiro_aprovador + trava de papel
-- restrito). tasks.md 2.3.3. DOIS casos — mesmo padrão de invocação de
-- 0090/0092-rollback.test.sql (BEGIN; <fixture>; migration 0097; <fixture
-- do caso>; 0097-rollback.sql; este arquivo; ROLLBACK;), mas em PASSADAS
-- SEPARADAS porque o caso 2 espera que o rollback ABORTE (driver dedicado —
-- tasks.md 2.5.6, extensão de hub-rbac-integration.sh — pendente de
-- ambiente hub-test-*; ver infra/hub/testes/hub-apuracao-divisao-nota.sh
-- para o molde de driver com `ROLLBACK=1`).
--
--   Caso 1 (sem vínculo — rollback APLICA): nenhum vínculo ativo em
--     financeiro_aprovador antes de 0097-rollback.sql. Rode o BLOCO 1
--     abaixo depois dele.
--   Caso 2 (com vínculo ATIVO — rollback RECUSA): antes de
--     0097-rollback.sql, rode o BLOCO 2 (cria o vínculo fixture e confere a
--     pré-condição). Na sequência, 0097-rollback.sql DEVE abortar com
--     `RAISE EXCEPTION`/ERRCODE 42501 — o driver espera essa passada
--     terminar com erro do psql (nunca chega a rodar o BLOCO 1).

\set ON_ERROR_STOP on

-- ── BLOCO 1 — pós-rollback bem-sucedido (caso 1) ────────────────────────
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM "Papel" WHERE nome = 'financeiro_aprovador') = 0,
    'caso 1: papel financeiro_aprovador deveria ter sido removido pelo rollback';
  ASSERT (SELECT count(*) FROM pg_proc WHERE proname = 'hub_papel_restrito') = 0,
    'caso 1: helper hub_papel_restrito deveria ter sido removido pelo rollback';
  ASSERT has_table_privilege('authenticated', '"PapelPermissao"', 'INSERT'),
    'caso 1: GRANT INSERT em PapelPermissao (0003:58) deveria ter voltado';
  ASSERT has_table_privilege('authenticated', '"Papel"', 'UPDATE'),
    'caso 1: GRANT UPDATE em Papel (0003:58) deveria ter voltado';
  RAISE NOTICE 'ok  rollback 0097 (caso 1, sem vinculo): papel/helper removidos, GRANT restaurado';
END $$;

-- ── BLOCO 2 — fixture ANTES de rodar 0097-rollback.sql (caso 2) ─────────
-- Roda com a migration 0097 ainda aplicada (financeiro_aprovador existe).
-- Só cria/confere a pré-condição; a asserção de que o rollback ABORTA fica
-- a cargo do driver (bash), que espera exit != 0 do psql nesta passada.
DO $$
DECLARE v_usuario_id int; v_papel_id int; v_tem_vinculo boolean;
BEGIN
  SELECT id INTO v_papel_id FROM "Papel" WHERE nome = 'financeiro_aprovador';
  IF v_papel_id IS NULL THEN
    RAISE EXCEPTION 'caso 2: financeiro_aprovador nao existe -- rode este bloco ANTES de 0097-rollback.sql, com a 0097 aplicada';
  END IF;

  SELECT id INTO v_usuario_id FROM "Usuario" LIMIT 1;
  INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo)
  VALUES (v_usuario_id, 6, v_papel_id, true)
  ON CONFLICT (usuario_id, empresa_id) DO UPDATE SET papel_id = EXCLUDED.papel_id, ativo = true;

  SELECT EXISTS (
    SELECT 1 FROM "UsuarioEntidade" ue JOIN "Papel" p ON p.id = ue.papel_id
    WHERE p.nome = 'financeiro_aprovador' AND ue.ativo = true
  ) INTO v_tem_vinculo;
  ASSERT v_tem_vinculo, 'caso 2: fixture nao criou o vinculo ativo esperado';
  RAISE NOTICE 'ok  caso 2 fixture pronta: 0097-rollback.sql deve abortar com 42501 ao rodar em seguida';
END $$;
