-- Teste da 0087 (famílias de categoria). Rodar DENTRO de uma transação que
-- termina em ROLLBACK, depois da migration — ver o driver
-- infra/hub/testes/hub-adiantamento-categoria-familia.sh. Dados sintéticos
-- (repo público): empresa 9001, importação 30 do hub-homolog.
\set ON_ERROR_STOP on

CREATE TEMP TABLE _casos (descricao text, esperado text);
INSERT INTO _casos VALUES
  ('Promocao - Destravou_Ganhou Elite w96 Franquias', 'familia:promocao'),
  ('Promo' || chr(231) || chr(227) || 'o - Corre' || chr(231) || chr(245) || 'es Gerais (Live Team)', 'familia:promocao'),  -- Promoção - Correções
  ('Promo' || chr(65533) || chr(65533) || 'o - Corre' || chr(65533) || chr(65533) || 'es Gerais', 'familia:promocao'),  -- como chega em produção
  ('PROMO' || chr(199) || chr(195) || 'O - CAMPANHA', 'familia:promocao'),                                               -- PROMOÇÃO maiúsculo
  ('Promocao-SemEspaco', 'familia:promocao'),
  ('Promocao entregador', NULL),        -- decisão do operador: fica SEPARADA
  ('PROMOTION_WITH_LOYALTY', NULL),
  ('Promocional qualquer', NULL),
  ('MISSOES DE AGOSTO FRANQUIA ELITE', 'familia:missoes'),
  ('Miss' || chr(245) || 'es de Setembro', 'familia:missoes'),
  ('MISSOESX', NULL),                   -- palavra inteira
  ('Corridas concluidas', NULL),
  ('Valor por Hora Online', NULL);

DO $$
DECLARE r record; v_ruins int := 0;
BEGIN
  FOR r IN SELECT c.*, hub_adiantamento_categoria_familia(c.descricao) AS obtido FROM _casos c LOOP
    IF r.obtido IS DISTINCT FROM r.esperado THEN
      v_ruins := v_ruins + 1;
      RAISE WARNING 'familia(%) = % , esperado %', r.descricao, r.obtido, r.esperado;
    END IF;
  END LOOP;
  IF v_ruins > 0 THEN RAISE EXCEPTION 'FALHOU: % caso(s) de familia()', v_ruins; END IF;
  RAISE NOTICE 'ok  familia(): % casos', (SELECT count(*) FROM _casos);
END $$;

DO $$
BEGIN
  ASSERT hub_adiantamento_categoria_casa('Gorjeta', ARRAY['Gorjeta']),                            'nome exato tem que casar';
  ASSERT NOT hub_adiantamento_categoria_casa('Gorjeta', ARRAY['familia:promocao']),               'Gorjeta não é Promoção';
  ASSERT hub_adiantamento_categoria_casa('Promocao - w98 nova', ARRAY['familia:promocao']),       'campanha FUTURA tem que casar pela família';
  ASSERT NOT hub_adiantamento_categoria_casa('Promocao entregador', ARRAY['familia:promocao']),   'Promocao entregador não é da família';
  ASSERT NOT hub_adiantamento_categoria_casa('Promocao - w98', ARRAY['Promocao - w97']),          'sem token, continua exato como antes';
  ASSERT NOT hub_adiantamento_categoria_casa('X', NULL),                                          'config nula -> false, não NULL';
  RAISE NOTICE 'ok  casa(): 6 casos';
END $$;

-- Cálculo de ponta a ponta: um entregador, um dia, 5 lançamentos.
DO $$
DECLARE
  v_eid int; v_dia date := (now() AT TIME ZONE 'America/Sao_Paulo')::date - 1;
  v_cfg "AdiantamentoConfiguracao"; v_prod record;
BEGIN
  INSERT INTO "Entregador" (id_empresa, id_externo) VALUES (9001, gen_random_uuid()) RETURNING id INTO v_eid;
  INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
  VALUES
    (9001, 30, v_eid, v_dia, v_dia, 'Credito', 10.00, 'Promocao - Campanha w97', md5('t0087a') || md5('x')),
    (9001, 30, v_eid, v_dia, v_dia, 'Credito', 20.00, 'Promocao - Campanha w98 NOVA', md5('t0087b') || md5('x')),
    (9001, 30, v_eid, v_dia, v_dia, 'Credito', 40.00, 'Promocao entregador', md5('t0087c') || md5('x')),
    (9001, 30, v_eid, v_dia, v_dia, 'Credito',  5.00, 'Gorjeta', md5('t0087d') || md5('x')),
    (9001, 30, v_eid, v_dia, v_dia, 'Debito',  99.00, 'Promocao - Estorno', md5('t0087e') || md5('x'));

  SELECT (jsonb_populate_record(NULL::"AdiantamentoConfiguracao", to_jsonb(c) || jsonb_build_object(
           'id_empresa', 9001, 'fonte_producao', 'financeiro_referencia',
           'categorias_producao', ARRAY['familia:promocao', 'Gorjeta']))).*
    INTO v_cfg FROM "AdiantamentoConfiguracao" c WHERE c.id_empresa = 6 AND c.versao = 1;

  SELECT * INTO v_prod FROM hub_adiantamento_producao(v_eid, v_dia, v_cfg);
  -- 10 + 20 (as duas promoções, inclusive a "nova") + 5 (Gorjeta).
  -- Fora: Promocao entregador (40, não marcada) e o Débito (99).
  ASSERT v_prod.disponivel, 'produção deveria estar disponível';
  ASSERT v_prod.valor = 35.00, format('valor esperado 35.00, veio %s', v_prod.valor);
  ASSERT v_prod.lancamentos = 3, format('lançamentos esperados 3, vieram %s', v_prod.lancamentos);
  ASSERT v_prod.por_categoria ? 'Promocao - Campanha w98 NOVA', 'a campanha nova tem que aparecer no detalhamento';
  RAISE NOTICE 'ok  producao(): valor=% lancamentos=% (família pegou a campanha nova, excluiu Promocao entregador e o débito)', v_prod.valor, v_prod.lancamentos;
END $$;

-- RPC da tela: família preenchida e categoria SEM motorista escondida.
DO $$
DECLARE v_dia date := (now() AT TIME ZONE 'America/Sao_Paulo')::date - 1; v_n int; v_fam text;
BEGIN
  INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
  VALUES (9001, 30, NULL, v_dia, v_dia, 'Credito', 1.00, 'Percentual atingido de teste 0087', md5('t0087f') || md5('x'));

  PERFORM set_config('request.jwt.claims', '{"sub":"328","empresa_ativa":9001,"escopo":[9001]}', true);

  SELECT count(*) INTO v_n FROM hub_adiantamento_categorias() WHERE descricao = 'Percentual atingido de teste 0087';
  ASSERT v_n = 0, 'categoria só com lançamento SEM motorista tinha que sumir';

  SELECT familia INTO v_fam FROM hub_adiantamento_categorias() WHERE descricao = 'Promocao - Campanha w98 NOVA';
  ASSERT v_fam = 'familia:promocao', format('familia esperada familia:promocao, veio %s', v_fam);

  SELECT familia INTO v_fam FROM hub_adiantamento_categorias() WHERE descricao = 'Gorjeta';
  ASSERT v_fam IS NULL, 'Gorjeta é avulsa';
  RAISE NOTICE 'ok  categorias(): sem-motorista escondida, família preenchida';
END $$;
