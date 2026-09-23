-- Parte 1 de 2 do teste da 0090 (F3). Roda ANTES da migration, na MESMA
-- transação (ver o driver infra/hub/testes/hub-categoria-entra-na-nota.sh).
--
-- Existe por causa da restrição que o operador impôs à F3: "só pode ir para
-- produção caso esses valores não alterem o valor que eles já vêm essa
-- semana". Só dá para provar isso medindo ANTES e DEPOIS sobre os MESMOS
-- dados — por isso os fixtures nascem aqui e o retrato fica em tabelas
-- temporárias que a parte 2 confere.
--
-- Dados sintéticos: CNPJ e nome inventados (repositório público).
\set ON_ERROR_STOP on

DO $$
DECLARE
  v_imp int; v_ver int; v_cm int; v_eid int;
  v_hoje date; v_inicio date;
BEGIN
  SELECT id INTO v_imp FROM "ImportacaoArquivo" WHERE id_empresa = 6 AND tipo = 'faturamento'
    AND status NOT IN ('pending','validating','processing') ORDER BY id DESC LIMIT 1;
  IF v_imp IS NULL THEN
    INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status)
    VALUES (6, 'faturamento', repeat('7', 64), 'completed') RETURNING id INTO v_imp;
  END IF;

  -- Config vigente como a de produção depois da F1/F2: extrato configurado,
  -- repasse visível no app. `categorias_nota` nem existe ainda.
  SELECT max(versao) + 1 INTO v_ver FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6;
  INSERT INTO "AdiantamentoConfiguracao" (
      id_empresa, versao, vigente_desde, timezone, dias_habilitados, horario_abertura, horario_corte,
      percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto,
      descricao_pix_modelo, apuracao_dia_inicio, apuracao_dias_ate_repasse, apuracao_data_base,
      categorias_extrato, desconto_adiantamentos, desconto_debitos, repasse_visivel_app)
  SELECT 6, v_ver, now(), 'America/Sao_Paulo', dias_habilitados, horario_abertura, horario_corte,
      percentual, taxa_fixa, 'financeiro_lancamento', ARRAY['Corridas concluidas'], previsao_pagamento_texto,
      descricao_pix_modelo, 1, 3, 'data_lancamento',
      ARRAY['familia:promocao','Corridas concluidas','Gorjeta'], true, true, true
  FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6 ORDER BY versao DESC LIMIT 1;

  INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('89000000000190', 'Nota Teste') RETURNING id INTO v_cm;
  INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id)
  VALUES (6, gen_random_uuid(), 'Nota Teste', v_cm) RETURNING id INTO v_eid;

  -- Semana corrente (o extrato do motorista só enxerga a semana corrente).
  v_hoje   := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_inicio := v_hoje - ((extract(dow FROM v_hoje)::int - 1 + 7) % 7);
  CREATE TEMP TABLE f3_ctx AS SELECT v_eid AS entregador_id, v_inicio AS inicio;

  INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
  VALUES
    -- Base da nota (produção de corrida).
    (6, v_imp, v_eid, v_inicio,     v_inicio,     'Credito', 100.00, 'Corridas concluidas',        md5('t0090a')||md5('x')),
    (6, v_imp, v_eid, v_inicio + 1, v_inicio + 1, 'Credito',  60.00, 'Corridas concluidas',        md5('t0090b')||md5('x')),
    -- Fora da nota: campanha (entra pela família) e gorjeta.
    (6, v_imp, v_eid, v_inicio,     v_inicio,     'Credito',  25.00, 'Promocao - Campanha w99',    md5('t0090c')||md5('x')),
    (6, v_imp, v_eid, v_inicio + 1, v_inicio + 1, 'Credito',  15.00, 'Gorjeta',                    md5('t0090d')||md5('x')),
    -- Fora do extrato inteiro: não pode entrar em nenhum dos dois lados.
    (6, v_imp, v_eid, v_inicio + 2, v_inicio + 2, 'Credito',  50.00, 'Categoria fora do extrato',  md5('t0090e')||md5('x'));

  RAISE NOTICE 'fixture: entregador=% semana=%', v_eid, v_inicio;
END $$;

-- Retrato ANTES. Colunas explícitas de propósito: `SELECT *` mudaria de forma
-- junto com a função e a comparação viraria tautologia.
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
CREATE TEMP TABLE f3_repasse_antes AS
  SELECT r.entregador_id, r.creditos, r.adiantamentos, r.debitos, r.remanescente
  FROM f3_ctx c, hub_adiantamento_repasse(c.inicio, NULL, false, 0, 5000) r;

SELECT set_config('request.jwt.claims', '{"motorista_cnpj":"89000000000190","escopo":[6]}', true);
CREATE TEMP TABLE f3_extrato_antes AS
  SELECT e.visivel, e.periodo_inicio, e.periodo_fim, e.total, e.dias
  FROM hub_adiantamento_extrato_motorista() e;
