-- 0045 — ContaMotorista.token_reset_hash / token_reset_expira (motorista
-- canônico, WS-C credencial; tasks.md FASE 5, 5.1/5.2.2; data-model.md
-- §Migrations; research.md Decision 6/8, mandato S3). Idempotente (ADD
-- COLUMN IF NOT EXISTS).
--
-- Colunas do fluxo de redefinição de senha da credencial de acesso ao app do
-- motorista (POST /api/v1/motoristas/:id/credencial/reset-senha e
-- .../reset-senha/definir — routes/hub-motoristas.js). Espelham EXATAMENTE
-- o padrão já usado por `Usuario.token_recuperacao_hash`/
-- `token_recuperacao_expira` (migration 0003, fluxo `recuperar-senha`/
-- `redefinir-senha` de routes/hub-auth.js — CHK011/tasks.md 5.2.2):
--   - token_reset_hash: SHA-256 hex do token bruto (256 bits de entropia,
--     `crypto.randomBytes(32)`) — NUNCA o token em claro é persistido.
--   - token_reset_expira: timestamp de expiração, MESMO TTL do fluxo legado
--     (RECUPERACAO_TOKEN_TTL_MS = 60 * 60 * 1000, 1 hora — routes/hub-auth.js).
-- Single-use: ambas as colunas são zeradas (NULL) no mesmo UPDATE que
-- consome o token para definir a nova senha — um token já usado nunca casa
-- de novo com token_reset_hash=NULL.
--
-- Os grants de tabela já concedidos em 0021_conta_motorista.sql
-- (`GRANT SELECT, INSERT, UPDATE ON "ContaMotorista" TO authenticated;`) são
-- column-list-less — cobrem automaticamente estas colunas novas, sem GRANT
-- adicional (mesmo raciocínio documentado em 0043_conta_motorista_senha.sql).

ALTER TABLE "ContaMotorista" ADD COLUMN IF NOT EXISTS token_reset_hash text NULL;
ALTER TABLE "ContaMotorista" ADD COLUMN IF NOT EXISTS token_reset_expira timestamptz NULL;
