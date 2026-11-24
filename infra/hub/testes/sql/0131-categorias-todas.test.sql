-- Teste da 0131 (modo "Todas, exceto as marcadas" + familia Indicadores). Roda numa transacao que termina em
-- ROLLBACK, DEPOIS de todas as migrations (driver: infra/hub/testes/hub-categorias-todas.sh). Dados sinteticos
-- (empresa 6). Nao aborta no primeiro erro: cada verificacao imprime PASS/FAIL (o driver conta).
CREATE OR REPLACE FUNCTION pg_temp.chk(p_nome text, p_ok boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE(p_ok, false) THEN RAISE NOTICE 'PASS: %', p_nome; ELSE RAISE NOTICE 'FAIL: %', p_nome; END IF;
END $$;

-- ═════════ 1. familia() ═════════
DO $$
BEGIN
  PERFORM pg_temp.chk('familia: "Percentual atingido de rotas completas" -> indicador',
    hub_adiantamento_categoria_familia('Percentual atingido de rotas completas') = 'familia:indicador');
  PERFORM pg_temp.chk('familia: caixa alta -> indicador',
    hub_adiantamento_categoria_familia('PERCENTUAL ATINGIDO de hora online') = 'familia:indicador');
  PERFORM pg_temp.chk('familia: "Percentual" sozinho NAO e indicador', hub_adiantamento_categoria_familia('Percentual de x') IS NULL);
  PERFORM pg_temp.chk('familia: "Meu percentual atingido" (nao comeca) NAO e indicador', hub_adiantamento_categoria_familia('Meu percentual atingido') IS NULL);
  PERFORM pg_temp.chk('familia: promocao intacta', hub_adiantamento_categoria_familia('Promocao - W98') = 'familia:promocao');
  PERFORM pg_temp.chk('familia: promocao U+FFFD intacta', hub_adiantamento_categoria_familia('Promo' || chr(65533) || chr(65533) || 'o - X') = 'familia:promocao');
  PERFORM pg_temp.chk('familia: missoes intacta', hub_adiantamento_categoria_familia('MISSOES DE JUNHO') = 'familia:missoes');
  PERFORM pg_temp.chk('familia: "Promocao entregador" segue avulsa', hub_adiantamento_categoria_familia('Promocao entregador') IS NULL);
  PERFORM pg_temp.chk('familias(): fonte unica = promocao, missoes, indicador',
    hub_adiantamento_familias() = ARRAY['familia:promocao','familia:missoes','familia:indicador']::text[]);
END $$;

-- ═════════ 2. casa(): tabela de casos ═════════
CREATE TEMP TABLE _desc (d text);
INSERT INTO _desc VALUES ('Gorjeta'), ('Corridas concluidas'), ('Promocao - W1'), ('MISSOES DE JUNHO'),
  ('Percentual atingido de rotas'), ('percentual ATINGIDO de hora online'), ('Categoria Nova Z'), ('Promocao entregador'), (NULL);
-- (lista, descricao, esperado); lista_id so rotula
CREATE TEMP TABLE _casos (lista text[], d text, esp boolean, rotulo text);
INSERT INTO _casos VALUES
  -- modo marcadas (como hoje)
  (ARRAY['Gorjeta'], 'Gorjeta', true, 'marcadas/nome'),
  (ARRAY['Gorjeta'], 'Corridas concluidas', false, 'marcadas/nome'),
  (ARRAY['Gorjeta'], 'Categoria Nova Z', false, 'marcadas/nova nao entra'),
  (ARRAY['familia:promocao'], 'Promocao - W1', true, 'marcadas/familia'),
  (ARRAY['familia:promocao'], 'Promocao entregador', false, 'marcadas/familia nao pega avulsa'),
  (ARRAY['familia:promocao'], 'Gorjeta', false, 'marcadas/familia'),
  (ARRAY['familia:missoes'], 'MISSOES DE JUNHO', true, 'marcadas/familia missoes'),
  (ARRAY['familia:indicador'], 'Percentual atingido de rotas', true, 'marcadas/familia indicador'),
  (ARRAY['familia:indicador'], 'percentual ATINGIDO de hora online', true, 'marcadas/familia indicador (caixa)'),
  (ARRAY['familia:indicador'], 'Corridas concluidas', false, 'marcadas/familia indicador'),
  (ARRAY['Corridas concluidas','familia:promocao'], 'Promocao - W1', true, 'marcadas/nome+familia'),
  (ARRAY['Corridas concluidas','familia:promocao'], 'Corridas concluidas', true, 'marcadas/nome+familia'),
  (ARRAY['Corridas concluidas','familia:promocao'], 'Categoria Nova Z', false, 'marcadas/nome+familia'),
  (NULL, 'Gorjeta', false, 'lista NULL'),
  (NULL, NULL, false, 'lista NULL, descricao NULL'),
  (ARRAY[]::text[], 'Gorjeta', false, 'lista vazia'),
  (ARRAY['Gorjeta'], NULL, false, 'descricao NULL'),
  -- modo todas
  (ARRAY['modo:todas'], 'Gorjeta', true, 'todas/so o token'),
  (ARRAY['modo:todas'], 'Corridas concluidas', true, 'todas/so o token'),
  (ARRAY['modo:todas'], 'Categoria Nova Z', true, 'todas/categoria nova entra'),
  (ARRAY['modo:todas'], 'Percentual atingido de rotas', true, 'todas/so o token: indicador ENTRA (sem a familia nas excecoes)'),
  (ARRAY['modo:todas'], 'Promocao - W1', true, 'todas/so o token'),
  (ARRAY['modo:todas'], NULL, false, 'todas/descricao NULL'),
  (ARRAY['modo:todas','familia:indicador'], 'Percentual atingido de rotas', false, 'todas-exceto indicador'),
  (ARRAY['modo:todas','familia:indicador'], 'percentual ATINGIDO de hora online', false, 'todas-exceto indicador (caixa)'),
  (ARRAY['modo:todas','familia:indicador'], 'Gorjeta', true, 'todas-exceto indicador'),
  (ARRAY['modo:todas','familia:indicador'], 'Categoria Nova Z', true, 'todas-exceto indicador: nova entra'),
  (ARRAY['modo:todas','familia:indicador'], 'Promocao - W1', true, 'todas-exceto indicador'),
  (ARRAY['modo:todas','familia:indicador','Gorjeta'], 'Gorjeta', false, 'todas-exceto indicador+nome'),
  (ARRAY['modo:todas','familia:indicador','Gorjeta'], 'Percentual atingido de rotas', false, 'todas-exceto indicador+nome'),
  (ARRAY['modo:todas','familia:indicador','Gorjeta'], 'Corridas concluidas', true, 'todas-exceto indicador+nome'),
  (ARRAY['modo:todas','familia:promocao'], 'Promocao - W1', false, 'todas-exceto promocao'),
  (ARRAY['modo:todas','familia:promocao'], 'Promocao entregador', true, 'todas-exceto promocao: avulsa entra'),
  (ARRAY['modo:todas','familia:missoes'], 'MISSOES DE JUNHO', false, 'todas-exceto missoes'),
  (ARRAY['modo:todas','Corridas concluidas'], 'Corridas concluidas', false, 'todas-exceto nome'),
  (ARRAY['modo:todas','Corridas concluidas'], 'Gorjeta', true, 'todas-exceto nome'),
  (ARRAY['modo:todas','modo:todas'], 'Gorjeta', true, 'todas duplicado (nao e caso real; so nao quebra)'),
  (ARRAY['modo:todas'], 'modo:todas', false, 'todas/descricao igual ao token (nao e caso real; so nao quebra)');
DO $$
DECLARE r record; v_ruins int := 0; v_obt boolean;
BEGIN
  FOR r IN SELECT * FROM _casos LOOP
    v_obt := hub_adiantamento_categoria_casa(r.d, r.lista);
    IF v_obt IS DISTINCT FROM r.esp THEN v_ruins := v_ruins + 1; RAISE NOTICE 'casa(%, %) = %, esperado % [%]', r.d, r.lista, v_obt, r.esp, r.rotulo; END IF;
  END LOOP;
  PERFORM pg_temp.chk(format('casa(): tabela de %s casos (modo x nome x familia x NULL/vazio)', (SELECT count(*) FROM _casos)), v_ruins = 0);
  PERFORM pg_temp.chk('casa(): nunca devolve NULL (so true/false) em todo o produto descricoes x listas',
    NOT EXISTS (SELECT 1 FROM _desc, (SELECT DISTINCT lista FROM _casos) l WHERE hub_adiantamento_categoria_casa(d, lista) IS NULL));
END $$;

-- Regressao: SEM o token de modo, casa() == regra da 0087 (nome exato OU familia) para TODA lista x descricao.
DO $$
DECLARE v_n int; v_dif int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE hub_adiantamento_categoria_casa(d, lista)
      IS DISTINCT FROM COALESCE(d = ANY (lista) OR hub_adiantamento_categoria_familia(d) = ANY (lista), false))
  INTO v_n, v_dif
  FROM _desc, (SELECT DISTINCT lista FROM _casos WHERE lista IS NULL OR NOT ('modo:todas' = ANY (lista))) l;
  PERFORM pg_temp.chk(format('regressao: listas sem modo dao o MESMO resultado da regra 0087 (%s combinacoes)', v_n), v_dif = 0 AND v_n > 0);
END $$;

-- inlinavel (LANGUAGE sql IMMUTABLE): o plano nao chama a funcao
DO $$
DECLARE v_linha text; v_plano text := '';
BEGIN
  PERFORM pg_temp.chk('casa(): LANGUAGE sql IMMUTABLE',
    (SELECT p.provolatile = 'i' AND l.lanname = 'sql' FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = 'hub_adiantamento_categoria_casa(text,text[])'::regprocedure));
  FOR v_linha IN EXECUTE 'EXPLAIN (VERBOSE, COSTS OFF) SELECT d FROM _desc WHERE hub_adiantamento_categoria_casa(d, ARRAY[''modo:todas'',''Gorjeta''])' LOOP
    v_plano := v_plano || v_linha || E'\n';
  END LOOP;
  PERFORM pg_temp.chk('casa(): inlinada no plano (a chamada da funcao some do EXPLAIN)', v_plano NOT LIKE '%hub_adiantamento_categoria_casa%');
END $$;

-- ═════════ 3. tokens_ok() e CHECKs ═════════
DO $$
BEGIN
  PERFORM pg_temp.chk('tokens_ok: NULL ok', hub_adiantamento_categorias_tokens_ok(NULL));
  PERFORM pg_temp.chk('tokens_ok: so nomes ok', hub_adiantamento_categorias_tokens_ok(ARRAY['Gorjeta','Corridas']));
  PERFORM pg_temp.chk('tokens_ok: modo:todas + familias ok', hub_adiantamento_categorias_tokens_ok(ARRAY['modo:todas','familia:indicador','familia:promocao','familia:missoes','X']));
  PERFORM pg_temp.chk('tokens_ok: modo:outro recusado', NOT hub_adiantamento_categorias_tokens_ok(ARRAY['modo:outro']));
  PERFORM pg_temp.chk('tokens_ok: 2x modo:todas recusado', NOT hub_adiantamento_categorias_tokens_ok(ARRAY['modo:todas','modo:todas']));
  PERFORM pg_temp.chk('tokens_ok: familia:xyz recusada', NOT hub_adiantamento_categorias_tokens_ok(ARRAY['familia:xyz']));
  PERFORM pg_temp.chk('tokens_ok: elemento NULL recusado', NOT hub_adiantamento_categorias_tokens_ok(ARRAY['A', NULL]));
  PERFORM pg_temp.chk('3 CHECKs de tokens existem nas 3 listas',
    (SELECT count(*) FROM pg_constraint WHERE conname IN ('adiantamentoconfiguracao_categorias_producao_tokens_chk',
       'adiantamentoconfiguracao_categorias_extrato_tokens_chk','adiantamentoconfiguracao_categorias_nota_tokens_chk')) = 3);
END $$;

-- ═════════ 4. Fixture: empresa 6, 1 entregador, 1 dia ═════════
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status) VALUES (6, 'faturamento', repeat('7',64), 'completed');
INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('77777777000177', 'Todas Teste');
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id)
  VALUES (6, gen_random_uuid(), 'Todas Teste', (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador = '77777777000177'));
CREATE TEMP TABLE _ctx AS SELECT (SELECT id FROM "Entregador" WHERE nome = 'Todas Teste') AS eid, DATE '2026-06-10' AS dia,
  (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256 = repeat('7',64)) AS imp;
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
SELECT 6, c.imp, c.eid, c.dia, c.dia, v.tipo, v.valor, v.descr, md5(v.descr || v.tipo) || md5(v.tipo || v.descr)
FROM _ctx c, (VALUES ('Credito', 100, 'Corridas concluidas'), ('Credito', 7, 'Gorjeta'), ('Credito', 20, 'Promocao - W1 x'),
                     ('Credito', 30, 'MISSOES DE JUNHO'), ('Credito', 400, 'Percentual atingido de rotas completas'),
                     ('Debito', 50, 'Debito qualquer')) v(tipo, valor, descr);

INSERT INTO "ContaBancariaMotorista" (id_empresa, entregador_id, origem, status, titular_nome, titular_documento, titular_tipo, banco_codigo, banco_nome, agencia, conta, conta_digito, tipo_conta, entregador_confirmado_id, revisada_em)
  SELECT 6, eid, 'CARGA_INICIAL', 'APROVADA', 'Todas Teste', '12345678901', 'PF', '001', 'Banco do Brasil', '1234', '00012345', '6', 'CORRENTE', eid, now() FROM _ctx;
-- usuario com adiantamentos.configurar na empresa 6 (papel financeiro_aprovador)
INSERT INTO "Usuario" (email, senha_hash, nome) VALUES ('todas.teste@example.com', 'x', 'Todas Teste');
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo)
  VALUES ((SELECT id FROM "Usuario" WHERE email = 'todas.teste@example.com'), 6, (SELECT id FROM "Papel" WHERE nome = 'financeiro_aprovador'), true);
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', (SELECT id FROM "Usuario" WHERE email = 'todas.teste@example.com'),
                  'empresa_ativa', '6', 'escopo', '[6]'::jsonb)::text, false);

-- salva uma versao pela RPC (vigente_desde crescente: now() e fixo dentro da transacao)
CREATE TEMP SEQUENCE _vig START 1;
CREATE OR REPLACE FUNCTION pg_temp.salvar(p_dados jsonb) RETURNS "AdiantamentoConfiguracao" LANGUAGE sql AS $$
  SELECT hub_adiantamento_configuracao_salvar(
    (SELECT max(versao) FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6),
    jsonb_build_object('vigenteDesde', (now() - (1000 - nextval('_vig')) * interval '1 microsecond'),
                       'fonteProducao', 'financeiro_lancamento', 'apuracaoDataBase', 'data_lancamento', 'apuracaoDiaInicio', 1,
                       'apuracaoDiasAteRepasse', 3)
    || p_dados);
$$;

-- ═════════ 5. Salvar: validacao dos tokens ═════════
DO $$
DECLARE v_err text; v "AdiantamentoConfiguracao";
BEGIN
  FOREACH v_err IN ARRAY ARRAY['{"categoriasProducao":["modo:outro"]}', '{"categoriasExtrato":["familia:xyz"]}',
                               '{"categoriasNota":["modo:todas","modo:todas"]}', '{"categoriasProducao":"modo:todas"}',
                               '{"categoriasExtrato":["modo:todas","modo:foo"]}'] LOOP
    BEGIN
      v := pg_temp.salvar(v_err::jsonb);
      PERFORM pg_temp.chk('salvar recusa ' || v_err, false);
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_temp.chk('salvar recusa ' || v_err || ' (DADOS_INVALIDOS_CATEGORIAS)', SQLERRM = 'DADOS_INVALIDOS_CATEGORIAS');
    END;
  END LOOP;
  PERFORM pg_temp.chk('salvar recusado nao gravou versao nova', (SELECT max(versao) FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6) = 1);

  -- config valida em modo todas nas 3 listas guarda o token
  v := pg_temp.salvar('{"categoriasProducao":["modo:todas","familia:indicador","Gorjeta"],"categoriasExtrato":["modo:todas","familia:indicador"],"categoriasNota":["Corridas concluidas"]}'::jsonb);
  PERFORM pg_temp.chk('salvar aceita modo:todas + familia:indicador + nome e guarda os tokens',
    v.categorias_producao = ARRAY['modo:todas','familia:indicador','Gorjeta'] AND v.categorias_extrato = ARRAY['modo:todas','familia:indicador']
    AND v.categorias_nota = ARRAY['Corridas concluidas']);
  -- campos omitidos sao herdados (a validacao nao quebra o COALESCE)
  v := pg_temp.salvar('{"percentual":50}'::jsonb);
  PERFORM pg_temp.chk('salvar sem categorias herda as listas (inclusive o token de modo)', v.categorias_producao = ARRAY['modo:todas','familia:indicador','Gorjeta']);
END $$;

-- CHECK direto no banco (fora da RPC)
CREATE OR REPLACE FUNCTION pg_temp.insere_com(p_over jsonb) RETURNS void LANGUAGE sql AS $$
  INSERT INTO "AdiantamentoConfiguracao"
  SELECT (jsonb_populate_record(NULL::"AdiantamentoConfiguracao",
            to_jsonb(c) || jsonb_build_object('id', nextval(pg_get_serial_sequence('"AdiantamentoConfiguracao"', 'id')), 'versao', c.versao + 1000) || p_over)).*
  FROM "AdiantamentoConfiguracao" c WHERE c.id_empresa = 6 ORDER BY c.versao DESC LIMIT 1;
$$;
DO $$
DECLARE v_col text;
BEGIN
  FOREACH v_col IN ARRAY ARRAY['categorias_producao','categorias_extrato','categorias_nota'] LOOP
    BEGIN
      PERFORM pg_temp.insere_com(jsonb_build_object(v_col, ARRAY['modo:outro']));
      PERFORM pg_temp.chk('CHECK recusa modo:outro em ' || v_col, false);
    EXCEPTION WHEN check_violation THEN
      PERFORM pg_temp.chk('CHECK recusa modo:outro em ' || v_col, SQLERRM LIKE '%' || v_col || '_tokens_chk%');
    END;
  END LOOP;
  BEGIN
    PERFORM pg_temp.insere_com('{"categorias_extrato":["familia:xyz"]}'::jsonb);
    PERFORM pg_temp.chk('CHECK recusa familia:xyz', false);
  EXCEPTION WHEN check_violation THEN PERFORM pg_temp.chk('CHECK recusa familia:xyz', true); END;
  BEGIN
    PERFORM pg_temp.insere_com('{"categorias_nota":["modo:todas","modo:todas"]}'::jsonb);
    PERFORM pg_temp.chk('CHECK recusa 2x modo:todas', false);
  EXCEPTION WHEN check_violation THEN PERFORM pg_temp.chk('CHECK recusa 2x modo:todas', true); END;
  BEGIN
    PERFORM pg_temp.insere_com('{"categorias_producao":["modo:todas","familia:indicador"]}'::jsonb);
    PERFORM pg_temp.chk('CHECK aceita lista valida em modo todas', true);
  EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.chk('CHECK aceita lista valida em modo todas (' || SQLERRM || ')', false); END;
END $$;
DELETE FROM "AdiantamentoConfiguracao" WHERE versao >= 1000;

-- ═════════ 6. Producao do adiantamento (config em modo todas) ═════════
-- config vigente atual: producao = todas EXCETO indicador e Gorjeta. A categoria NOVA entra DEPOIS de salvar.
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
SELECT 6, c.imp, c.eid, c.dia, c.dia, 'Credito', 5, 'Categoria Nova Z', md5('nova') || md5('nova2') FROM _ctx c;
DO $$
DECLARE
  c _ctx; cfg "AdiantamentoConfiguracao"; r record;
BEGIN
  SELECT * INTO c FROM _ctx;
  SELECT * INTO cfg FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6 ORDER BY versao DESC LIMIT 1;
  SELECT * INTO r FROM hub_adiantamento_producao(c.eid, c.dia, cfg);
  PERFORM pg_temp.chk('producao modo todas (exceto indicador+Gorjeta): 100+20+30+5 (categoria nova entra) = 155,00', r.disponivel AND r.valor = 155.00);
  PERFORM pg_temp.chk('producao modo todas: indicador fora do por_categoria', NOT (r.por_categoria ? 'Percentual atingido de rotas completas'));
  PERFORM pg_temp.chk('producao modo todas: Gorjeta (excecao por nome) fora', NOT (r.por_categoria ? 'Gorjeta'));
  PERFORM pg_temp.chk('producao modo todas: categoria nova presente no por_categoria', r.por_categoria ? 'Categoria Nova Z');
  PERFORM pg_temp.chk('producao modo todas: 4 lancamentos', r.lancamentos = 4);
  PERFORM pg_temp.chk('producao: debito nunca entra', NOT (r.por_categoria ? 'Debito qualquer'));

  cfg.categorias_producao := ARRAY['modo:todas'];
  SELECT * INTO r FROM hub_adiantamento_producao(c.eid, c.dia, cfg);
  PERFORM pg_temp.chk('producao so ["modo:todas"]: tudo entra, indicador inclusive = 562,00', r.valor = 562.00);

  cfg.categorias_producao := ARRAY['Corridas concluidas','familia:promocao'];
  SELECT * INTO r FROM hub_adiantamento_producao(c.eid, c.dia, cfg);
  PERFORM pg_temp.chk('regressao: lista so de nomes+familia da o valor de antes (100+20=120,00; nova fora)', r.valor = 120.00);
  cfg.categorias_producao := ARRAY['Corridas concluidas','Gorjeta'];
  SELECT * INTO r FROM hub_adiantamento_producao(c.eid, c.dia, cfg);
  PERFORM pg_temp.chk('regressao: lista so de nomes = 107,00', r.valor = 107.00);
  cfg.categorias_producao := ARRAY['familia:indicador'];
  SELECT * INTO r FROM hub_adiantamento_producao(c.eid, c.dia, cfg);
  PERFORM pg_temp.chk('modo marcadas + familia:indicador soma so o indicador = 400,00', r.valor = 400.00);
END $$;

-- snapshot: recalcular grava as categorias (com o token) e o valor na solicitacao
INSERT INTO "AdiantamentoSolicitacao" (id, id_empresa, conta_motorista_id, cnpj_prestador, entregador_id, configuracao_id,
    data_solicitacao, data_producao, aceite_texto_sha256, status, chave_idempotencia)
SELECT 8131, 6, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador = '77777777000177'), '77777777000177', c.eid,
       (SELECT id FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6 ORDER BY versao DESC LIMIT 1),
       c.dia + 1, c.dia, repeat('a',64), 'AGUARDANDO_PRODUCAO', gen_random_uuid()
FROM _ctx c;
SELECT id, status FROM hub_adiantamento_recalcular(8131);
DO $$
DECLARE s "AdiantamentoSolicitacao";
BEGIN
  SELECT * INTO s FROM "AdiantamentoSolicitacao" WHERE id = 8131;
  PERFORM pg_temp.chk('snapshot: a solicitacao guarda os tokens da lista que calculou', s.categorias_producao = ARRAY['modo:todas','familia:indicador','Gorjeta']);
  PERFORM pg_temp.chk('snapshot: valor calculado em modo todas = 155,00', s.producao_valor = 155.00);
END $$;

-- ═════════ 7. Repasse (previa): extrato x nota em modos diferentes ═════════
-- A: extrato = todas exceto indicador (credito = 100+7+20+30+5 = 162) | nota = marcadas [Corridas concluidas] (100)
SELECT (pg_temp.salvar('{"categoriasExtrato":["modo:todas","familia:indicador"],"categoriasNota":["Corridas concluidas"]}'::jsonb)).versao;
DO $$
DECLARE r record; c _ctx;
BEGIN
  SELECT * INTO c FROM _ctx;
  SET LOCAL ROLE authenticated;
  SELECT creditos, valor_nota, valor_fora_nota INTO r FROM hub_adiantamento_repasse(c.dia, NULL, false, 0, 1000) WHERE entregador_id = c.eid;
  RESET ROLE;
  PERFORM pg_temp.chk('repasse A: extrato todas-exceto-indicador = 162,00', r.creditos = 162.00);
  PERFORM pg_temp.chk('repasse A: nota marcadas = 100,00 e fora da nota = 62,00', r.valor_nota = 100.00 AND r.valor_fora_nota = 62.00);
  PERFORM pg_temp.chk('repasse A: nota + fora = extrato (nota dentro do extrato)', r.valor_nota + r.valor_fora_nota = r.creditos);
END $$;
-- B: extrato = marcadas [Corridas concluidas, familia:promocao, Gorjeta] (127) | nota = todas exceto Gorjeta (dentro do extrato: 120)
SELECT (pg_temp.salvar('{"categoriasExtrato":["Corridas concluidas","familia:promocao","Gorjeta"],"categoriasNota":["modo:todas","Gorjeta"]}'::jsonb)).versao;
DO $$
DECLARE r record; c _ctx;
BEGIN
  SELECT * INTO c FROM _ctx;
  SET LOCAL ROLE authenticated;
  SELECT creditos, valor_nota, valor_fora_nota INTO r FROM hub_adiantamento_repasse(c.dia, NULL, false, 0, 1000) WHERE entregador_id = c.eid;
  RESET ROLE;
  PERFORM pg_temp.chk('repasse B: extrato marcadas = 127,00 (categoria nova e missoes ficam fora)', r.creditos = 127.00);
  PERFORM pg_temp.chk('repasse B: nota todas-exceto-Gorjeta = 120,00 e fora da nota = 7,00', r.valor_nota = 120.00 AND r.valor_fora_nota = 7.00);
  PERFORM pg_temp.chk('repasse B: nota (modo todas) continua DENTRO do extrato (nota + fora = extrato)', r.valor_nota + r.valor_fora_nota = r.creditos);
END $$;
-- C: os dois em modo todas: extrato todas-exceto-indicador (162) | nota todas-exceto-promocao (162-20 = 142)
SELECT (pg_temp.salvar('{"categoriasExtrato":["modo:todas","familia:indicador"],"categoriasNota":["modo:todas","familia:promocao"]}'::jsonb)).versao;
DO $$
DECLARE r record; c _ctx;
BEGIN
  SELECT * INTO c FROM _ctx;
  SET LOCAL ROLE authenticated;
  SELECT creditos, valor_nota, valor_fora_nota INTO r FROM hub_adiantamento_repasse(c.dia, NULL, false, 0, 1000) WHERE entregador_id = c.eid;
  RESET ROLE;
  PERFORM pg_temp.chk('repasse C: extrato 162,00 | nota 142,00 | fora 20,00 (nota ⊂ extrato mesmo com indicador fora do extrato)',
    r.creditos = 162.00 AND r.valor_nota = 142.00 AND r.valor_fora_nota = 20.00);
END $$;
-- D: nota com indicador marcado como "entra" mas indicador fora do extrato: nao soma (nota ⊂ extrato)
SELECT (pg_temp.salvar('{"categoriasExtrato":["modo:todas","familia:indicador"],"categoriasNota":["modo:todas"]}'::jsonb)).versao;
DO $$
DECLARE r record; c _ctx;
BEGIN
  SELECT * INTO c FROM _ctx;
  SET LOCAL ROLE authenticated;
  SELECT creditos, valor_nota, valor_fora_nota INTO r FROM hub_adiantamento_repasse(c.dia, NULL, false, 0, 1000) WHERE entregador_id = c.eid;
  RESET ROLE;
  PERFORM pg_temp.chk('repasse D: nota ["modo:todas"] puro NAO soma o que o extrato exclui (nota = extrato = 162,00, fora = 0)',
    r.creditos = 162.00 AND r.valor_nota = 162.00 AND COALESCE(r.valor_fora_nota, 0) = 0);
END $$;
-- E (regressao): extrato e nota SO com nomes/familias, como as configs de hoje
SELECT (pg_temp.salvar('{"categoriasExtrato":["Corridas concluidas","Gorjeta","familia:promocao","familia:missoes"],"categoriasNota":["Corridas concluidas","familia:promocao"]}'::jsonb)).versao;
DO $$
DECLARE r record; c _ctx;
BEGIN
  SELECT * INTO c FROM _ctx;
  SET LOCAL ROLE authenticated;
  SELECT creditos, valor_nota, valor_fora_nota INTO r FROM hub_adiantamento_repasse(c.dia, NULL, false, 0, 1000) WHERE entregador_id = c.eid;
  RESET ROLE;
  PERFORM pg_temp.chk('regressao repasse E: listas so de nomes+familia = extrato 157,00 | nota 120,00 | fora 37,00',
    r.creditos = 157.00 AND r.valor_nota = 120.00 AND r.valor_fora_nota = 37.00);
END $$;

-- ═════════ 8. Seletores: coluna primeira ═════════
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
SELECT 6, c.imp, c.eid, (now() AT TIME ZONE 'America/Sao_Paulo')::date - 3, (now() AT TIME ZONE 'America/Sao_Paulo')::date - 3, 'Credito', 1, 'Categoria Recente Q', md5('rec') || md5('rec2') FROM _ctx c;
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
SELECT 6, c.imp, c.eid, (now() AT TIME ZONE 'America/Sao_Paulo')::date - 2, (now() AT TIME ZONE 'America/Sao_Paulo')::date - 2, 'Credito', 1, 'Categoria Recente Q', md5('rec3') || md5('rec4') FROM _ctx c;
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
SELECT 6, c.imp, c.eid, (now() AT TIME ZONE 'America/Sao_Paulo')::date - 1, (now() AT TIME ZONE 'America/Sao_Paulo')::date - 1, 'Credito', 9, 'Percentual atingido de hora online', md5('ind') || md5('ind2') FROM _ctx c;
DO $$
DECLARE r record; v_prim date; v_fam text; v_cols int;
BEGIN
  SET LOCAL ROLE authenticated;
  SELECT primeira, familia INTO v_prim, v_fam FROM hub_adiantamento_categorias() WHERE descricao = 'Categoria Recente Q';
  SELECT count(*) INTO v_cols FROM hub_adiantamento_categorias();
  RESET ROLE;
  PERFORM pg_temp.chk('hub_adiantamento_categorias: primeira = menor data_referencia da janela', v_prim = (now() AT TIME ZONE 'America/Sao_Paulo')::date - 3);
  PERFORM pg_temp.chk('hub_adiantamento_categorias: authenticated executa (GRANT mantido)', v_cols >= 1);
  SET LOCAL ROLE authenticated;
  SELECT familia INTO v_fam FROM hub_adiantamento_categorias() WHERE descricao = 'Percentual atingido de hora online';
  RESET ROLE;
  PERFORM pg_temp.chk('hub_adiantamento_categorias: indicador vem com familia:indicador', v_fam = 'familia:indicador');
  PERFORM pg_temp.chk('hub_adiantamento_categorias: assinatura devolve (descricao, lancamentos, sem_motorista_identificado, familia, primeira)',
    (SELECT array_agg(a ORDER BY ord) FROM unnest((SELECT proargnames FROM pg_proc WHERE oid = 'hub_adiantamento_categorias(text)'::regprocedure)) WITH ORDINALITY u(a, ord) WHERE ord > 1)
      = ARRAY['descricao','lancamentos','sem_motorista_identificado','familia','primeira']);
  PERFORM pg_temp.chk('hub_adiantamento_categorias: PUBLIC sem EXECUTE (anon nao executa)', NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = 'hub_adiantamento_categorias(text)'::regprocedure AND a.grantee = 0));
  PERFORM pg_temp.chk('hub_campanha_categorias: assinatura ganha primeira',
    (SELECT proargnames FROM pg_proc WHERE oid = 'hub_campanha_categorias()'::regprocedure) = ARRAY['descricao','lancamentos','sem_motorista_identificado','familia','primeira']);
END $$;

-- ═════════ 9. Campanha: categorias_ok ═════════
DO $$
BEGIN
  PERFORM pg_temp.chk('campanha_categorias_ok: familia:indicador aceita', hub_campanha_categorias_ok(ARRAY['Corridas','familia:indicador']));
  PERFORM pg_temp.chk('campanha_categorias_ok: familia:promocao/missoes seguem aceitas', hub_campanha_categorias_ok(ARRAY['familia:promocao','familia:missoes']));
  PERFORM pg_temp.chk('campanha_categorias_ok: modo:todas recusado', NOT hub_campanha_categorias_ok(ARRAY['modo:todas','Corridas']));
  PERFORM pg_temp.chk('campanha_categorias_ok: familia:xyz recusada', NOT hub_campanha_categorias_ok(ARRAY['familia:xyz']));
  PERFORM pg_temp.chk('campanha_categorias_ok: 0 e 61 itens, NULL e item vazio seguem recusados',
    NOT hub_campanha_categorias_ok(ARRAY[]::text[]) AND NOT hub_campanha_categorias_ok(NULL)
    AND NOT hub_campanha_categorias_ok((SELECT array_agg(g::text) FROM generate_series(1, 61) g)) AND NOT hub_campanha_categorias_ok(ARRAY['']));
END $$;

-- ═════════ 10. Casos COMPARTILHADOS com o cliente (frontend_v2/lib/hub/casa-categoria-casos.json) ═════════
-- O driver injeta o arquivo em _json. Cliente (casaCategoria) e banco leem a MESMA tabela.
DO $$
DECLARE r record; v_n int := 0; v_ruins int := 0;
BEGIN
  FOR r IN SELECT e ->> 'descricao' AS d, e ->> 'familia' AS fam,
                  ARRAY(SELECT jsonb_array_elements_text(e -> 'lista')) AS lista, (e ->> 'esperado')::boolean AS esp
           FROM _json, jsonb_array_elements(j) e LOOP
    v_n := v_n + 1;
    IF hub_adiantamento_categoria_casa(r.d, r.lista) IS DISTINCT FROM r.esp
       OR hub_adiantamento_categoria_familia(r.d) IS DISTINCT FROM r.fam THEN
      v_ruins := v_ruins + 1;
      RAISE NOTICE 'caso compartilhado divergente: % % -> casa=% familia=% (esperado % / %)', r.d, r.lista,
        hub_adiantamento_categoria_casa(r.d, r.lista), hub_adiantamento_categoria_familia(r.d), r.esp, r.fam;
    END IF;
  END LOOP;
  PERFORM pg_temp.chk(format('casos compartilhados com o cliente (JSON): %s casos, casa() e familia() batem', v_n), v_n > 0 AND v_ruins = 0);
END $$;
