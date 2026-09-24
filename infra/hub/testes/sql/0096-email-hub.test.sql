-- Teste da 0096 (e-mail como cadastro do hub). Roda dentro de uma transação
-- que termina em ROLLBACK — ver infra/hub/testes/hub-email-motorista.sh.
-- Dados sintéticos: CNPJ, nome e e-mail inventados (repositório público).
\set ON_ERROR_STOP on

DO $$
DECLARE c_backfill int; c_ja_hub int; c_sem_dados int; e_backfill int; e_ja_hub int;
BEGIN
  -- (a) conta SEM e-mail + entregador com e-mail no enriquecimento -> backfill
  INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('93000000000101', 'Backfill Teste') RETURNING id INTO c_backfill;
  INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id, dados_entrego_json)
  VALUES (9001, gen_random_uuid(), 'Backfill Teste', c_backfill,
          '{"dadosPessoais": {"email": "  Backfill.Teste@Exemplo.COM  "}}'::jsonb)
  RETURNING id INTO e_backfill;

  -- (b) conta que vai receber e-mail do enriquecimento e depois ser corrigida
  --     pelo hub. (Não dá para nascer com e-mail do hub: a coluna só existe
  --     depois da migration, que é justamente o que este teste aplica.)
  INSERT INTO "ContaMotorista" (cnpj_prestador, nome)
  VALUES ('93000000000102', 'Ja Tem Hub') RETURNING id INTO c_ja_hub;
  INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id, dados_entrego_json)
  VALUES (9001, gen_random_uuid(), 'Ja Tem Hub', c_ja_hub,
          '{"dadosPessoais": {"email": "veio.do.entrego@exemplo.com"}}'::jsonb)
  RETURNING id INTO e_ja_hub;

  -- (c) conta sem enriquecimento nenhum -> segue sem e-mail
  INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('93000000000103', 'Sem Dados') RETURNING id INTO c_sem_dados;

  CREATE TEMP TABLE _ctx AS SELECT c_backfill, c_ja_hub, c_sem_dados;
  RAISE NOTICE 'fixture: contas %, %, %', c_backfill, c_ja_hub, c_sem_dados;
END $$;
