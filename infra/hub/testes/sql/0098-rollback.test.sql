-- Confere o rollback da 0098 (saldo mínimo carregado). tasks.md 3.2.3. DOIS
-- casos — mesmo padrão de 0092/0097-rollback.test.sql (BEGIN; <fixture>;
-- migration 0098; <fixture do caso>; 0098-rollback.sql; este arquivo;
-- ROLLBACK;), em PASSADAS SEPARADAS porque o caso 2 espera que o rollback
-- ABORTE (driver dedicado — tasks.md 2.3.4/3.2.3, molde `ROLLBACK=1` em
-- infra/hub/testes/hub-apuracao-divisao-nota.sh).
--
--   Caso 1 (sem apuração pós-0098 com saldo pendente — rollback APLICA):
--     nenhuma linha com `valor_transportado > 0` numa apuração com
--     `piso_aplicado IS NOT NULL`. Rode o BLOCO 1 abaixo depois de
--     0098-rollback.sql.
--   Caso 2 (com saldo pendente — rollback RECUSA): antes de
--     0098-rollback.sql, rode o BLOCO 2 (fecha uma semana com um motorista
--     retido e confere a pré-condição). Na sequência, 0098-rollback.sql
--     DEVE abortar com `RAISE EXCEPTION`/ERRCODE 42501 — o driver espera
--     essa passada terminar com erro do psql (nunca chega a rodar o
--     BLOCO 1).

\set ON_ERROR_STOP on

-- ── BLOCO 1 — pós-rollback bem-sucedido (caso 1) ────────────────────────
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM information_schema.columns
            WHERE table_name = 'ApuracaoRepasseItem' AND column_name = 'saldo_anterior') = 0,
    'caso 1: coluna saldo_anterior deveria ter sido removida pelo rollback';
  ASSERT (SELECT count(*) FROM information_schema.columns
            WHERE table_name = 'ApuracaoRepasseItem' AND column_name = 'valor_pago') = 0,
    'caso 1: coluna valor_pago deveria ter sido removida pelo rollback';
  ASSERT (SELECT count(*) FROM information_schema.columns
            WHERE table_name = 'AdiantamentoConfiguracao' AND column_name = 'repasse_valor_minimo') = 0,
    'caso 1: coluna repasse_valor_minimo deveria ter sido removida pelo rollback';
  ASSERT (SELECT count(*) FROM information_schema.columns
            WHERE table_name = 'ApuracaoRepasse' AND column_name = 'piso_aplicado') = 0,
    'caso 1: coluna piso_aplicado deveria ter sido removida pelo rollback';
  ASSERT (SELECT pg_get_function_result('hub_adiantamento_repasse_motorista()'::regprocedure))
           NOT LIKE '%saldo_anterior%',
    'caso 1: hub_adiantamento_repasse_motorista deveria ter voltado ao shape sem saldo_anterior';
  RAISE NOTICE 'ok  rollback 0098 (caso 1, sem saldo pendente): colunas e funcoes restauradas';
END $$;

-- ── BLOCO 2 — fixture ANTES de rodar 0098-rollback.sql (caso 2) ─────────
-- Roda com a migration 0098 ainda aplicada. Fecha uma semana com um
-- motorista cujo remanescente fica RETIDO (0 < total < piso), garantindo
-- valor_transportado > 0 -- só cria/confere a pré-condição; a asserção de
-- que o rollback ABORTA fica a cargo do driver (bash), que espera
-- exit != 0 do psql nesta passada.
DO $$
DECLARE
  v_imp int; v_ver int; v_eid int; v_seg date; v_sub int; v_emp int; v_ap record;
  v_transportado numeric;
BEGIN
  v_seg := date '2026-04-06'; -- segunda-feira futura, isolada de fixtures de outros testes

  SELECT id INTO v_imp FROM "ImportacaoArquivo" WHERE id_empresa = 6 AND tipo = 'faturamento'
    AND status NOT IN ('pending','validating','processing') ORDER BY id DESC LIMIT 1;
  IF v_imp IS NULL THEN
    INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status)
    VALUES (6, 'faturamento', repeat('6', 64), 'completed') RETURNING id INTO v_imp;
  END IF;

  SELECT max(versao) + 1 INTO v_ver FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6;
  INSERT INTO "AdiantamentoConfiguracao" (
      id_empresa, versao, vigente_desde, timezone, dias_habilitados, horario_abertura, horario_corte,
      percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto,
      descricao_pix_modelo, apuracao_dia_inicio, apuracao_dias_ate_repasse, apuracao_data_base,
      categorias_extrato, categorias_nota, repasse_valor_minimo,
      desconto_adiantamentos, desconto_debitos, repasse_visivel_app)
  SELECT 6, v_ver, now(), timezone, dias_habilitados, horario_abertura, horario_corte,
      percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto,
      descricao_pix_modelo, 1, 3, 'data_lancamento',
      ARRAY['Corridas concluidas'], categorias_nota, 5.50,
      desconto_adiantamentos, desconto_debitos, repasse_visivel_app
  FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6 ORDER BY versao DESC LIMIT 1;

  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (6, gen_random_uuid(), 'Rollback Retido Teste')
    RETURNING id INTO v_eid;
  INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
  VALUES (6, v_imp, v_eid, v_seg, v_seg, 'Credito', 3.00, 'Corridas concluidas', md5('t0098rb')||md5('x'));

  SELECT ue.usuario_id, ue.empresa_id INTO v_sub, v_emp
    FROM "UsuarioEntidade" ue
    JOIN "PapelPermissao" pp ON pp.papel_id = ue.papel_id
    JOIN "Permissao" p ON p.id = pp.permissao_id
    JOIN "ModuloEntidade" me ON me.modulo_id = p.modulo_id AND me.empresa_id = ue.empresa_id
   WHERE p.codigo = 'adiantamentos.pagamento_confirmar' AND ue.ativo AND me.ativo
   ORDER BY ue.usuario_id LIMIT 1;
  IF v_sub IS NULL THEN RAISE EXCEPTION 'caso 2: nenhum usuario com adiantamentos.pagamento_confirmar'; END IF;
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","empresa_ativa":"%s","escopo":[6,%s]}', v_sub, v_emp, v_emp), true);

  SELECT * INTO v_ap FROM hub_adiantamento_repasse_fechar(v_seg);

  SELECT valor_transportado INTO v_transportado FROM "ApuracaoRepasseItem"
   WHERE apuracao_id = v_ap.apuracao_id AND entregador_id = v_eid;
  ASSERT v_transportado = 3.00, format('caso 2: fixture deveria reter 3.00, veio %s', v_transportado);
  RAISE NOTICE 'ok  caso 2 fixture pronta (apuracao=%, transportado=3.00): 0098-rollback.sql deve abortar com 42501 ao rodar em seguida', v_ap.apuracao_id;
END $$;
