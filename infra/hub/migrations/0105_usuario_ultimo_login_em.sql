-- 0105 — Usuario.ultimo_login_em
--
-- Por que existe: distinguir "nunca acessou" de "tem link de senha pendente".
-- Hoje o mesmo selo acende para quem foi convidado e para quem pediu "esqueci
-- minha senha" (as duas coisas gravam token_recuperacao_*), então a tela não
-- tem como dizer "nunca acessou" sem mentir no segundo caso.
--
-- ⚠️ A coluna nasce NULL para TODO mundo que já existe, inclusive quem acessa
-- o hub há meses. NULL NÃO prova que a pessoa nunca entrou: prova só que ela
-- nunca entrou DEPOIS desta migration. No primeiro mês o selo "Nunca acessou"
-- vai aparecer para gente que acessa normalmente — ele só se corrige conforme
-- cada pessoa fizer o próximo login.
--
-- Sem GRANT: 0002_usuario.sql concede SELECT, INSERT, UPDATE na tabela
-- inteira para `authenticated`, e a coluna nova herda.
-- Aditiva e idempotente.

ALTER TABLE "Usuario" ADD COLUMN IF NOT EXISTS ultimo_login_em timestamptz;
