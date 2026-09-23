-- Confere o rollback da 0091: o `salvar` volta ao formato da 0090 e as colunas
-- sobrevivem. Roda depois de `0091-antes.sql` + migration + `0091-rollback.sql`.
\set ON_ERROR_STOP on
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM pg_proc WHERE proname='hub_adiantamento_configuracao_salvar'
          AND prosrc LIKE '%mensagem1_modelo%') = 0,
    'o salvar ainda carrega os moldes depois do rollback';
  RAISE NOTICE 'ok  rollback: salvar de volta ao formato da 0090';
  ASSERT (SELECT count(*) FROM information_schema.columns
          WHERE table_name='ContaMotorista' AND column_name='telefone') = 1,
    'a coluna telefone tem de sobreviver (dropar apagaria dado do hub)';
  ASSERT (SELECT count(*) FROM information_schema.columns
          WHERE table_name='AdiantamentoConfiguracao' AND column_name IN ('mensagem1_modelo','mensagem2_modelo')) = 2,
    'as colunas de molde têm de sobreviver';
  RAISE NOTICE 'ok  rollback: telefone e moldes preservados';
END $$;
