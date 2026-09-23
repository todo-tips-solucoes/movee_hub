-- Parte 2 de 2 do teste da 0092 (F4-B). Roda DEPOIS da migration, na mesma
-- transação, sobre os fixtures da parte 1.
\set ON_ERROR_STOP on

-- 1. O fechamento não mexe no repasse: os números de antes continuam valendo.
DO $$
DECLARE v_dif int; c record;
BEGIN
  SELECT * INTO c FROM f4b_ctx;
  PERFORM set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
  CREATE TEMP TABLE f4b_repasse_depois AS
    SELECT r.entregador_id, r.creditos, r.adiantamentos, r.debitos, r.remanescente
    FROM hub_adiantamento_repasse((SELECT semana FROM f4b_ctx), NULL, false, 0, 5000) r;
  SELECT count(*) INTO v_dif FROM (
    (SELECT * FROM f4b_repasse_antes EXCEPT ALL SELECT * FROM f4b_repasse_depois)
    UNION ALL
    (SELECT * FROM f4b_repasse_depois EXCEPT ALL SELECT * FROM f4b_repasse_antes)) d;
  IF v_dif > 0 THEN RAISE EXCEPTION 'FALHOU: a 0092 mudou % linha(s) do repasse', v_dif; END IF;
  RAISE NOTICE 'ok  repasse intacto (% linhas)', (SELECT count(*) FROM f4b_repasse_depois);
END $$;

-- 2. Fechar a apuração congela a divisão — e o `creditos` continua sendo o todo.
DO $$
DECLARE
  c record; v_sub int; v_emp int; v_ap record; i record;
BEGIN
  SELECT * INTO c FROM f4b_ctx;
  SELECT ue.usuario_id, ue.empresa_id INTO v_sub, v_emp
    FROM "UsuarioEntidade" ue
    JOIN "PapelPermissao" pp ON pp.papel_id = ue.papel_id
    JOIN "Permissao" p ON p.id = pp.permissao_id
    JOIN "ModuloEntidade" me ON me.modulo_id = p.modulo_id AND me.empresa_id = ue.empresa_id
   WHERE p.codigo = 'adiantamentos.pagamento_confirmar' AND ue.ativo AND me.ativo
   ORDER BY ue.usuario_id LIMIT 1;
  IF v_sub IS NULL THEN RAISE EXCEPTION 'FALHOU: nenhum usuario com adiantamentos.pagamento_confirmar'; END IF;
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","empresa_ativa":"%s","escopo":[6,%s]}', v_sub, v_emp, v_emp), true);

  SELECT * INTO v_ap FROM hub_adiantamento_repasse_fechar(c.semana);
  RAISE NOTICE 'ok  apuração fechada: id=% motoristas=%', v_ap.apuracao_id, v_ap.motoristas;

  SELECT * INTO i FROM "ApuracaoRepasseItem"
   WHERE apuracao_id = v_ap.apuracao_id AND entregador_id = c.entregador_id;

  -- 400 (corrida) + 80 (campanha, pela família) + 20 (gorjeta). Fora: 50.
  ASSERT i.creditos = 500.00, format('creditos congelados esperados 500.00, veio %s', i.creditos);
  ASSERT i.valor_nota = 480.00, format('base da nota esperada 480.00 (400+80), veio %s', i.valor_nota);
  ASSERT i.valor_fora_nota = 20.00, format('fora da nota esperado 20.00 (gorjeta), veio %s', i.valor_fora_nota);
  ASSERT i.valor_nota + i.valor_fora_nota = i.creditos, 'nota + fora tem de fechar os creditos congelados';
  RAISE NOTICE 'ok  congelado: creditos=% = nota % + fora %', i.creditos, i.valor_nota, i.valor_fora_nota;
END $$;

-- 3. Sem `categorias_nota` configurada, a apuração fecha igual e a divisão vem
--    NULA — a geração é que recusa depois, com motivo.
DO $$
DECLARE
  c record; v_ver int; v_sub int; v_emp int; v_ap record; i record; v_eid2 int; v_imp int;
BEGIN
  SELECT * INTO c FROM f4b_ctx;
  SELECT id INTO v_imp FROM "ImportacaoArquivo" WHERE id_empresa = 6 ORDER BY id DESC LIMIT 1;

  -- config NOVA sem categorias_nota, vigente antes de outra semana
  SELECT max(versao) + 1 INTO v_ver FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6;
  INSERT INTO "AdiantamentoConfiguracao" (
      id_empresa, versao, vigente_desde, timezone, dias_habilitados, horario_abertura, horario_corte,
      percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto,
      descricao_pix_modelo, apuracao_dia_inicio, apuracao_dias_ate_repasse, apuracao_data_base,
      categorias_extrato, categorias_nota, desconto_adiantamentos, desconto_debitos, repasse_visivel_app)
  SELECT 6, v_ver, now(), timezone, dias_habilitados, horario_abertura, horario_corte,
      percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto,
      descricao_pix_modelo, 1, 3, 'data_lancamento',
      ARRAY['Corridas concluidas'], NULL, true, true, true
  FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6 ORDER BY versao DESC LIMIT 1;

  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (6, gen_random_uuid(), 'Sem Nota Teste')
    RETURNING id INTO v_eid2;
  INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
  VALUES (6, v_imp, v_eid2, c.semana + 7, c.semana + 7, 'Credito', 100.00, 'Corridas concluidas', md5('t0092e')||md5('x'));

  SELECT ue.usuario_id, ue.empresa_id INTO v_sub, v_emp
    FROM "UsuarioEntidade" ue
    JOIN "PapelPermissao" pp ON pp.papel_id = ue.papel_id
    JOIN "Permissao" p ON p.id = pp.permissao_id
    JOIN "ModuloEntidade" me ON me.modulo_id = p.modulo_id AND me.empresa_id = ue.empresa_id
   WHERE p.codigo = 'adiantamentos.pagamento_confirmar' AND ue.ativo AND me.ativo
   ORDER BY ue.usuario_id LIMIT 1;
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","empresa_ativa":"%s","escopo":[6,%s]}', v_sub, v_emp, v_emp), true);

  SELECT * INTO v_ap FROM hub_adiantamento_repasse_fechar(c.semana + 7);
  SELECT * INTO i FROM "ApuracaoRepasseItem"
   WHERE apuracao_id = v_ap.apuracao_id AND entregador_id = v_eid2;
  ASSERT i.creditos = 100.00, format('creditos esperados 100.00, veio %s', i.creditos);
  ASSERT i.valor_nota IS NULL AND i.valor_fora_nota IS NULL,
    format('sem categorias_nota a divisão tem de ser nula, veio %s/%s', i.valor_nota, i.valor_fora_nota);
  RAISE NOTICE 'ok  sem categorias_nota: apuração fecha e a divisão vem nula';
END $$;

-- 4. A trilha da geração existe e o UNIQUE impede gerar duas vezes.
DO $$
DECLARE v_ap bigint; v_eid int;
BEGIN
  SELECT apuracao_id, entregador_id INTO v_ap, v_eid
    FROM "ApuracaoRepasseItem" ORDER BY id LIMIT 1;
  INSERT INTO "ApuracaoRepasseMovimento" (apuracao_id, entregador_id, id_empresa, envio_massa_id, valor, gorjeta)
  VALUES (v_ap, v_eid, 6, 999001, 480.00, 20.00);
  BEGIN
    INSERT INTO "ApuracaoRepasseMovimento" (apuracao_id, entregador_id, id_empresa, envio_massa_id, valor, gorjeta)
    VALUES (v_ap, v_eid, 6, 999002, 480.00, 20.00);
    RAISE EXCEPTION 'FALHOU: a trilha aceitou gerar o mesmo motorista duas vezes na mesma apuração';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'ok  trilha: UNIQUE(apuracao, entregador) impede duplicar a geração';
  END;
END $$;
