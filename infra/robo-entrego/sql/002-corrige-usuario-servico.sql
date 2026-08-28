-- 002 — Corrige/provisiona o usuário de serviço do robô EntreGô.
--
-- ⚠️ ARTEFATO PARA O OPERADOR APLICAR MANUALMENTE. A pipeline nunca executa
-- isto contra banco vivo (rito de produção, CLAUDE.md).
--
-- POR QUE ESTE SCRIPT EXISTE (incidente de 2026-08-28, aplicação do 001 em
-- produção):
--   1. O 001 usava `ON CONFLICT ... DO NOTHING` nos dois INSERTs. Como o
--      e-mail apontado já existia (`automacao@movee.com.br`), NADA foi
--      aplicado: a senha do .env não entrou e o vínculo permaneceu com o
--      papel `operador` (18 permissões, incluindo `envio_massa.enviar` e
--      `motoristas.exportar`) em vez do papel dedicado (2 permissões).
--   2. O `RAISE NOTICE` do 001 afirmava "vinculado com papel
--      robo_entrego_servico" INCONDICIONALMENTE, sem checar se o INSERT fez
--      algo — a saída parecia sucesso enquanto nada acontecera.
--   3. `SELECT set_config(...)` no nível superior ECOA o valor: a senha
--      apareceu em texto claro no terminal.
--
-- O QUE MUDA AQUI:
--   - `DO UPDATE` em vez de `DO NOTHING` — reaplicar CORRIGE em vez de silenciar.
--   - GUARDA anti-sequestro: recusa alterar um usuário que já existe com
--     papel diferente, a menos que `-v permitir_troca_de_papel=sim`.
--     Sem ela, apontar este script para uma conta em uso trocaria a senha e
--     o papel dela, derrubando quem já a usa.
--   - NOTICE honesto: relata o que de fato aconteceu (criado vs atualizado).
--   - `\o /dev/null` em volta dos set_config — a senha não é ecoada.
--
-- Uso:
--   psql ... -v email_servico='robo-entrego@moveelog.local' \
--            -v senha_servico='<senha forte NOVA>' \
--            -v id_empresa=6 \
--            [-v permitir_troca_de_papel=sim] \
--            -f 002-corrige-usuario-servico.sql
--
-- Pré-requisito: o papel `robo_entrego_servico` e as permissões já existem
-- (criados pelo 001, que nessa parte funcionou).

\set ON_ERROR_STOP on

-- Silencia o retorno de set_config para a senha NUNCA aparecer no terminal.
\o /dev/null
SELECT set_config('robo_entrego.email_servico', :'email_servico', false);
SELECT set_config('robo_entrego.senha_servico', :'senha_servico', false);
SELECT set_config('robo_entrego.id_empresa', :'id_empresa', false);
SELECT set_config('robo_entrego.permitir_troca',
                  coalesce(nullif(:'permitir_troca_de_papel', ''), 'nao'), false);
\o

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
DECLARE
  _email        text := current_setting('robo_entrego.email_servico');
  _senha        text := current_setting('robo_entrego.senha_servico');
  _id_empresa   int  := current_setting('robo_entrego.id_empresa')::int;
  _permitir     text := current_setting('robo_entrego.permitir_troca');
  _papel_id     int;
  _usuario_id   int;
  _papel_atual  text;
  _acao_user    text;
  _acao_vinculo text;
BEGIN
  IF _email IS NULL OR length(trim(_email)) = 0 THEN
    RAISE EXCEPTION '002: email_servico vazio';
  END IF;
  IF _senha IS NULL OR length(_senha) < 12 THEN
    RAISE EXCEPTION '002: senha_servico ausente ou com menos de 12 caracteres';
  END IF;

  SELECT id INTO _papel_id FROM "Papel" WHERE nome = 'robo_entrego_servico';
  IF _papel_id IS NULL THEN
    RAISE EXCEPTION '002: papel robo_entrego_servico nao existe — aplique o 001 antes';
  END IF;

  -- ── GUARDA ANTI-SEQUESTRO ────────────────────────────────────────────────
  -- Se o usuário já existe E já tem vínculo nesta entidade com OUTRO papel,
  -- só prossegue com autorização explícita. Protege contra apontar este
  -- script para uma conta em uso e trocar senha/papel dela sem querer.
  SELECT u.id, p.nome INTO _usuario_id, _papel_atual
  FROM "Usuario" u
  LEFT JOIN "UsuarioEntidade" ue ON ue.usuario_id = u.id AND ue.empresa_id = _id_empresa
  LEFT JOIN "Papel" p ON p.id = ue.papel_id
  WHERE u.email = _email;

  IF _papel_atual IS NOT NULL
     AND _papel_atual <> 'robo_entrego_servico'
     AND _permitir <> 'sim' THEN
    RAISE EXCEPTION USING
      MESSAGE = format('002: RECUSADO — %s ja existe na empresa %s com papel "%s". '
                       'Aplicar aqui trocaria a senha E o papel dessa conta, podendo '
                       'derrubar quem ja a usa.', _email, _id_empresa, _papel_atual),
      HINT    = 'Use um e-mail NOVO e exclusivo do robo. Se a troca for mesmo '
                'desejada, repita com -v permitir_troca_de_papel=sim.';
  END IF;

  -- ── usuário: cria ou ATUALIZA a senha ────────────────────────────────────
  INSERT INTO "Usuario" (email, senha_hash, nome, ativo, criado_em, criado_por)
  VALUES (_email, crypt(_senha, gen_salt('bf')), 'Robô EntreGô (serviço)', true, now(), NULL)
  ON CONFLICT (email) DO UPDATE
    SET senha_hash = crypt(_senha, gen_salt('bf')),
        ativo      = true
  RETURNING id, (xmax = 0) INTO _usuario_id, _acao_user;

  _acao_user := CASE WHEN _acao_user::boolean THEN 'criado' ELSE 'atualizado (senha regravada)' END;

  -- ── vínculo: cria ou CORRIGE o papel ─────────────────────────────────────
  INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo)
  VALUES (_usuario_id, _id_empresa, _papel_id, true)
  ON CONFLICT (usuario_id, empresa_id) DO UPDATE
    SET papel_id = EXCLUDED.papel_id,
        ativo    = true
  RETURNING (xmax = 0) INTO _acao_vinculo;

  _acao_vinculo := CASE WHEN _acao_vinculo::boolean THEN 'criado' ELSE 'corrigido' END;

  -- NOTICE que reflete o que REALMENTE aconteceu (lição do 001).
  RAISE NOTICE '002: usuario % (id=%) % ; vinculo na empresa % % para o papel robo_entrego_servico (id=%)',
    _email, _usuario_id, _acao_user, _id_empresa, _acao_vinculo, _papel_id;
END
$$;
