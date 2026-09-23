-- Confere o rollback da 0090: as funções voltam ao formato anterior e o
-- extrato entrega os MESMOS números do retrato de antes da migration.
-- Roda depois de `0090-antes.sql` + migration + `0090-rollback.sql`.
\set ON_ERROR_STOP on
DO $$
DECLARE r_a record; r_d record;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"motorista_cnpj":"89000000000190","escopo":[6]}', true);
  SELECT * INTO r_a FROM f3_extrato_antes;
  SELECT * INTO r_d FROM hub_adiantamento_extrato_motorista();
  ASSERT r_d.total = r_a.total, format('rollback mudou o total: %s -> %s', r_a.total, r_d.total);
  ASSERT r_d.dias = r_a.dias, 'rollback mudou o detalhe dos dias';
  ASSERT (SELECT count(*) FROM pg_proc WHERE proname = 'hub_adiantamento_extrato_motorista'
          AND prosrc LIKE '%total_nota%') = 0, 'a funcao ainda tem a divisao depois do rollback';
  RAISE NOTICE 'ok  rollback: extrato de volta ao formato da 0089, total=%', r_d.total;
  -- Dropar a coluna apagaria a configuração de quem já marcou — o rollback
  -- deixa ela viva de propósito.
  ASSERT (SELECT count(*) FROM information_schema.columns
          WHERE table_name = 'AdiantamentoConfiguracao' AND column_name = 'categorias_nota') = 1,
    'a coluna tem de sobreviver ao rollback';
  RAISE NOTICE 'ok  rollback: a coluna categorias_nota sobrevive (inocua, ninguem le)';
END $$;
