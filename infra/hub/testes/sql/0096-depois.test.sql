-- Parte 2: asserções DEPOIS da migration.
\set ON_ERROR_STOP on
DO $$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM _ctx;

  -- 1. backfill preenche E normaliza (maiúsculas e espaços do enriquecimento)
  ASSERT (SELECT email FROM "ContaMotorista" WHERE id = c.c_backfill) = 'backfill.teste@exemplo.com',
    format('esperava e-mail normalizado, veio %s', (SELECT email FROM "ContaMotorista" WHERE id = c.c_backfill));
  ASSERT (SELECT email_origem FROM "ContaMotorista" WHERE id = c.c_backfill) = 'entrego',
    'o backfill tem de registrar a origem entrego';
  RAISE NOTICE 'ok  backfill: preenche e normaliza (minúsculas, sem espaços)';

  -- 2. o backfill alcançou a segunda conta (origem entrego)
  ASSERT (SELECT email_origem FROM "ContaMotorista" WHERE id = c.c_ja_hub) = 'entrego',
    'a conta (b) devia ter recebido o e-mail do enriquecimento';
  RAISE NOTICE 'ok  backfill alcança quem tem enriquecimento';

  -- 3. sem enriquecimento, segue nulo (não inventa)
  ASSERT (SELECT email FROM "ContaMotorista" WHERE id = c.c_sem_dados) IS NULL,
    'conta sem enriquecimento não pode ganhar e-mail do nada';
  RAISE NOTICE 'ok  sem enriquecimento: segue sem e-mail';
END $$;

-- 4. O gatilho protege o e-mail do hub contra escrita do enriquecimento.
DO $$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM _ctx;
  -- o hub assume o cadastro deste motorista
  UPDATE "ContaMotorista" SET email = 'digitado.no.hub@exemplo.com', email_origem = 'hub'
   WHERE id = c.c_ja_hub;
  -- e agora o enriquecimento tenta sobrescrever
  UPDATE "ContaMotorista" SET email = 'tentativa.entrego@exemplo.com', email_origem = 'entrego'
   WHERE id = c.c_ja_hub;
  ASSERT (SELECT email FROM "ContaMotorista" WHERE id = c.c_ja_hub) = 'digitado.no.hub@exemplo.com',
    'o gatilho deixou o enriquecimento sobrescrever e-mail do hub';
  RAISE NOTICE 'ok  gatilho: enriquecimento não vence o hub';

  -- mas o HUB pode corrigir o que ele mesmo gravou
  UPDATE "ContaMotorista" SET email = 'Novo.Do.Hub@Exemplo.com', email_origem = 'hub' WHERE id = c.c_ja_hub;
  ASSERT (SELECT email FROM "ContaMotorista" WHERE id = c.c_ja_hub) = 'novo.do.hub@exemplo.com',
    'o hub tem de conseguir corrigir o próprio e-mail, já normalizado';
  RAISE NOTICE 'ok  gatilho: o hub edita o próprio e-mail (e normaliza)';

  -- e o enriquecimento PODE atualizar o que veio dele mesmo
  UPDATE "ContaMotorista" SET email = 'atualizado@exemplo.com', email_origem = 'entrego'
   WHERE id = c.c_backfill;
  ASSERT (SELECT email FROM "ContaMotorista" WHERE id = c.c_backfill) = 'atualizado@exemplo.com',
    'enriquecimento novo deve poder atualizar e-mail de origem entrego';
  RAISE NOTICE 'ok  gatilho: enriquecimento atualiza o que é dele';
END $$;

-- 5. O CHECK recusa e-mail inválido — a recuperação de senha depende dele.
DO $$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM _ctx;
  BEGIN
    UPDATE "ContaMotorista" SET email = 'sem-arroba', email_origem = 'hub' WHERE id = c.c_sem_dados;
    RAISE EXCEPTION 'FALHOU: o CHECK aceitou e-mail sem @';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'ok  CHECK recusa e-mail inválido';
  END;
END $$;

-- 6. Idempotente: reaplicar o backfill não altera nada.
DO $$
DECLARE c record; v_antes text;
BEGIN
  SELECT * INTO c FROM _ctx;
  SELECT email INTO v_antes FROM "ContaMotorista" WHERE id = c.c_ja_hub;
  UPDATE "ContaMotorista" cm SET email = lower(trim(e.email)), email_origem = 'entrego'
    FROM (SELECT motorista_id, trim(dados_entrego_json -> 'dadosPessoais' ->> 'email') AS email
            FROM "Entregador" WHERE motorista_id IS NOT NULL
             AND trim(dados_entrego_json -> 'dadosPessoais' ->> 'email') ~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$') e
   WHERE cm.id = e.motorista_id AND cm.email IS NULL;
  ASSERT (SELECT email FROM "ContaMotorista" WHERE id = c.c_ja_hub) = v_antes,
    'reaplicar o backfill alterou e-mail existente';
  RAISE NOTICE 'ok  idempotente: reaplicar não altera e-mail existente';
END $$;
