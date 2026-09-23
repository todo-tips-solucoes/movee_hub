-- Teste da 0093 (vínculo por EnvioMassa). Roda DENTRO de uma transação que
-- termina em ROLLBACK — ver infra/hub/testes/hub-vinculo-cnpj.sh.
-- Dados sintéticos: CNPJ, nome e telefone inventados (repositório público).
\set ON_ERROR_STOP on

DO $$
DECLARE
  v_emp int := 9001;                      -- tenant QA, isolado dos dados reais
  v_sub int; v_emp_perm int;
  e_simples int; e_homonimo_a int; e_homonimo_b int; e_ambiguo int; e_sem int; e_conta_ok int;
  v_conta_livre int; v_conta_ocupada int; e_ocupando int; e_conta_ocupada int;
  r record; v_plano jsonb;
BEGIN
  -- (a) caso simples: nome único, um CNPJ na EnvioMassa, sem conta ainda.
  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (v_emp, gen_random_uuid(), 'Alfa Simples Teste') RETURNING id INTO e_simples;
  INSERT INTO "EnvioMassa" (nome, cnpj_prestador, number, created_at)
  VALUES ('Alfa Simples Teste', '89000000000301', '5511900000301', now() - interval '2 days'),
         ('ALFA SIMPLES TESTE', '89000000000301', '5511900000399', now() - interval '1 day');  -- mesmo CNPJ, tel mais novo

  -- (b) HOMÔNIMO INTERNO: dois entregadores com o mesmo nome. Nenhum pode ser
  --     vinculado — é aqui que um palpite viraria nota no CNPJ errado.
  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (v_emp, gen_random_uuid(), 'Beta Homonimo Teste') RETURNING id INTO e_homonimo_a;
  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (v_emp, gen_random_uuid(), 'beta homonimo teste') RETURNING id INTO e_homonimo_b;
  INSERT INTO "EnvioMassa" (nome, cnpj_prestador, number, created_at)
  VALUES ('Beta Homonimo Teste', '89000000000302', '5511900000302', now());

  -- (c) AMBÍGUO: um nome, dois CNPJs na EnvioMassa.
  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (v_emp, gen_random_uuid(), 'Gama Ambiguo Teste') RETURNING id INTO e_ambiguo;
  INSERT INTO "EnvioMassa" (nome, cnpj_prestador, number, created_at)
  VALUES ('Gama Ambiguo Teste', '89000000000303', '5511900000303', now()),
         ('Gama Ambiguo Teste', '89000000000304', '5511900000304', now());

  -- (d) sem casamento nenhum.
  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (v_emp, gen_random_uuid(), 'Delta Sem Casamento Teste') RETURNING id INTO e_sem;

  -- (e) conta JÁ EXISTE e está livre: vincula sem criar.
  INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('89000000000305', 'Epsilon Conta Livre') RETURNING id INTO v_conta_livre;
  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (v_emp, gen_random_uuid(), 'Epsilon Conta Livre') RETURNING id INTO e_conta_ok;
  INSERT INTO "EnvioMassa" (nome, cnpj_prestador, number, created_at)
  VALUES ('Epsilon Conta Livre', '89000000000305', '5511900000305', now());

  -- (f) conta já vinculada a OUTRO entregador: tem de recusar, não estourar.
  INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('89000000000306', 'Zeta Ocupada') RETURNING id INTO v_conta_ocupada;
  INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id)
  VALUES (v_emp, gen_random_uuid(), 'Zeta Quem Ocupou', v_conta_ocupada) RETURNING id INTO e_ocupando;
  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (v_emp, gen_random_uuid(), 'Zeta Ocupada') RETURNING id INTO e_conta_ocupada;
  INSERT INTO "EnvioMassa" (nome, cnpj_prestador, number, created_at)
  VALUES ('Zeta Ocupada', '89000000000306', '5511900000306', now());

  SELECT ue.usuario_id, ue.empresa_id INTO v_sub, v_emp_perm
    FROM "UsuarioEntidade" ue
    JOIN "PapelPermissao" pp ON pp.papel_id = ue.papel_id
    JOIN "Permissao" p ON p.id = pp.permissao_id
    JOIN "ModuloEntidade" me ON me.modulo_id = p.modulo_id AND me.empresa_id = ue.empresa_id
   WHERE p.codigo = 'adiantamentos.configurar' AND ue.ativo AND me.ativo
   ORDER BY ue.usuario_id LIMIT 1;
  IF v_sub IS NULL THEN RAISE EXCEPTION 'FALHOU: nenhum usuario com adiantamentos.configurar'; END IF;
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","empresa_ativa":"%s","escopo":[%s]}', v_sub, v_emp, v_emp), true);

  -- 1. SIMULAÇÃO não pode escrever nada.
  SELECT jsonb_object_agg(acao, quantidade) INTO v_plano
    FROM hub_motorista_vincular_por_envio_massa(v_emp, false);
  ASSERT (SELECT motorista_id FROM "Entregador" WHERE id = e_simples) IS NULL,
    'simulação (p_aplicar=false) NÃO pode vincular ninguém';
  ASSERT (v_plano ->> 'VINCULOS_FEITOS')::int = 0, 'simulação não faz vínculo';
  RAISE NOTICE 'ok  simulação não escreve: %', v_plano;

  -- 2. O plano classifica cada caso pelo nome certo.
  ASSERT (v_plano ->> 'CRIAR_CONTA_E_VINCULAR')::int >= 1, 'o caso simples devia ser CRIAR_CONTA_E_VINCULAR';
  ASSERT (v_plano ->> 'VINCULAR_CONTA_EXISTENTE')::int >= 1, 'a conta livre devia ser VINCULAR_CONTA_EXISTENTE';
  ASSERT (v_plano ->> 'AMBIGUO')::int >= 1, 'o nome com dois CNPJs devia ser AMBIGUO';
  ASSERT (v_plano ->> 'HOMONIMO_INTERNO')::int >= 2, 'os DOIS homônimos deviam ficar de fora';
  ASSERT (v_plano ->> 'SEM_CASAMENTO')::int >= 1, 'quem não casa devia ser SEM_CASAMENTO';
  ASSERT (v_plano ->> 'CONTA_JA_VINCULADA')::int >= 1, 'a conta ocupada devia ser CONTA_JA_VINCULADA';
  RAISE NOTICE 'ok  classificação: cada caso com o seu motivo';

  -- 3. Aplicando de verdade.
  PERFORM hub_motorista_vincular_por_envio_massa(v_emp, true);

  ASSERT (SELECT cm.cnpj_prestador FROM "Entregador" e JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
           WHERE e.id = e_simples) = '89000000000301',
    'o caso simples devia estar vinculado ao CNPJ da EnvioMassa';
  -- telefone veio junto, e é o MAIS RECENTE
  ASSERT (SELECT cm.telefone FROM "Entregador" e JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
           WHERE e.id = e_simples) = '5511900000399',
    'a conta criada devia nascer com o telefone mais recente daquele CNPJ';
  ASSERT (SELECT motorista_id FROM "Entregador" WHERE id = e_conta_ok) = v_conta_livre,
    'a conta que já existia devia ser reusada, não duplicada';

  -- O que importa: os arriscados continuam SEM vínculo.
  ASSERT (SELECT motorista_id FROM "Entregador" WHERE id = e_homonimo_a) IS NULL
     AND (SELECT motorista_id FROM "Entregador" WHERE id = e_homonimo_b) IS NULL,
    'homônimo interno NÃO pode ser vinculado — daria nota no CNPJ errado';
  ASSERT (SELECT motorista_id FROM "Entregador" WHERE id = e_ambiguo) IS NULL,
    'nome com dois CNPJs NÃO pode ser vinculado';
  ASSERT (SELECT motorista_id FROM "Entregador" WHERE id = e_sem) IS NULL, 'sem casamento segue sem vínculo';
  ASSERT (SELECT motorista_id FROM "Entregador" WHERE id = e_conta_ocupada) IS NULL,
    'conta já de outro entregador não pode ser roubada';
  ASSERT (SELECT motorista_id FROM "Entregador" WHERE id = e_ocupando) = v_conta_ocupada,
    'o vínculo que já existia não pode ser alterado';
  RAISE NOTICE 'ok  aplicado: vincula os seguros e deixa os arriscados intactos';

  -- 4. Idempotente: rodar de novo não muda nada nem duplica conta.
  DECLARE v_contas_antes int; v_contas_depois int; v_plano2 jsonb;
  BEGIN
    SELECT count(*) INTO v_contas_antes FROM "ContaMotorista";
    SELECT jsonb_object_agg(acao, quantidade) INTO v_plano2
      FROM hub_motorista_vincular_por_envio_massa(v_emp, true);
    SELECT count(*) INTO v_contas_depois FROM "ContaMotorista";
    ASSERT v_contas_antes = v_contas_depois,
      format('reexecutar criou conta duplicada (%s -> %s)', v_contas_antes, v_contas_depois);
    ASSERT (v_plano2 ->> 'VINCULOS_FEITOS')::int = 0, 'reexecutar não devia vincular nada de novo';
    RAISE NOTICE 'ok  idempotente: reexecutar não cria conta nem vínculo';
  END;
END $$;

-- 5. Sem permissão, a função recusa.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claims', '{"sub":"999999","empresa_ativa":"9001","escopo":[9001]}', true);
  BEGIN
    PERFORM hub_motorista_vincular_por_envio_massa(9001, false);
    RAISE EXCEPTION 'FALHOU: a função rodou sem permissão';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF SQLERRM NOT LIKE '%PERMISSAO_NEGADA%' THEN RAISE; END IF;
    RAISE NOTICE 'ok  sem permissão: PERMISSAO_NEGADA';
  END;
END $$;
