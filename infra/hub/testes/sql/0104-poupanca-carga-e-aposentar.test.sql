-- Teste da 0104 — a trava de poupança vale para conta VIVA, não para conta morta.
-- Roda DENTRO de uma transação que termina em ROLLBACK (ver o driver ao lado).
-- Dados sintéticos; repositório público.
\set ON_ERROR_STOP on

DO $$
DECLARE
  v_emp int := 9001;
  e_alvo int; v_id bigint;
BEGIN
  INSERT INTO "Entregador" (id_empresa, id_externo, nome, ativo)
  VALUES (v_emp, gen_random_uuid(), 'Poupanca Teste 0104', true) RETURNING id INTO e_alvo;

  -- 1. poupança NOVA pelo app continua recusada (a regra de 05/10 segue de pé)
  BEGIN
    INSERT INTO "ContaBancariaMotorista" (id_empresa, entregador_id, origem, status, titular_nome,
      titular_documento, titular_tipo, banco_codigo, banco_nome, agencia, conta, conta_digito, tipo_conta)
    VALUES (v_emp, e_alvo, 'APP', 'PENDENTE', 'T', '11222333000181', 'PJ', '001', 'BB', '1234', '5678', '9', 'POUPANCA');
    RAISE EXCEPTION 'FALHOU: poupança por APP foi aceita';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'ok  poupança por APP recusada';
  END;

  -- 2. poupança por HUB também: a porta das exceções é para PF, não para poupança
  BEGIN
    INSERT INTO "ContaBancariaMotorista" (id_empresa, entregador_id, origem, status, titular_nome,
      titular_documento, titular_tipo, banco_codigo, banco_nome, agencia, conta, conta_digito, tipo_conta,
      entregador_confirmado_id)
    VALUES (v_emp, e_alvo, 'HUB', 'APROVADA', 'T', '11222333000181', 'PJ', '001', 'BB', '1234', '5678', '9', 'POUPANCA', e_alvo);
    RAISE EXCEPTION 'FALHOU: poupança por HUB foi aceita';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'ok  poupança por HUB recusada';
  END;

  -- 3. poupança pela CARGA_INICIAL entra (exceção pedida pelo operador)
  INSERT INTO "ContaBancariaMotorista" (id_empresa, entregador_id, origem, status, titular_nome,
    titular_documento, titular_tipo, banco_codigo, banco_nome, agencia, conta, conta_digito, tipo_conta,
    entregador_confirmado_id)
  VALUES (v_emp, e_alvo, 'CARGA_INICIAL', 'APROVADA', 'T', '11222333000181', 'PJ', '001', 'BB', '1234', '5678', '9', 'POUPANCA', e_alvo)
  RETURNING id INTO v_id;
  RAISE NOTICE 'ok  poupança por CARGA_INICIAL entrou';

  -- 4. O BUG DA 0103: poupança existente não podia ser aposentada. Tirar uma
  --    conta poupança de circulação é o objetivo da regra, não a violação dela.
  UPDATE "ContaBancariaMotorista" SET status = 'SUBSTITUIDA' WHERE id = v_id;
  ASSERT (SELECT status FROM "ContaBancariaMotorista" WHERE id = v_id) = 'SUBSTITUIDA',
    'poupança precisa poder ser aposentada';
  RAISE NOTICE 'ok  poupança pode ser SUBSTITUIDA';

  UPDATE "ContaBancariaMotorista" SET status = 'CANCELADA' WHERE id = v_id;
  RAISE NOTICE 'ok  poupança pode ser CANCELADA';

  -- 4b. O CASO REAL DO BUG: conta poupança de origem APP, gravada ANTES da
  --     0103, que o operador precisa cancelar ou rejeitar. É essa linha que
  --     travava — a de CARGA_INICIAL acima é isenta pela outra cláusula, então
  --     sozinha ela não prova nada (o controle negativo mostrou isso).
  DECLARE v_legado bigint; v_def text;
  BEGIN
    -- captura a definição VIGENTE e recria igual: hardcodar o CHECK aqui faria
    -- o controle negativo do driver não ter efeito (foi o que aconteceu).
    SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
     WHERE conname = 'contabancariamotorista_sem_poupanca_chk'
       AND conrelid = '"ContaBancariaMotorista"'::regclass;
    ALTER TABLE "ContaBancariaMotorista" DROP CONSTRAINT contabancariamotorista_sem_poupanca_chk;
    INSERT INTO "ContaBancariaMotorista" (id_empresa, entregador_id, origem, status, titular_nome,
      titular_documento, titular_tipo, banco_codigo, banco_nome, agencia, conta, conta_digito, tipo_conta)
    VALUES (v_emp, e_alvo, 'APP', 'PENDENTE', 'Legado', '11222333000181', 'PJ', '104', 'CAIXA', '4051', '849346862', '0', 'POUPANCA')
    RETURNING id INTO v_legado;
    EXECUTE format('ALTER TABLE "ContaBancariaMotorista" ADD CONSTRAINT contabancariamotorista_sem_poupanca_chk %s', v_def);

    UPDATE "ContaBancariaMotorista" SET status = 'CANCELADA' WHERE id = v_legado;
    ASSERT (SELECT status FROM "ContaBancariaMotorista" WHERE id = v_legado) = 'CANCELADA',
      'poupança APP antiga precisa poder ser cancelada — era o bug da 0103';
    RAISE NOTICE 'ok  poupança APP legada pode ser cancelada (o bug de fato)';
  END;

  -- 5. e NÃO pode voltar a valer: de morta para viva, a trava age de novo
  BEGIN
    UPDATE "ContaBancariaMotorista" SET status = 'APROVADA' WHERE id = v_id AND origem <> 'CARGA_INICIAL';
    -- a linha é CARGA_INICIAL, então o UPDATE acima não casa; força o caso real:
    UPDATE "ContaBancariaMotorista" SET origem = 'APP', status = 'APROVADA' WHERE id = v_id;
    RAISE EXCEPTION 'FALHOU: poupança morta voltou a valer por uma porta proibida';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'ok  poupança não ressuscita por porta proibida';
  END;
END $$;
