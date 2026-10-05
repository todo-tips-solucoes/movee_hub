-- Teste da 0102 (vínculo pela base `Motorista`). Roda DENTRO de uma transação
-- que termina em ROLLBACK — ver infra/hub/testes/hub-vinculo-base-motorista.sh.
-- Dados sintéticos: CNPJ, nome e telefone inventados (repositório público).
\set ON_ERROR_STOP on

DO $$
DECLARE
  v_emp int := 9001;                      -- tenant QA, isolado dos dados reais
  v_sub int;
  e_simples int; e_homonimo_a int; e_homonimo_b int; e_ambiguo int; e_sem int;
  e_conta_ok int; e_sem_telefone int; v_conta_livre int; v_conta_ocupada int;
  e_ocupando int; e_conta_ocupada int; v_plano jsonb;
BEGIN
  -- (a) caso simples: nome único, UM CNPJ na base Motorista, telefone vem da
  --     EnvioMassa (a tabela Motorista não guarda telefone).
  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (v_emp, gen_random_uuid(), 'Alfa Base Motorista') RETURNING id INTO e_simples;
  INSERT INTO "Motorista" (cnpj_prestador, nome, ativo) VALUES ('88000000000401', 'Alfa Base Motorista', true);
  INSERT INTO "EnvioMassa" (nome, cnpj_prestador, number, created_at)
  VALUES ('Alfa Base Motorista', '88000000000401', '5511900000401', now() - interval '2 days'),
         ('ALFA BASE MOTORISTA', '88000000000401', '5511900000499', now() - interval '1 day');

  -- (a2) casa na Motorista, mas NÃO tem telefone em lugar nenhum: a conta
  --      precisa nascer assim mesmo, com telefone nulo — e não falhar.
  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (v_emp, gen_random_uuid(), 'Teta Sem Telefone') RETURNING id INTO e_sem_telefone;
  INSERT INTO "Motorista" (cnpj_prestador, nome, ativo) VALUES ('88000000000407', 'Teta Sem Telefone', true);

  -- (b) HOMÔNIMO INTERNO: dois entregadores com o mesmo nome. Nenhum pode ser
  --     vinculado — é aqui que um palpite viraria nota no CNPJ errado.
  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (v_emp, gen_random_uuid(), 'Beta Homonimo Mot') RETURNING id INTO e_homonimo_a;
  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (v_emp, gen_random_uuid(), 'beta homonimo mot') RETURNING id INTO e_homonimo_b;
  INSERT INTO "Motorista" (cnpj_prestador, nome, ativo) VALUES ('88000000000402', 'Beta Homonimo Mot', true);

  -- (c) AMBÍGUO: um nome, dois CNPJs na base Motorista. É o caso de 22
  --     entregadores reais (R$ 67.438 em 30 dias): 2 empresas diferentes da
  --     mesma pessoa, ambas com histórico. Escolher é decisão humana.
  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (v_emp, gen_random_uuid(), 'Gama Ambiguo Mot') RETURNING id INTO e_ambiguo;
  INSERT INTO "Motorista" (cnpj_prestador, nome, ativo)
  VALUES ('88000000000403', 'Gama Ambiguo Mot', true), ('88000000000404', 'Gama Ambiguo Mot', true);

  -- (d) sem casamento nenhum.
  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (v_emp, gen_random_uuid(), 'Delta Sem Casamento Mot') RETURNING id INTO e_sem;

  -- (e) conta JÁ EXISTE e está livre: vincula sem criar.
  INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('88000000000405', 'Epsilon Conta Livre Mot') RETURNING id INTO v_conta_livre;
  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (v_emp, gen_random_uuid(), 'Epsilon Conta Livre Mot') RETURNING id INTO e_conta_ok;
  INSERT INTO "Motorista" (cnpj_prestador, nome, ativo) VALUES ('88000000000405', 'Epsilon Conta Livre Mot', true);

  -- (f) conta já vinculada a OUTRO entregador: tem de recusar, não estourar.
  INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('88000000000406', 'Zeta Ocupada Mot') RETURNING id INTO v_conta_ocupada;
  INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id)
  VALUES (v_emp, gen_random_uuid(), 'Zeta Quem Ocupou Mot', v_conta_ocupada) RETURNING id INTO e_ocupando;
  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES (v_emp, gen_random_uuid(), 'Zeta Ocupada Mot') RETURNING id INTO e_conta_ocupada;
  INSERT INTO "Motorista" (cnpj_prestador, nome, ativo) VALUES ('88000000000406', 'Zeta Ocupada Mot', true);

  SELECT ue.usuario_id INTO v_sub
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
    FROM hub_motorista_vincular_por_base_motorista(v_emp, false);
  ASSERT (SELECT motorista_id FROM "Entregador" WHERE id = e_simples) IS NULL,
    'simulação (p_aplicar=false) NÃO pode vincular ninguém';
  ASSERT (v_plano ->> 'VINCULOS_FEITOS')::int = 0, 'simulação não faz vínculo';
  RAISE NOTICE 'ok  simulação não escreve: %', v_plano;

  -- 2. O plano classifica cada caso pelo nome certo.
  ASSERT (v_plano ->> 'CRIAR_CONTA_E_VINCULAR')::int >= 2, 'os casos simples deviam ser CRIAR_CONTA_E_VINCULAR';
  ASSERT (v_plano ->> 'VINCULAR_CONTA_EXISTENTE')::int >= 1, 'a conta livre devia ser VINCULAR_CONTA_EXISTENTE';
  ASSERT (v_plano ->> 'AMBIGUO')::int >= 1, 'o nome com dois CNPJs devia ser AMBIGUO';
  ASSERT (v_plano ->> 'HOMONIMO_INTERNO')::int >= 2, 'os DOIS homônimos deviam ficar de fora';
  ASSERT (v_plano ->> 'SEM_CASAMENTO')::int >= 1, 'quem não casa devia ser SEM_CASAMENTO';
  ASSERT (v_plano ->> 'CONTA_JA_VINCULADA')::int >= 1, 'a conta ocupada devia ser CONTA_JA_VINCULADA';
  RAISE NOTICE 'ok  classificação: cada caso com o seu motivo';

  -- 3. Aplicando de verdade.
  PERFORM hub_motorista_vincular_por_base_motorista(v_emp, true);

  ASSERT (SELECT cm.cnpj_prestador FROM "Entregador" e JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
           WHERE e.id = e_simples) = '88000000000401',
    'o caso simples devia estar vinculado ao CNPJ da base Motorista';
  ASSERT (SELECT cm.telefone FROM "Entregador" e JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
           WHERE e.id = e_simples) = '5511900000499',
    'a conta criada devia nascer com o telefone MAIS RECENTE daquele CNPJ';
  ASSERT (SELECT cm.telefone FROM "Entregador" e JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
           WHERE e.id = e_sem_telefone) IS NULL,
    'sem telefone em lugar nenhum, a conta nasce com telefone nulo — e o vínculo acontece assim mesmo';
  ASSERT (SELECT motorista_id FROM "Entregador" WHERE id = e_sem_telefone) IS NOT NULL,
    'a falta de telefone não pode impedir o vínculo';
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
      FROM hub_motorista_vincular_por_base_motorista(v_emp, true);
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
    PERFORM hub_motorista_vincular_por_base_motorista(9001, false);
    RAISE EXCEPTION 'FALHOU: a função aceitou um usuário sem adiantamentos.configurar';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF SQLERRM LIKE 'FALHOU:%' THEN RAISE; END IF;
    RAISE NOTICE 'ok  sem permissão: %', SQLERRM;
  END;
END $$;
