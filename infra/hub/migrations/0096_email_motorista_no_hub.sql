-- 0096 — o e-mail do motorista passa a ser CADASTRO do hub.
--
-- PRINCÍPIO (operador, 2026-09-24): "o cadastro do hub deve ser parte do
-- cadastro do motorista, e os seus dados devem morar no hub". O e-mail existia
-- só dentro de `Entregador.dados_entrego_json -> dadosPessoais -> email`, que é
-- cópia de terceiro (portal EntreGô), não cadastro: ninguém consegue editar, e
-- o próximo enriquecimento sobrescreve sem avisar.
--
-- COBERTURA MEDIDA em produção (2026-09-24), empresa 6:
--   1.380 entregadores enriquecidos · 1.380 com e-mail em formato válido (100%)
--   1.214 com e-mail E conta no hub · **0 e-mails repetidos** entre motoristas
-- Zero duplicata é o que torna isto seguro para recuperação de senha: cada
-- e-mail aponta para um motorista só, então não há risco de mandar o código de
-- recuperação para a caixa de outra pessoa.
--
-- PRECEDÊNCIA — o mesmo mecanismo que a 0019/0025 já usa para
-- `Entregador.nome`: dado editado no hub NÃO é sobrescrito pela fonte externa.
-- Aqui em vez de um booleano guarda-se a ORIGEM, porque três fontes disputam o
-- cadastro do motorista (hub, EnvioMassa e EntreGô) e "mexeram nisto" não diz o
-- suficiente — é preciso saber DE ONDE veio para decidir sem adivinhar.
--
--   email_origem = 'hub'     -> alguém digitou no hub. Vence sempre.
--   email_origem = 'entrego' -> veio do enriquecimento. Pode ser atualizado
--                               por um enriquecimento novo.
--
-- ROLLBACK: infra/hub/testes/sql/0096-rollback.sql — dropa o gatilho. A coluna
-- e os dados FICAM: e-mail digitado por gente é cadastro, e apagá-lo perderia
-- o que ninguém mais tem.

-- 1. As colunas. Aditivas e nulas.
ALTER TABLE "ContaMotorista" ADD COLUMN IF NOT EXISTS email        text;
ALTER TABLE "ContaMotorista" ADD COLUMN IF NOT EXISTS email_origem text;

COMMENT ON COLUMN "ContaMotorista".email IS
  'E-mail do motorista, sempre em minúsculas e sem espaços. Cadastro do hub — ver email_origem.';
COMMENT ON COLUMN "ContaMotorista".email_origem IS
  '"hub" (digitado por alguém; vence o enriquecimento) ou "entrego" (veio de dados_entrego_json).';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contamotorista_email_origem_valida') THEN
    ALTER TABLE "ContaMotorista" ADD CONSTRAINT contamotorista_email_origem_valida
      CHECK (email_origem IS NULL OR email_origem IN ('hub', 'entrego'));
  END IF;
  -- Formato conferido no banco: e-mail inválido não pode entrar por caminho
  -- nenhum, porque dele depende a recuperação de senha.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contamotorista_email_plausivel') THEN
    ALTER TABLE "ContaMotorista" ADD CONSTRAINT contamotorista_email_plausivel
      CHECK (email IS NULL OR email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$');
  END IF;
END $$;

-- 2. Precedência: o que foi digitado no hub não é sobrescrito pelo
--    enriquecimento. Mesmo idioma de hub_protege_nome_editado_entregador.
CREATE OR REPLACE FUNCTION hub_protege_email_motorista()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    -- Só protege contra escrita vinda do enriquecimento. Quem grava com
    -- origem 'hub' está justamente exercendo a precedência.
    IF OLD.email_origem = 'hub' AND NEW.email_origem IS DISTINCT FROM 'hub' THEN
        NEW.email        := OLD.email;
        NEW.email_origem := OLD.email_origem;
    END IF;
    -- Normaliza sempre: e-mail é comparado por igualdade na recuperação de
    -- senha, e "Fulano@X.com" nunca casaria com "fulano@x.com".
    IF NEW.email IS NOT NULL THEN
        NEW.email := lower(trim(NEW.email));
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_contamotorista_protege_email ON "ContaMotorista";
CREATE TRIGGER trg_contamotorista_protege_email
    BEFORE UPDATE ON "ContaMotorista"
    FOR EACH ROW EXECUTE FUNCTION hub_protege_email_motorista();

-- Normalização também na criação (o gatilho de UPDATE não cobre INSERT).
CREATE OR REPLACE FUNCTION hub_normaliza_email_motorista_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.email IS NOT NULL THEN
        NEW.email := lower(trim(NEW.email));
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_contamotorista_normaliza_email ON "ContaMotorista";
CREATE TRIGGER trg_contamotorista_normaliza_email
    BEFORE INSERT ON "ContaMotorista"
    FOR EACH ROW EXECUTE FUNCTION hub_normaliza_email_motorista_insert();

-- 3. Backfill do enriquecimento. Só preenche quem está NULO — reaplicar não
--    desfaz correção feita pelo hub. 12 dos 1.380 precisavam de normalização.
UPDATE "ContaMotorista" cm
   SET email = lower(trim(e.email)), email_origem = 'entrego'
  FROM (
    -- ⚠️ O regex roda sobre o valor JÁ com trim: 12 dos 1.380 e-mails vêm do
    -- portal com espaços ou maiúsculas, e testá-los crus os EXCLUIRIA do
    -- backfill em vez de normalizá-los.
    SELECT motorista_id, trim(dados_entrego_json -> 'dadosPessoais' ->> 'email') AS email
      FROM "Entregador"
     WHERE motorista_id IS NOT NULL
       AND trim(dados_entrego_json -> 'dadosPessoais' ->> 'email') ~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$'
  ) e
 WHERE cm.id = e.motorista_id AND cm.email IS NULL;
