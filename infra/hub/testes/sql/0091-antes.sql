-- Parte 1 de 2 do teste da 0091 (F4-A). Roda ANTES da migration, na mesma
-- transação (driver: infra/hub/testes/hub-telefone-e-moldes.sh).
-- Fixtures sintéticos: CNPJ, nome e telefone inventados (repositório público).
\set ON_ERROR_STOP on

DO $$
DECLARE v_cm_bom int; v_cm_lixo int; v_cm_sem int;
BEGIN
  -- (a) motorista com DOIS telefones no histórico: o backfill tem de pegar o MAIS RECENTE.
  INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('89000000000201', 'Tel Recente') RETURNING id INTO v_cm_bom;
  INSERT INTO "EnvioMassa" (cnpj_prestador, number, created_at)
  VALUES ('89000000000201', '5511900000001', now() - interval '30 days'),
         ('89000000000201', '5511900000002', now() - interval '1 day');

  -- (b) motorista cujo histórico só tem LIXO: não pode herdar nada.
  INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('89000000000202', 'Tel Lixo') RETURNING id INTO v_cm_lixo;
  INSERT INTO "EnvioMassa" (cnpj_prestador, number, created_at)
  VALUES ('89000000000202', '55',            now() - interval '2 days'),
         ('89000000000202', '(11) 9999-8888', now() - interval '1 day');

  -- (c) motorista sem histórico nenhum.
  INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('89000000000203', 'Tel Ausente') RETURNING id INTO v_cm_sem;

  CREATE TEMP TABLE f4_ctx AS SELECT v_cm_bom AS cm_bom, v_cm_lixo AS cm_lixo, v_cm_sem AS cm_sem;
  RAISE NOTICE 'fixture: contas %, %, %', v_cm_bom, v_cm_lixo, v_cm_sem;
END $$;

-- Retrato ANTES: quantas contas reais já têm telefone (tem de ser 0 — a coluna
-- nem existe) e o total de contas, para conferir que o backfill não cria nem
-- apaga linha nenhuma.
CREATE TEMP TABLE f4_antes AS SELECT count(*) AS contas FROM "ContaMotorista";
