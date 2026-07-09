-- 0033 — Schema LEGADO (Empresa/Grupo/EnvioMassa/ProcessControl/Motorista)
-- dentro do banco ISOLADO do hub (hub_homolog / hub_test_*), exclusivamente
-- nos recursos hub-* (exceção standing G1, CLAUDE.md). NUNCA aplicar em
-- produção/chatmasterveloz — essas tabelas já existem lá, criadas fora
-- desta série de migrations, há anos; aqui só recriamos um espelho mínimo
-- e sintético para o backend legado (server.js/routes/grupo.js/routes/
-- motorista.js), reidratado via Dockerfile.hub, conseguir rodar dentro do
-- hub isolado.
--
-- Contexto (dec-033/dec-034/dec-036 do state.json de hub-envio-massa):
-- nenhuma migration 0000-0032 cria essas tabelas (todas criam schema
-- hub-nativo: Usuario/Papel/Permissao/Entregador/ImportacaoArquivo/
-- FaturamentoLancamento/PerformanceTurno/ContaMotorista/EmpresaGrupoMovee).
-- O container hub_*_backend builda a MESMA árvore app_homologacao/backend
-- (Dockerfile.hub) — inclui as 11 rotas legadas de server.js, que fazem
-- postgrestRequest('Empresa'/'Grupo'/'EnvioMassa'/'ProcessControl'/
-- 'Motorista', ...) contra o banco do hub. Sem essas tabelas, FASE 6 (E2E)
-- e a tarefa 2.2.9 (medição do toggle HUB_RBAC_ENVIO numa rota viva) não
-- são executáveis. Operador autorizou explicitamente via AskUserQuestion
-- (Opção A, dec-034) esta migration DDL-only idempotente/aditiva.
--
-- Schema extraído por evidência empírica (NÃO inventado), cruzando:
--   - DDL real já existente no repo para as mesmas tabelas de produção:
--     app_homologacao/backend/db/001_create_motorista.sql (Motorista base)
--     app_homologacao/backend/db/008_cadastro_motorista_base.sql (senha nullable)
--     app_homologacao/backend/db/003_empresa_nota_fields.sql (Empresa: endereco/
--       numero/cep/email_nota/observacao)
--     app_homologacao/backend/db/009_envio_massa_gorjeta.sql (EnvioMassa.gorjeta
--       DOUBLE PRECISION — mesmo tipo de EnvioMassa.valor)
--     docs/sql/001-config-ui-tenant-schema.sql (Grupo: id/nome/id_empresa_pai/
--       created_at/updated_at; Empresa.id_grupo)
--     docs/sql/004-cadastro-filiais-cnpj.sql (Empresa.cnpj UNIQUE)
--     docs/sql/007-corte-modulo-c-login-unico-flag.sql (Grupo.login_unico_ativo)
--   - Uso real no código (grep de `select=`/corpo de INSERT/PATCH):
--     server.js:1903 (SELECT * explícito de EnvioMassa — lista de colunas
--       completa usada por /export-envio-massa), server.js:1762-1783
--       (dataToInsert do /upload), server.js:1248-1276 (ProcessControl),
--       server.js:261/2565/2576 (Empresa.email/pass/nome_empresa),
--       routes/grupo.js:465 (SELECT explícito de Empresa com todas as
--       colunas fiscais).
--
-- Idempotente (CREATE TABLE IF NOT EXISTS) e aditiva (nenhum ALTER/DROP em
-- tabela hub-nativa existente; EmpresaGrupoMovee/ContaMotorista não são
-- tocadas — são entidades hub-nativas distintas, não um alias destas).
--
-- Sem BEGIN/COMMIT explícito: migrate.sh já aplica cada arquivo dentro de
-- uma única transação via `psql -1` (mesmo padrão de todas as migrations
-- 0000-0032 desta série — BEGIN/COMMIT explícito aqui geraria transação
-- aninhada e o COMMIT interno fecharia a transação externa cedo demais).

-- ---------------------------------------------------------------------------
-- 1. "Grupo" — holding de CNPJs (docs/sql/001 + docs/sql/007)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "Grupo" (
  id                 bigserial     PRIMARY KEY,
  nome               text          NOT NULL,
  id_empresa_pai     bigint        NOT NULL,
  login_unico_ativo  boolean       NOT NULL DEFAULT false,
  created_at         timestamptz   NOT NULL DEFAULT now(),
  updated_at         timestamptz   NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2. "Empresa" — tenant legado (login painel legado + escopo de EnvioMassa)
--    Colunas base (email/pass/nome_empresa) inferidas do fluxo /login e
--    /register (server.js:261-320, 2560-2591); demais colunas confirmadas
--    por DDL real (003/004/001-config-ui-tenant-schema).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "Empresa" (
  id            bigserial     PRIMARY KEY,
  nome_empresa  text          NOT NULL,
  email         text          NOT NULL,
  pass          text,
  cnpj          text,
  id_grupo      bigint        REFERENCES "Grupo"(id),
  endereco      text,
  numero        text,
  cep           text,
  email_nota    text,
  observacao    text,
  created_at    timestamptz   NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'empresa_email_unique_legado'
  ) THEN
    ALTER TABLE "Empresa" ADD CONSTRAINT empresa_email_unique_legado UNIQUE (email);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'empresa_cnpj_unique_legado'
  ) THEN
    ALTER TABLE "Empresa" ADD CONSTRAINT empresa_cnpj_unique_legado UNIQUE (cnpj);
  END IF;
END$$;

-- FK de Grupo.id_empresa_pai -> Empresa(id), adicionada depois de ambas
-- existirem (evita problema de ordem de criação nas duas CREATE TABLE acima).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'grupo_id_empresa_pai_fkey_legado'
  ) THEN
    ALTER TABLE "Grupo"
      ADD CONSTRAINT grupo_id_empresa_pai_fkey_legado
      FOREIGN KEY (id_empresa_pai) REFERENCES "Empresa"(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'grupo_id_empresa_pai_unique_legado'
  ) THEN
    ALTER TABLE "Grupo"
      ADD CONSTRAINT grupo_id_empresa_pai_unique_legado UNIQUE (id_empresa_pai);
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_empresa_id_grupo_legado ON "Empresa"(id_grupo);

-- ---------------------------------------------------------------------------
-- 3. "EnvioMassa" — movimento de envio em massa. Lista de colunas = a lista
--    explícita usada em server.js:1903 (SELECT completo, /export-envio-massa)
--    + server.js:1762-1783 (INSERT do /upload) + 009_envio_massa_gorjeta.sql
--    (gorjeta DOUBLE PRECISION, mesmo tipo de valor).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "EnvioMassa" (
  id                    bigserial      PRIMARY KEY,
  created_at            timestamptz    NOT NULL DEFAULT now(),
  number                text,
  nome                  text,
  cnpj_prestador        text,
  cnpj_tomador          text,
  valor                 double precision,
  gorjeta               double precision DEFAULT NULL,
  mensagem1             text,
  mensagem2             text,
  enviado               text           DEFAULT 'off',
  retorno_envio_msg_1   text,
  retorno_envio_msg_2   text,
  tribnac               text,
  "dCompet"             text,
  numnota               text,
  nota_ok               text,
  data_emissao          text,
  erro_validacao        text,
  "dataEnvio"           timestamptz,
  id_empresa            bigint         REFERENCES "Empresa"(id),
  uuid                  text,
  mov_fechado           boolean        NOT NULL DEFAULT false,
  dt_inicial            timestamptz,
  dt_final              timestamptz
);

CREATE INDEX IF NOT EXISTS idx_enviomassa_id_empresa_legado ON "EnvioMassa"(id_empresa);
CREATE INDEX IF NOT EXISTS idx_enviomassa_mov_fechado_legado ON "EnvioMassa"(mov_fechado);
CREATE INDEX IF NOT EXISTS idx_enviomassa_cnpj_prestador_legado ON "EnvioMassa"(cnpj_prestador);

-- ---------------------------------------------------------------------------
-- 4. "ProcessControl" — status do job de envio em lote (server.js:1247-1281).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "ProcessControl" (
  id            bigserial    PRIMARY KEY,
  user_id       bigint       NOT NULL,
  status        text         NOT NULL,
  execution_id  text,
  "timestamp"   timestamptz  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_processcontrol_user_id_legado ON "ProcessControl"(user_id);

-- ---------------------------------------------------------------------------
-- 5. "Motorista" — base curada de login do App Motorista (espelho EXATO do
--    DDL real de produção: db/001_create_motorista.sql + db/008 senha
--    nullable). Exclusiva do grupo Movee (CLAUDE.md) — sem coluna de
--    empresa, propositalmente.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "Motorista" (
  id             bigserial    PRIMARY KEY,
  cnpj_prestador text         UNIQUE NOT NULL,
  senha          text,
  nome           text,
  ativo          boolean      NOT NULL DEFAULT true,
  created_at     timestamptz  NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 6. GRANTs para o role do PostgREST do hub (mesmo padrão de
--    docs/sql/001-config-ui-tenant-schema.sql §4.5 — sem isto toda query
--    nas tabelas novas retorna 42501 "permission denied").
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "Grupo"          TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Empresa"        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON "EnvioMassa"     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON "ProcessControl" TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Motorista"      TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE "Grupo_id_seq"          TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE "Empresa_id_seq"        TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE "EnvioMassa_id_seq"     TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE "ProcessControl_id_seq" TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE "Motorista_id_seq"      TO authenticated;

-- Recarregar o schema do PostgREST do hub (mesmo padrão de todas as
-- migrations anteriores — migrate.sh já envia SIGUSR1 após aplicar).
NOTIFY pgrst, 'reload schema';
