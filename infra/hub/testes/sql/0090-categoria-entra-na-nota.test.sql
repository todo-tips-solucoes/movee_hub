-- Parte 2 de 2 do teste da 0090 (F3 — "entra na nota"). Roda DEPOIS da
-- migration, na mesma transação, sobre os fixtures da parte 1.
\set ON_ERROR_STOP on

-- 1. A RESTRIÇÃO DO OPERADOR: os valores da semana não podem mudar.
--    Compara o retrato de antes da migration com o de agora, linha a linha.
DO $$
DECLARE v_dif int; v_ini date; r_a record; r_d record;
BEGIN
  SELECT inicio INTO v_ini FROM f3_ctx;
  PERFORM set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);

  CREATE TEMP TABLE f3_repasse_depois AS
    SELECT r.entregador_id, r.creditos, r.adiantamentos, r.debitos, r.remanescente
    FROM hub_adiantamento_repasse(v_ini, NULL, false, 0, 5000) r;

  SELECT count(*) INTO v_dif FROM (
    (SELECT * FROM f3_repasse_antes EXCEPT ALL SELECT * FROM f3_repasse_depois)
    UNION ALL
    (SELECT * FROM f3_repasse_depois EXCEPT ALL SELECT * FROM f3_repasse_antes)
  ) d;
  IF v_dif > 0 THEN
    RAISE EXCEPTION 'FALHOU: a 0090 mudou % linha(s) do repasse da semana', v_dif;
  END IF;
  RAISE NOTICE 'ok  repasse da semana intacto: % linha(s) identicas antes/depois',
    (SELECT count(*) FROM f3_repasse_depois);

  PERFORM set_config('request.jwt.claims', '{"motorista_cnpj":"89000000000190","escopo":[6]}', true);
  SELECT * INTO r_a FROM f3_extrato_antes;
  SELECT * INTO r_d FROM hub_adiantamento_extrato_motorista();
  ASSERT r_d.visivel        = r_a.visivel,        'visivel mudou';
  ASSERT r_d.periodo_inicio = r_a.periodo_inicio, 'periodo_inicio mudou';
  ASSERT r_d.periodo_fim    = r_a.periodo_fim,    'periodo_fim mudou';
  ASSERT r_d.total          = r_a.total,          format('total do extrato mudou: %s -> %s', r_a.total, r_d.total);
  -- O JSON dos dias ganha `naNota`, então compara só o que o motorista já via.
  ASSERT (SELECT jsonb_agg(jsonb_build_object('data', d ->> 'data', 'total', d ->> 'total') ORDER BY d ->> 'data')
          FROM jsonb_array_elements(r_d.dias) d)
       = (SELECT jsonb_agg(jsonb_build_object('data', d ->> 'data', 'total', d ->> 'total') ORDER BY d ->> 'data')
          FROM jsonb_array_elements(r_a.dias) d),
    'os totais por dia do extrato mudaram';
  RAISE NOTICE 'ok  extrato intacto: total=% nos mesmos % dias', r_d.total, jsonb_array_length(r_d.dias);
END $$;

-- 2. Sem ninguém configurar (estado em que a migration deixa produção), a
--    divisão não existe: nada de novo aparece na tela do motorista.
DO $$
DECLARE r record; v_nulos int;
BEGIN
  ASSERT (SELECT count(*) FROM "AdiantamentoConfiguracao" WHERE categorias_nota IS NOT NULL) = 0,
    'a migration nao pode preencher categorias_nota de ninguem';
  PERFORM set_config('request.jwt.claims', '{"motorista_cnpj":"89000000000190","escopo":[6]}', true);
  SELECT * INTO r FROM hub_adiantamento_extrato_motorista();
  ASSERT r.total_nota IS NULL,   'sem configurar, total_nota tem de ser nulo';
  ASSERT r.total_outros IS NULL, 'sem configurar, total_outros tem de ser nulo';
  SELECT count(*) INTO v_nulos FROM jsonb_array_elements(r.dias) d,
       jsonb_array_elements(d -> 'itens') i WHERE i ->> 'naNota' IS NOT NULL;
  ASSERT v_nulos = 0, format('sem configurar, nenhum item pode trazer naNota (veio %s)', v_nulos);
  RAISE NOTICE 'ok  nao configurado: total_nota/total_outros nulos e nenhum item marcado';
END $$;

-- 3. Configurado: a divisão aparece, e o total continua sendo a soma dos dois.
DO $$
DECLARE v_ver int; r record; v_soma numeric;
BEGIN
  SELECT max(versao) + 1 INTO v_ver FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6;
  INSERT INTO "AdiantamentoConfiguracao" (
      id_empresa, versao, vigente_desde, timezone, dias_habilitados, horario_abertura, horario_corte,
      percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto,
      descricao_pix_modelo, apuracao_dia_inicio, apuracao_dias_ate_repasse, apuracao_data_base,
      categorias_extrato, categorias_nota, desconto_adiantamentos, desconto_debitos, repasse_visivel_app)
  SELECT 6, v_ver, now(), timezone, dias_habilitados, horario_abertura, horario_corte,
      percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto,
      descricao_pix_modelo, apuracao_dia_inicio, apuracao_dias_ate_repasse, apuracao_data_base,
      categorias_extrato, ARRAY['Corridas concluidas'], desconto_adiantamentos, desconto_debitos, repasse_visivel_app
  FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6 ORDER BY versao DESC LIMIT 1;

  PERFORM set_config('request.jwt.claims', '{"motorista_cnpj":"89000000000190","escopo":[6]}', true);
  SELECT * INTO r FROM hub_adiantamento_extrato_motorista();

  -- 100 + 60 de corrida; 25 (campanha) + 15 (gorjeta) fora da nota.
  ASSERT r.total        = 200.00, format('total esperado 200.00, veio %s', r.total);
  ASSERT r.total_nota   = 160.00, format('total_nota esperado 160.00, veio %s', r.total_nota);
  ASSERT r.total_outros =  40.00, format('total_outros esperado 40.00, veio %s', r.total_outros);
  ASSERT r.total_nota + r.total_outros = r.total, 'nota + outros tem de fechar o total';

  SELECT sum((i ->> 'valor')::numeric) INTO v_soma
  FROM jsonb_array_elements(r.dias) d, jsonb_array_elements(d -> 'itens') i
  WHERE (i ->> 'naNota')::boolean;
  ASSERT v_soma = r.total_nota, format('os itens marcados somam %s e total_nota diz %s', v_soma, r.total_nota);
  RAISE NOTICE 'ok  configurado: total=% = nota % + outros %', r.total, r.total_nota, r.total_outros;
END $$;

-- 4. O campo novo aceita token de família, como os outros — senão a campanha
--    da semana seguinte cairia do lado errado em silêncio.
DO $$
DECLARE v_ver int; r record;
BEGIN
  SELECT max(versao) + 1 INTO v_ver FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6;
  INSERT INTO "AdiantamentoConfiguracao" (
      id_empresa, versao, vigente_desde, timezone, dias_habilitados, horario_abertura, horario_corte,
      percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto,
      descricao_pix_modelo, apuracao_dia_inicio, apuracao_dias_ate_repasse, apuracao_data_base,
      categorias_extrato, categorias_nota, desconto_adiantamentos, desconto_debitos, repasse_visivel_app)
  SELECT 6, v_ver, now(), timezone, dias_habilitados, horario_abertura, horario_corte,
      percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto,
      descricao_pix_modelo, apuracao_dia_inicio, apuracao_dias_ate_repasse, apuracao_data_base,
      categorias_extrato, ARRAY['Corridas concluidas','familia:promocao'], desconto_adiantamentos, desconto_debitos, repasse_visivel_app
  FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6 ORDER BY versao DESC LIMIT 1;

  PERFORM set_config('request.jwt.claims', '{"motorista_cnpj":"89000000000190","escopo":[6]}', true);
  SELECT * INTO r FROM hub_adiantamento_extrato_motorista();
  ASSERT r.total        = 200.00, 'o total nao muda com a configuracao da nota';
  ASSERT r.total_nota   = 185.00, format('com a familia na nota esperava 185.00, veio %s', r.total_nota);
  ASSERT r.total_outros =  15.00, format('so a gorjeta fora da nota (15.00), veio %s', r.total_outros);
  RAISE NOTICE 'ok  familia no campo novo: a campanha foi para a nota (nota=%)', r.total_nota;
END $$;

-- 5. `configuracao_salvar` carrega o campo entre versões. Sem isso, o próximo
--    salvamento de qualquer outro campo apagaria a marcação da nota.
DO $$
DECLARE v_ver int; v_sub int; v_emp int; v_nova "AdiantamentoConfiguracao";
BEGIN
  -- A permissão vem do BANCO, não da claim (hub_adiantamento_tem_permissao).
  -- No hub-homolog quem tem `adiantamentos.configurar` está vinculado à
  -- empresa 9001; o escopo precisa conter o 6 porque a função só configura o
  -- grupo Movee. Em produção o mesmo usuário é da 6 — o que se testa aqui é o
  -- carry-through do campo, não o RBAC (coberto pela suíte de adiantamentos).
  SELECT ue.usuario_id, ue.empresa_id INTO v_sub, v_emp
  FROM "UsuarioEntidade" ue
  JOIN "PapelPermissao" pp ON pp.papel_id = ue.papel_id
  JOIN "Permissao" p ON p.id = pp.permissao_id
  JOIN "ModuloEntidade" me ON me.modulo_id = p.modulo_id AND me.empresa_id = ue.empresa_id
  WHERE p.codigo = 'adiantamentos.configurar' AND ue.ativo AND me.ativo
  ORDER BY ue.usuario_id LIMIT 1;
  IF v_sub IS NULL THEN RAISE EXCEPTION 'FALHOU: nenhum usuario com adiantamentos.configurar no ambiente'; END IF;
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","empresa_ativa":"%s","escopo":[6,%s]}', v_sub, v_emp, v_emp), true);
  SELECT max(versao) INTO v_ver FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6;

  -- Salva mexendo em outra coisa; `categoriasNota` nem vai no payload.
  SELECT * INTO v_nova FROM hub_adiantamento_configuracao_salvar(v_ver, '{"motivo":"teste F3 carry-through"}'::jsonb);
  ASSERT v_nova.categorias_nota = ARRAY['Corridas concluidas','familia:promocao'],
    format('carry-through falhou: veio %s', v_nova.categorias_nota);

  -- E aceita o campo novo quando ele vem.
  SELECT * INTO v_nova FROM hub_adiantamento_configuracao_salvar(v_nova.versao,
    '{"motivo":"teste F3 gravacao","categoriasNota":["Corridas concluidas"]}'::jsonb);
  ASSERT v_nova.categorias_nota = ARRAY['Corridas concluidas'],
    format('gravacao falhou: veio %s', v_nova.categorias_nota);
  RAISE NOTICE 'ok  salvar: carrega categorias_nota entre versoes e grava o valor novo';
END $$;
