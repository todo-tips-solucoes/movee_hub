-- Parte 1 de 2 do teste da 0098 (F3 — saldo mínimo carregado). Roda ANTES
-- da migration 0098, na mesma transação (driver: futuro
-- infra/hub/testes/hub-repasse-saldo-minimo.sh, molde de
-- 0092-antes.sql/0092-divisao-nota.test.sql).
--
-- Fecha UMA semana com o corpo VIGENTE (0092, sem saldo mínimo) para um
-- motorista dedicado. Depois da migration, `0098-saldo-minimo.test.sql`
-- confere o "retrato antes/depois" (quickstart F3, caso 8): as colunas
-- ANTIGAS do item continuam idênticas, e as colunas NOVAS (saldo_anterior,
-- valor_pago, valor_transportado, …) nascem NULL — sem reprocessamento
-- (FR-022) — e `ApuracaoRepasse.piso_aplicado` também NULL.
--
-- Semana escolhida DINAMICAMENTE (maior periodo_inicio já fechado da
-- empresa 6, +7) para nunca colidir com fixtures de outras migrations
-- testadas antes desta na mesma base (mesmo cuidado de 0098-rollback.test.sql).
\set ON_ERROR_STOP on

DO $$
DECLARE
  v_imp int; v_ver int; v_eid int; v_semana date; v_sub int; v_emp int; v_ap record;
BEGIN
  SELECT COALESCE(max(periodo_inicio), date '2026-01-05') + 7 INTO v_semana
  FROM "ApuracaoRepasse" WHERE id_empresa = 6;

  SELECT id INTO v_imp FROM "ImportacaoArquivo" WHERE id_empresa = 6 AND tipo = 'faturamento'
    AND status NOT IN ('pending','validating','processing') ORDER BY id DESC LIMIT 1;
  IF v_imp IS NULL THEN
    INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status)
    VALUES (6, 'faturamento', repeat('7', 64), 'completed') RETURNING id INTO v_imp;
  END IF;

  SELECT max(versao) + 1 INTO v_ver FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6;
  INSERT INTO "AdiantamentoConfiguracao" (
      id_empresa, versao, vigente_desde, timezone, dias_habilitados, horario_abertura, horario_corte,
      percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto,
      descricao_pix_modelo, apuracao_dia_inicio, apuracao_dias_ate_repasse, apuracao_data_base,
      categorias_extrato, categorias_nota, desconto_adiantamentos, desconto_debitos, repasse_visivel_app)
  SELECT 6, v_ver, now(), timezone, dias_habilitados, horario_abertura, horario_corte,
      percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto,
      descricao_pix_modelo, 1, 3, 'data_lancamento',
      -- categorias_nota/desconto_adiantamentos/desconto_debitos FORÇADOS
      -- (não copiados do vigente real): os casos do quickstart (5a/5b/3)
      -- exigem débito deduzindo o remanescente e crédito "Corridas
      -- concluidas" nota-elegível; herdar o valor de produção (hoje, em
      -- hub-homolog, desconto_debitos=false e categorias_nota=NULL) quebra
      -- silenciosamente esses casos (valor_nota fica NULL em vez de
      -- refletir o crédito).
      ARRAY['Corridas concluidas'], ARRAY['Corridas concluidas'], true, true, repasse_visivel_app
  FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6 ORDER BY versao DESC LIMIT 1;

  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (6, gen_random_uuid(), 'Pre-0098 Retrato Teste')
    RETURNING id INTO v_eid;
  INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
  VALUES (6, v_imp, v_eid, v_semana, v_semana, 'Credito', 42.00, 'Corridas concluidas', md5('t0098antes')||md5('x'));

  SELECT ue.usuario_id, ue.empresa_id INTO v_sub, v_emp
    FROM "UsuarioEntidade" ue
    JOIN "PapelPermissao" pp ON pp.papel_id = ue.papel_id
    JOIN "Permissao" p ON p.id = pp.permissao_id
    JOIN "ModuloEntidade" me ON me.modulo_id = p.modulo_id AND me.empresa_id = ue.empresa_id
   WHERE p.codigo = 'adiantamentos.pagamento_confirmar' AND ue.ativo AND me.ativo
   ORDER BY ue.usuario_id LIMIT 1;
  IF v_sub IS NULL THEN RAISE EXCEPTION 'fixture: nenhum usuario com adiantamentos.pagamento_confirmar'; END IF;
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","empresa_ativa":"%s","escopo":[6,%s]}', v_sub, v_emp, v_emp), true);

  -- Corpo vigente ANTES da 0098 (0092) — sem regra de saldo mínimo.
  SELECT * INTO v_ap FROM hub_adiantamento_repasse_fechar(v_semana);

  CREATE TEMP TABLE saldo_min_antes_ctx AS
    SELECT v_eid AS entregador_id, v_semana AS semana, v_ap.apuracao_id AS apuracao_id;
  RAISE NOTICE 'fixture pre-0098: entregador=% semana=% apuracao=%', v_eid, v_semana, v_ap.apuracao_id;
END $$;
