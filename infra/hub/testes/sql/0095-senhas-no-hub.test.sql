-- Teste da 0095 (senhas do legado -> hub + CNPJ normalizado). Roda dentro de
-- uma transação que termina em ROLLBACK — ver infra/hub/testes/hub-senhas-no-hub.sh.
-- Dados sintéticos: CNPJ, nome e hashes inventados (repositório público).
\set ON_ERROR_STOP on

DO $$
DECLARE
  c_migra int; c_ja_tem int; c_sem_legado int; c_pontuado int;
  v_hash_legado text := '$2b$10$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  v_hash_hub    text := '$2b$10$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
BEGIN
  -- (a) conta do hub SEM senha, com legado que TEM senha -> deve migrar
  INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('91000000000101', 'Migra Teste') RETURNING id INTO c_migra;
  INSERT INTO "Motorista" (cnpj_prestador, nome, senha, ativo) VALUES ('91000000000101', 'Migra Teste', v_hash_legado, true);

  -- (b) conta do hub que JÁ TEM senha -> NÃO pode ser sobrescrita
  INSERT INTO "ContaMotorista" (cnpj_prestador, nome, senha) VALUES ('91000000000102', 'Ja Tem', v_hash_hub) RETURNING id INTO c_ja_tem;
  INSERT INTO "Motorista" (cnpj_prestador, nome, senha, ativo) VALUES ('91000000000102', 'Ja Tem', v_hash_legado, true);

  -- (c) conta do hub sem correspondente no legado -> continua sem senha
  INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('91000000000103', 'Sem Legado') RETURNING id INTO c_sem_legado;

  -- (d) conta com CNPJ PONTUADO (o defeito da 0093): normaliza E migra
  INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('91.000.000/0001-04', 'Pontuado') RETURNING id INTO c_pontuado;
  INSERT INTO "Motorista" (cnpj_prestador, nome, senha, ativo) VALUES ('91000000000104', 'Pontuado', v_hash_legado, true);

  CREATE TEMP TABLE _ctx AS SELECT c_migra, c_ja_tem, c_sem_legado, c_pontuado, v_hash_legado, v_hash_hub;
  RAISE NOTICE 'fixture: contas %, %, %, %', c_migra, c_ja_tem, c_sem_legado, c_pontuado;
END $$;
