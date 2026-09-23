-- Teste da 0088 (família de categoria no REPASSE). Roda DENTRO de uma
-- transação que termina em ROLLBACK — ver o driver
-- infra/hub/testes/hub-repasse-categoria-familia.sh. Dados sintéticos.
\set ON_ERROR_STOP on

-- 1. Estrutural: as TRÊS funções (nas versões mais recentes) passaram a usar a
--    regra de família. Pega quem editou a versão errada da função.
DO $$
DECLARE r record; v_ruins int := 0;
BEGIN
  FOR r IN
    SELECT p.proname,
           p.prosrc LIKE '%hub_adiantamento_categoria_casa(f.descricao, COALESCE(v_config.categorias_extrato%' AS usa_familia,
           p.prosrc LIKE '%f.descricao = ANY (COALESCE(v_config.categorias_extrato%' AS usa_nome_exato
    FROM pg_proc p
    WHERE p.proname IN ('hub_adiantamento_repasse','hub_adiantamento_repasse_fechar','hub_adiantamento_repasse_motorista')
  LOOP
    IF NOT r.usa_familia OR r.usa_nome_exato THEN
      v_ruins := v_ruins + 1;
      RAISE WARNING '%: usa_familia=% usa_nome_exato=%', r.proname, r.usa_familia, r.usa_nome_exato;
    END IF;
  END LOOP;
  IF v_ruins > 0 THEN RAISE EXCEPTION 'FALHOU: % funcao(oes) de repasse fora da regra de familia', v_ruins; END IF;
  RAISE NOTICE 'ok  estrutura: as 3 funcoes de repasse usam categoria_casa';
END $$;

-- 2. Comportamental: o repasse do hub soma a campanha NOVA pela família, e o
--    valor vem da coluna `valor` de FaturamentoLancamento (decisão 9).
DO $$
DECLARE
  v_eid int; v_seg date; v_imp int; v_ver int;
  v_creditos numeric; v_remanescente numeric;
BEGIN
  -- Semana de apuração que começa numa SEGUNDA, no passado (sem colidir com dados reais).
  v_seg := date '2026-03-02';  -- segunda-feira
  SELECT id INTO v_imp FROM "ImportacaoArquivo" WHERE id_empresa = 9001 AND tipo = 'faturamento'
     AND status NOT IN ('pending','validating','processing') ORDER BY id DESC LIMIT 1;
  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (9001, gen_random_uuid(), 'Repasse Familia Teste')
    RETURNING id INTO v_eid;

  INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
  VALUES
    (9001, v_imp, v_eid, v_seg + 1, v_seg + 1, 'Credito', 100.00, 'Corridas concluidas',            md5('t0088a')||md5('x')),
    (9001, v_imp, v_eid, v_seg + 2, v_seg + 2, 'Credito',  30.00, 'Promocao - Campanha w99 NOVA',   md5('t0088b')||md5('x')),
    (9001, v_imp, v_eid, v_seg + 3, v_seg + 3, 'Credito',  20.00, 'Gorjeta',                        md5('t0088c')||md5('x')),
    (9001, v_imp, v_eid, v_seg + 4, v_seg + 4, 'Credito',  50.00, 'Categoria fora do extrato',      md5('t0088d')||md5('x'));

  -- Config vigente NOVA para a empresa 6 (as funções leem config_vigente(6)),
  -- com o extrato usando o TOKEN de família + um nome exato.
  SELECT max(versao) + 1 INTO v_ver FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6;
  INSERT INTO "AdiantamentoConfiguracao" (
      id_empresa, versao, vigente_desde, timezone, dias_habilitados, horario_abertura, horario_corte,
      percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto,
      descricao_pix_modelo, apuracao_dia_inicio, apuracao_dias_ate_repasse, apuracao_data_base,
      categorias_extrato, desconto_adiantamentos, desconto_debitos, repasse_visivel_app)
  SELECT 6, v_ver, now(), timezone, dias_habilitados, horario_abertura, horario_corte,
      percentual, taxa_fixa, 'financeiro_lancamento', ARRAY['Corridas concluidas'], previsao_pagamento_texto,
      descricao_pix_modelo, 1, 3, 'data_lancamento',
      ARRAY['familia:promocao','Corridas concluidas','Gorjeta'], true, true, true
  FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6 ORDER BY versao DESC LIMIT 1;

  PERFORM set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"9001","escopo":[9001]}', true);
  SELECT creditos, remanescente INTO v_creditos, v_remanescente
  FROM hub_adiantamento_repasse(v_seg, NULL, false, 0, 50) WHERE entregador_id = v_eid;

  -- 100 (nome exato) + 30 (campanha NOVA, pela família) + 20 (nome exato).
  -- Fora: 50 da categoria que não está no extrato.
  ASSERT v_creditos = 150.00, format('creditos esperados 150.00, veio %s', v_creditos);
  ASSERT v_remanescente = 150.00, format('remanescente esperado 150.00 (sem adiantamento/debito), veio %s', v_remanescente);
  RAISE NOTICE 'ok  repasse do hub: creditos=% (a campanha nova entrou pela familia; a fora do extrato ficou de fora)', v_creditos;
END $$;
