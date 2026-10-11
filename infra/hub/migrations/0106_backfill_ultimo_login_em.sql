-- 0106 — backfill de Usuario.ultimo_login_em a partir da Auditoria
--
-- Por que existe: a 0105 criou a coluna NULL para todos, inclusive para quem
-- usa o hub há meses, e o selo "Nunca acessou" acendia errado até cada pessoa
-- logar de novo. A Auditoria guarda o histórico real (acao = 'login_sucesso').
--
-- Idempotente e segura: `ultimo_login_em IS NULL` no WHERE faz rodar duas
-- vezes não mudar nada e nunca sobrescrever um login mais recente já gravado
-- pelo backend.
--
-- ⚠️ O backfill só alcança quem tem 'login_sucesso' na Auditoria. Se a
-- auditoria tiver retenção menor que a idade da conta, alguém pode seguir NULL
-- mesmo tendo acessado: NULL significa "sem evidência de login", não "nunca
-- logou".
--
-- Só atualiza dados: sem coluna nova, sem GRANT, sem SIGUSR1 no PostgREST.

UPDATE "Usuario" u
   SET ultimo_login_em = a.ultimo
  FROM (SELECT usuario_id, max(criado_em) AS ultimo
          FROM "Auditoria" WHERE acao = 'login_sucesso' GROUP BY usuario_id) a
 WHERE a.usuario_id = u.id
   AND u.ultimo_login_em IS NULL;
