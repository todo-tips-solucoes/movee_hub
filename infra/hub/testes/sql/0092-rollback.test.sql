-- Confere o rollback da 0092: o `fechar` volta ao formato da 0088, e colunas e
-- trilha sobrevivem.
\set ON_ERROR_STOP on
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM pg_proc WHERE proname='hub_adiantamento_repasse_fechar'
          AND prosrc LIKE '%total_nota%') = 0, 'o fechar ainda congela a divisão depois do rollback';
  RAISE NOTICE 'ok  rollback: fechar de volta ao formato da 0088';
  ASSERT (SELECT count(*) FROM information_schema.columns
          WHERE table_name='ApuracaoRepasseItem' AND column_name IN ('valor_nota','valor_fora_nota')) = 2,
    'as colunas congeladas têm de sobreviver';
  ASSERT (SELECT count(*) FROM information_schema.tables
          WHERE table_name='ApuracaoRepasseMovimento') = 1,
    'a trilha da geração tem de sobreviver (é ela que impede duplicar)';
  RAISE NOTICE 'ok  rollback: colunas congeladas e trilha preservadas';
END $$;
