-- Teste da 0103 (conta só CORRENTE; lançamento pelo hub; busca de entregador).
-- Roda DENTRO de uma transação que termina em ROLLBACK — ver
-- infra/hub/testes/hub-conta-pj-lancamento.sh.
-- Dados sintéticos: CNPJ, CPF e nomes inventados (repositório público).
\set ON_ERROR_STOP on

DO $$
DECLARE
  v_emp int := 9001;
  v_sub int;
  e_alvo int; e_outro int; e_outra_empresa int;
  v_conta_antiga bigint; v_nova jsonb; v_achados int;
BEGIN
  INSERT INTO "Entregador" (id_empresa, id_externo, nome, ativo)
  VALUES (v_emp, gen_random_uuid(), 'Zarabatana Teste Lancamento', true) RETURNING id INTO e_alvo;
  INSERT INTO "Entregador" (id_empresa, id_externo, nome, ativo)
  VALUES (v_emp, gen_random_uuid(), 'Outro Nome Qualquer', true) RETURNING id INTO e_outro;
  -- entregador que EXISTE, mas em outra empresa: é o único jeito de provar a
  -- guarda de escopo. Com um id inexistente, 'NAO_ENCONTRADA' vem de qualquer
  -- forma e o teste passa mesmo sem a guarda (pego pelo controle negativo).
  INSERT INTO "Entregador" (id_empresa, id_externo, nome, ativo)
  VALUES (9002, gen_random_uuid(), 'Alheio Outra Empresa', true) RETURNING id INTO e_outra_empresa;

  -- conta PJ já aprovada: o lançamento tem de APOSENTÁ-LA, não duplicar
  -- `entregador_confirmado_id` é obrigatório quando APROVADA
  -- (contabancariamotorista_confirmado_obrigatorio_chk) — a RPC de lançamento
  -- preenche, e o fixture precisa fazer o mesmo.
  INSERT INTO "ContaBancariaMotorista" (id_empresa, entregador_id, origem, status, titular_nome,
         titular_documento, titular_tipo, banco_codigo, banco_nome, agencia, conta, conta_digito, tipo_conta,
         entregador_confirmado_id)
  VALUES (v_emp, e_alvo, 'APP', 'APROVADA', 'Zarabatana Teste Lancamento',
         '11222333000181', 'PJ', '260', 'Nu', '0001', '111111', '1', 'CORRENTE', e_alvo)
  RETURNING id INTO v_conta_antiga;

  SELECT ue.usuario_id INTO v_sub
    FROM "UsuarioEntidade" ue
    JOIN "PapelPermissao" pp ON pp.papel_id = ue.papel_id
    JOIN "Permissao" p ON p.id = pp.permissao_id
    JOIN "ModuloEntidade" me ON me.modulo_id = p.modulo_id AND me.empresa_id = ue.empresa_id
   WHERE p.codigo = 'adiantamentos.contas_revisar' AND ue.ativo AND me.ativo AND ue.empresa_id = v_emp
   ORDER BY ue.usuario_id LIMIT 1;
  IF v_sub IS NULL THEN RAISE EXCEPTION 'FALHOU: nenhum usuario com adiantamentos.contas_revisar em %', v_emp; END IF;
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","empresa_ativa":"%s","escopo":[%s]}', v_sub, v_emp, v_emp), true);

  -- 1. POUPANÇA não entra nem pelo hub (porta das exceções).
  BEGIN
    PERFORM hub_conta_bancaria_lancar(jsonb_build_object(
      'entregadorId', e_alvo, 'titularNome', 'Zarabatana Teste Lancamento',
      'titularDocumento', '12345678909', 'bancoCodigo', '260', 'bancoNome', 'Nu',
      'agencia', '0001', 'conta', '222222', 'contaDigito', '2', 'tipoConta', 'POUPANCA'));
    RAISE EXCEPTION 'FALHOU: poupança foi aceita pelo lançamento do hub';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF SQLERRM LIKE 'FALHOU:%' THEN RAISE; END IF;
    RAISE NOTICE 'ok  poupança recusada no lançamento: %', SQLERRM;
  END;

  -- 2. CPF (PF) é aceito — é exatamente a exceção que esta porta existe para dar.
  v_nova := hub_conta_bancaria_lancar(jsonb_build_object(
    'entregadorId', e_alvo, 'titularNome', 'Zarabatana Teste Lancamento',
    'titularDocumento', '12345678909', 'bancoCodigo', '260', 'bancoNome', 'Nu',
    'agencia', '0001', 'conta', '222222', 'contaDigito', '2', 'tipoConta', 'CORRENTE'));
  ASSERT (v_nova ->> 'titularTipo') = 'PF', 'conta lançada com CPF devia nascer PF';
  ASSERT (v_nova ->> 'status') = 'APROVADA', 'quem lança é quem aprovaria — nasce aprovada';
  RAISE NOTICE 'ok  PF aceito pelo hub e já aprovado';

  -- 3. A conta anterior foi APOSENTADA, não duplicada.
  ASSERT (SELECT status FROM "ContaBancariaMotorista" WHERE id = v_conta_antiga) = 'SUBSTITUIDA',
    'a conta aprovada anterior devia virar SUBSTITUIDA';
  ASSERT (SELECT count(*) FROM "ContaBancariaMotorista" WHERE entregador_id = e_alvo AND status = 'APROVADA') = 1,
    'só pode haver UMA conta aprovada por entregador';
  ASSERT (SELECT origem FROM "ContaBancariaMotorista" WHERE id = (v_nova ->> 'id')::bigint) = 'HUB',
    'a conta lançada pelo operador precisa ser distinguível da que veio do app';
  ASSERT (SELECT revisada_por FROM "ContaBancariaMotorista" WHERE id = (v_nova ->> 'id')::bigint) = v_sub,
    'a trilha de quem lançou não pode se perder';
  RAISE NOTICE 'ok  anterior aposentada, origem HUB, revisor carimbado';

  -- 4. Entregador fora do escopo não é alcançável.
  BEGIN
    PERFORM hub_conta_bancaria_lancar(jsonb_build_object(
      'entregadorId', e_outra_empresa, 'titularNome', 'X', 'titularDocumento', '12345678909',
      'bancoCodigo', '260', 'bancoNome', 'Nu', 'agencia', '0001', 'conta', '3', 'contaDigito', '3',
      'tipoConta', 'CORRENTE'));
    RAISE EXCEPTION 'FALHOU: lançou conta para entregador de OUTRA empresa';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF SQLERRM LIKE 'FALHOU:%' THEN RAISE; END IF;
    RAISE NOTICE 'ok  entregador fora do escopo recusado: %', SQLERRM;
  END;

  -- 5. Busca: acha por nome, respeita o mínimo de 3 caracteres.
  SELECT count(*) INTO v_achados FROM hub_entregador_buscar('Zarabatana');
  ASSERT v_achados >= 1, 'a busca devia achar o entregador pelo nome';
  SELECT count(*) INTO v_achados FROM hub_entregador_buscar('Za');
  ASSERT v_achados = 0, 'busca com menos de 3 caracteres devia devolver vazio';
  RAISE NOTICE 'ok  busca por nome, com piso de 3 caracteres';

  -- 6. A busca NÃO devolve documento completo.
  ASSERT NOT EXISTS (
    SELECT 1 FROM hub_entregador_buscar('Zarabatana') b WHERE b.documento_mascarado ~ '^[0-9]{14}$'
  ), 'a busca não pode devolver o CNPJ inteiro';
  RAISE NOTICE 'ok  documento mascarado na busca';
END $$;

-- 7. Sem permissão, as duas funções recusam.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claims', '{"sub":"999999","empresa_ativa":"9001","escopo":[9001]}', true);
  BEGIN
    PERFORM hub_entregador_buscar('Zarabatana');
    RAISE EXCEPTION 'FALHOU: busca aceitou usuário sem adiantamentos.contas_revisar';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF SQLERRM LIKE 'FALHOU:%' THEN RAISE; END IF;
    RAISE NOTICE 'ok  busca sem permissão: %', SQLERRM;
  END;
END $$;
