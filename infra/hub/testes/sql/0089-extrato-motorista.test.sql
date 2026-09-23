-- Teste da 0089 (extrato do motorista). Roda dentro de transação que termina
-- em ROLLBACK — ver infra/hub/testes/hub-extrato-motorista.sh. Dados
-- sintéticos: CNPJ e nome inventados (repositório público).
\set ON_ERROR_STOP on

DO $$
DECLARE
  v_cm int; v_eid int; v_imp int; v_ver int;
  v_inicio date; v_hoje date;
  r record; v_creditos numeric(12,2);
  v_dia jsonb;
BEGIN
  SELECT id INTO v_imp FROM "ImportacaoArquivo" WHERE id_empresa = 6 AND tipo = 'faturamento'
    AND status NOT IN ('pending','validating','processing') ORDER BY id DESC LIMIT 1;
  IF v_imp IS NULL THEN
    INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status)
    VALUES (6, 'faturamento', repeat('9', 64), 'completed') RETURNING id INTO v_imp;
  END IF;

  -- Config vigente com o extrato configurado (o que a F1 passou a permitir).
  SELECT max(versao) + 1 INTO v_ver FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6;
  INSERT INTO "AdiantamentoConfiguracao" (
      id_empresa, versao, vigente_desde, timezone, dias_habilitados, horario_abertura, horario_corte,
      percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto,
      descricao_pix_modelo, apuracao_dia_inicio, apuracao_dias_ate_repasse, apuracao_data_base,
      categorias_extrato, desconto_adiantamentos, desconto_debitos, repasse_visivel_app)
  SELECT 6, v_ver, now(), 'America/Sao_Paulo', dias_habilitados, horario_abertura, horario_corte,
      percentual, taxa_fixa, 'financeiro_lancamento', ARRAY['Corridas concluidas'], previsao_pagamento_texto,
      descricao_pix_modelo, 1, 3, 'data_lancamento',
      ARRAY['familia:promocao', 'Corridas concluidas'], true, false, true
  FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6 ORDER BY versao DESC LIMIT 1;

  INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('89000000000189', 'Extrato Teste') RETURNING id INTO v_cm;
  INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id)
  VALUES (6, gen_random_uuid(), 'Extrato Teste', v_cm) RETURNING id INTO v_eid;

  -- Semana corrente começando na SEGUNDA, no fuso da config.
  v_hoje   := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_inicio := v_hoje - ((extract(dow FROM v_hoje)::int - 1 + 7) % 7);

  INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
  VALUES
    -- Dia 1: duas corridas (viram UMA linha com quantidade 2) + uma campanha nova.
    (6, v_imp, v_eid, v_inicio, v_inicio, 'Credito', 60.00, 'Corridas concluidas',          md5('t0089a')||md5('x')),
    (6, v_imp, v_eid, v_inicio, v_inicio, 'Credito', 40.00, 'Corridas concluidas',          md5('t0089b')||md5('x')),
    (6, v_imp, v_eid, v_inicio, v_inicio, 'Credito', 25.00, 'Promocao - Campanha w99 NOVA', md5('t0089c')||md5('x')),
    -- Dia 2: uma corrida.
    (6, v_imp, v_eid, v_inicio + 1, v_inicio + 1, 'Credito', 30.00, 'Corridas concluidas',  md5('t0089d')||md5('x')),
    -- Fora do extrato: não pode aparecer nem somar.
    (6, v_imp, v_eid, v_inicio + 1, v_inicio + 1, 'Credito', 99.00, 'Gorjeta',              md5('t0089e')||md5('x')),
    -- Fora da semana: idem.
    (6, v_imp, v_eid, v_inicio - 7, v_inicio - 7, 'Credito', 77.00, 'Corridas concluidas',  md5('t0089f')||md5('x'));

  PERFORM set_config('request.jwt.claims',
    json_build_object('motorista_cnpj', '89000000000189', 'escopo', json_build_array(6))::text, true);

  SELECT * INTO r FROM hub_adiantamento_extrato_motorista();

  ASSERT r.visivel, 'o extrato deveria estar visível';
  ASSERT r.periodo_inicio = v_inicio, format('inicio esperado %s, veio %s', v_inicio, r.periodo_inicio);
  ASSERT r.periodo_fim = v_inicio + 6, 'fim = inicio + 6';
  -- 60 + 40 + 25 + 30. Fora: Gorjeta (99, fora do extrato) e a semana anterior (77).
  ASSERT r.total = 155.00, format('total esperado 155.00, veio %s', r.total);
  ASSERT jsonb_array_length(r.dias) = 2, format('esperava 2 dias, veio %s', jsonb_array_length(r.dias));

  v_dia := r.dias -> 0;
  ASSERT (v_dia ->> 'data')::date = v_inicio, 'o 1º dia é o início da semana';
  ASSERT (v_dia ->> 'total')::numeric = 125.00, format('dia 1 esperado 125.00, veio %s', v_dia ->> 'total');
  ASSERT jsonb_array_length(v_dia -> 'itens') = 2, 'dia 1 tem 2 categorias';
  -- As duas corridas viram UMA linha, com quantidade 2 (ordenado por valor desc).
  ASSERT (v_dia -> 'itens' -> 0 ->> 'descricao') = 'Corridas concluidas', 'maior valor primeiro';
  ASSERT (v_dia -> 'itens' -> 0 ->> 'quantidade')::int = 2, 'duas corridas no mesmo dia viram quantidade 2';
  ASSERT (v_dia -> 'itens' -> 0 ->> 'valor')::numeric = 100.00, 'somadas: 60 + 40';
  -- A campanha entrou pela FAMÍLIA (o token no extrato), não pelo nome exato.
  ASSERT (v_dia -> 'itens' -> 1 ->> 'descricao') = 'Promocao - Campanha w99 NOVA', 'campanha nova pela família';

  RAISE NOTICE 'ok  extrato: total=% em % dias (campanha nova pela familia; gorjeta e semana anterior fora)',
    r.total, jsonb_array_length(r.dias);

  -- INVARIANTE: o total do extrato é o MESMO crédito que o repasse mostra.
  -- Divergir aqui faria o motorista ver dois números para a mesma semana.
  SELECT creditos INTO v_creditos FROM hub_adiantamento_repasse_motorista();
  ASSERT v_creditos = r.total, format('repasse mostra %s e o extrato %s — divergiram', v_creditos, r.total);
  RAISE NOTICE 'ok  invariante: extrato (%) = creditos do repasse (%)', r.total, v_creditos;
END $$;

-- Sem `repasse_visivel_app`, o extrato não aparece (mesma guarda do repasse).
DO $$
DECLARE v_ver int; r record;
BEGIN
  SELECT max(versao) + 1 INTO v_ver FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6;
  INSERT INTO "AdiantamentoConfiguracao" (
      id_empresa, versao, vigente_desde, timezone, dias_habilitados, horario_abertura, horario_corte,
      percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto,
      descricao_pix_modelo, apuracao_dia_inicio, apuracao_dias_ate_repasse, apuracao_data_base,
      categorias_extrato, desconto_adiantamentos, desconto_debitos, repasse_visivel_app)
  SELECT 6, v_ver, now(), 'America/Sao_Paulo', dias_habilitados, horario_abertura, horario_corte,
      percentual, taxa_fixa, 'financeiro_lancamento', ARRAY['Corridas concluidas'], previsao_pagamento_texto,
      descricao_pix_modelo, 1, 3, 'data_lancamento',
      ARRAY['Corridas concluidas'], true, false, false   -- <- desligado
  FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6 ORDER BY versao DESC LIMIT 1;

  PERFORM set_config('request.jwt.claims',
    json_build_object('motorista_cnpj', '89000000000189', 'escopo', json_build_array(6))::text, true);
  SELECT * INTO r FROM hub_adiantamento_extrato_motorista();
  ASSERT NOT r.visivel, 'com repasse_visivel_app=false o extrato não pode aparecer';
  RAISE NOTICE 'ok  guarda: repasse_visivel_app desligado esconde o extrato';
END $$;
