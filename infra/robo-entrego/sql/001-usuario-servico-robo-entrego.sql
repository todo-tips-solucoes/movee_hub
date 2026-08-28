-- 001 — Provisionamento do usuário de serviço do robô EntreGô (tasks.md
-- FASE 2, 2.2.1; data-model.md §Entity: Identidade de Serviço do Hub).
--
-- ⚠️ ARTEFATO PARA O OPERADOR APLICAR MANUALMENTE — esta pipeline (SDD
-- feature-00c) NUNCA executa este script contra o banco vivo (rito de
-- produção do projeto, CLAUDE.md). Roda contra o schema já provisionado
-- pelas migrations de infra/hub/migrations/ (0002_usuario.sql,
-- 0003_papel_permissao_modulo.sql) — não é uma migration numerada da série
-- do hub, é um script avulso de dados.
--
-- Uso (psql interpola `:'nome'` como literal SQL — não envolva o valor em
-- aspas extras no `-v`):
--   psql "$DATABASE_URL" \
--     -v email_servico='robo-entrego@moveelog.local' \
--     -v senha_servico='<senha forte gerada para o usuário de serviço>' \
--     -f infra/robo-entrego/sql/001-usuario-servico-robo-entrego.sql
--
-- ⚠️ CORREÇÃO EMPÍRICA (task 6.2, roundtrip real contra hub-homolog,
-- 2026-08-28): a versão anterior deste script usava `:'email_servico'`/
-- `:'senha_servico'` DIRETO dentro do corpo `DO $$ ... $$` — psql NÃO
-- interpola variáveis `-v` dentro de string dollar-quoted (limitação
-- documentada do próprio psql, reproduzida com `psql (PostgreSQL) 13.23`:
-- `ERROR: syntax error at or near ":"` sempre que o script rodava, mesmo
-- com `-v` corretos). Nunca havia sido executado de fato antes desta
-- rodada. Corrigido injetando os valores via `set_config()` (GUC de
-- sessão, `is_local=false`) ANTES do bloco `DO $$`, que o corpo lê com
-- `current_setting()` — evita reintroduzir o mesmo bug em qualquer futuro
-- script análogo (`infra/hub/migrations/*` não usa este padrão porque não
-- tem `DO $$` com parâmetro externo).
--
-- A senha NUNCA é embutida neste arquivo em texto plano nem versionada — o
-- operador a passa via `-v` no momento da execução, e o hash bcrypt
-- (compatível com bcrypt.compare do backend, mesmo formato $2a$/$2b$) é
-- calculado no próprio banco via pgcrypto (mesmo padrão já usado em
-- infra/hub/migrations/0034_seed_legado_envio_massa_teste.sql). Depois de
-- aplicar, grave a senha em texto plano APENAS em
-- /var/lib/hub_secrets/robo-entrego/.env (HUB_SERVICO_EMAIL/HUB_SERVICO_SENHA
-- — ver .env.robo-entrego.example), nunca no git.
--
-- Idempotente: reexecutar com o mesmo email é um no-op sobre Usuario/
-- UsuarioEntidade (ON CONFLICT DO NOTHING) — não atualiza senha de uma conta
-- já existente (rotação de senha é um UPDATE manual à parte, fora deste
-- script).
--
-- Permissão concedida: SOMENTE `importacoes.criar` (upload,
-- POST /api/v1/importacoes) e `importacoes.consultar` (necessária para o
-- polling em GET /api/v1/importacoes/:id — hub-client.js tarefa 3.3.4;
-- routes/hub-importacoes.js:400/463 exigem essa permissão na rota GET) —
-- restrita a id_empresa = 6 (HUB_ID_EMPRESA, block-002). Least privilege: um
-- papel dedicado NOVO (`robo_entrego_servico`), não o papel `operador`
-- existente (que também concede motoristas.criar/editar, envio_massa.enviar
-- etc. — escopo maior do que este robô precisa).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Ponte -v -> GUC de sessão: `:'var'` interpola aqui (fora de dollar-quote),
-- o corpo DO $$ abaixo lê via current_setting() — ver nota de correção acima.
SELECT set_config('robo_entrego.email_servico', :'email_servico', false);
SELECT set_config('robo_entrego.senha_servico', :'senha_servico', false);

DO $$
DECLARE
  _email        citext := current_setting('robo_entrego.email_servico');
  _senha        text   := current_setting('robo_entrego.senha_servico');
  _id_empresa   int    := 6; -- HUB_ID_EMPRESA (block-002) — grupo Movee
  _papel_id     int;
  _usuario_id   int;
BEGIN
  IF _email IS NULL OR _email = '' THEN
    RAISE EXCEPTION '001: -v email_servico não informado';
  END IF;
  IF _senha IS NULL OR _senha = '' THEN
    RAISE EXCEPTION '001: -v senha_servico não informado';
  END IF;

  -- Papel dedicado, escopo entidade, NÃO is_sistema (pode ser removido/
  -- ajustado sem tocar nos 4 papéis-seed protegidos de 0007).
  INSERT INTO "Papel" (nome, escopo, is_sistema)
  VALUES ('robo_entrego_servico', 'entidade', false)
  ON CONFLICT (nome) DO NOTHING;

  SELECT id INTO _papel_id FROM "Papel" WHERE nome = 'robo_entrego_servico';

  INSERT INTO "PapelPermissao" (papel_id, permissao_id)
  SELECT _papel_id, perm.id
  FROM "Permissao" perm
  WHERE perm.codigo IN ('importacoes.criar', 'importacoes.consultar')
  ON CONFLICT DO NOTHING;

  -- Usuário de serviço (sem cadastro humano — nome descritivo).
  INSERT INTO "Usuario" (email, senha_hash, nome, ativo, criado_em, criado_por)
  VALUES (_email, crypt(_senha, gen_salt('bf')), 'Robô EntreGô (serviço)', true, now(), NULL)
  ON CONFLICT (email) DO NOTHING;

  SELECT id INTO _usuario_id FROM "Usuario" WHERE email = _email;

  INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo)
  VALUES (_usuario_id, _id_empresa, _papel_id, true)
  ON CONFLICT (usuario_id, empresa_id) DO NOTHING;

  RAISE NOTICE '001: usuario de servico % vinculado a empresa_id=% com papel robo_entrego_servico (importacoes.criar + importacoes.consultar)', _email, _id_empresa;
END
$$;
