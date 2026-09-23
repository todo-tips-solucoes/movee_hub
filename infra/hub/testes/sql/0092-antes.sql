-- Parte 1 de 2 do teste da 0092 (F4-B). Roda ANTES da migration, na mesma
-- transação (driver: infra/hub/testes/hub-apuracao-divisao-nota.sh).
-- Dados sintéticos: CNPJ e nome inventados (repositório público).
\set ON_ERROR_STOP on

DO $$
DECLARE
  v_imp int; v_ver int; v_eid int; v_seg date;
BEGIN
  -- Semana de apuração no PASSADO, começando numa segunda, para não colidir
  -- com dados reais nem depender do relógio.
  v_seg := date '2026-03-02';

  SELECT id INTO v_imp FROM "ImportacaoArquivo" WHERE id_empresa = 6 AND tipo = 'faturamento'
    AND status NOT IN ('pending','validating','processing') ORDER BY id DESC LIMIT 1;
  IF v_imp IS NULL THEN
    INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status)
    VALUES (6, 'faturamento', repeat('5', 64), 'completed') RETURNING id INTO v_imp;
  END IF;

  -- Config vigente com extrato E nota configurados (o estado de produção
  -- depois da F3): a gorjeta entra no repasse mas fica fora da nota.
  SELECT max(versao) + 1 INTO v_ver FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6;
  INSERT INTO "AdiantamentoConfiguracao" (
      id_empresa, versao, vigente_desde, timezone, dias_habilitados, horario_abertura, horario_corte,
      percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto,
      descricao_pix_modelo, apuracao_dia_inicio, apuracao_dias_ate_repasse, apuracao_data_base,
      categorias_extrato, categorias_nota, desconto_adiantamentos, desconto_debitos, repasse_visivel_app)
  SELECT 6, v_ver, now(), 'America/Sao_Paulo', dias_habilitados, horario_abertura, horario_corte,
      percentual, taxa_fixa, 'financeiro_lancamento', ARRAY['Corridas concluidas'], previsao_pagamento_texto,
      descricao_pix_modelo, 1, 3, 'data_lancamento',
      ARRAY['Corridas concluidas','Gorjeta','familia:promocao'],   -- extrato: paga tudo
      ARRAY['Corridas concluidas','familia:promocao'],             -- nota: tudo menos gorjeta
      true, true, true
  FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6 ORDER BY versao DESC LIMIT 1;

  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (6, gen_random_uuid(), 'Divisao Teste')
    RETURNING id INTO v_eid;

  INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
  VALUES
    (6, v_imp, v_eid, v_seg,     v_seg,     'Credito', 400.00, 'Corridas concluidas',      md5('t0092a')||md5('x')),
    (6, v_imp, v_eid, v_seg + 1, v_seg + 1, 'Credito',  80.00, 'Promocao - Campanha w10',  md5('t0092b')||md5('x')),
    (6, v_imp, v_eid, v_seg + 2, v_seg + 2, 'Credito',  20.00, 'Gorjeta',                  md5('t0092c')||md5('x')),
    (6, v_imp, v_eid, v_seg + 3, v_seg + 3, 'Credito',  50.00, 'Fora do extrato',          md5('t0092d')||md5('x'));

  CREATE TEMP TABLE f4b_ctx AS SELECT v_eid AS entregador_id, v_seg AS semana;
  RAISE NOTICE 'fixture: entregador=% semana=%', v_eid, v_seg;
END $$;

-- Retrato ANTES: o que o repasse (não congelado) diz desta semana. O
-- fechamento não pode mudar esses números.
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
CREATE TEMP TABLE f4b_repasse_antes AS
  SELECT r.entregador_id, r.creditos, r.adiantamentos, r.debitos, r.remanescente
  FROM f4b_ctx c, hub_adiantamento_repasse(c.semana, NULL, false, 0, 5000) r;
