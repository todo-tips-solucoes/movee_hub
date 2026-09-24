-- Teste da 0094 (índice em EnvioMassa.cnpj_prestador). Roda dentro de uma
-- transação que termina em ROLLBACK — ver infra/hub/testes/hub-indice-cnpj.sh.
\set ON_ERROR_STOP on

-- 1. O índice existe e é sobre a coluna certa.
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM pg_indexes
           WHERE tablename = 'EnvioMassa' AND indexname = 'idx_envio_massa_cnpj_prestador') = 1,
    'o índice não foi criado';
  ASSERT (SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_envio_massa_cnpj_prestador')
         LIKE '%(cnpj_prestador)%',
    'o índice existe mas não é sobre cnpj_prestador';
  RAISE NOTICE 'ok  índice criado sobre EnvioMassa(cnpj_prestador)';
END $$;

-- 2. Idempotente: reaplicar não duplica nem quebra.
CREATE INDEX IF NOT EXISTS idx_envio_massa_cnpj_prestador ON "EnvioMassa" (cnpj_prestador);
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM pg_indexes
           WHERE tablename = 'EnvioMassa' AND indexname = 'idx_envio_massa_cnpj_prestador') = 1,
    'reaplicar duplicou o índice';
  RAISE NOTICE 'ok  idempotente: reaplicar não duplica';
END $$;

-- 3. O PLANEJADOR usa o índice. Sem isto o teste provaria só que o índice
--    existe — e índice que o planejador ignora não resolve nada. É esta
--    asserção que falha no controle negativo (SEM_MIGRATION=1).
DO $$
DECLARE r record; v_usa_indice boolean := false; v_plano text := '';
BEGIN
  -- Volume suficiente para o planejador preferir índice a seq scan.
  INSERT INTO "EnvioMassa" (cnpj_prestador, nome, mov_fechado)
  SELECT lpad(g::text, 14, '0'), 'Indice Teste ' || g, false FROM generate_series(1, 5000) g;
  ANALYZE "EnvioMassa";

  FOR r IN EXECUTE $q$EXPLAIN SELECT 1 FROM "EnvioMassa" WHERE cnpj_prestador = '00000000001234'$q$
  LOOP
    v_plano := v_plano || r."QUERY PLAN" || ' ';
    IF r."QUERY PLAN" LIKE '%idx_envio_massa_cnpj_prestador%' THEN v_usa_indice := true; END IF;
  END LOOP;

  IF NOT v_usa_indice THEN
    RAISE EXCEPTION 'FALHOU: o planejador NÃO usou o índice. Plano: %', v_plano;
  END IF;
  RAISE NOTICE 'ok  o planejador usa o índice (e não Seq Scan)';
END $$;
