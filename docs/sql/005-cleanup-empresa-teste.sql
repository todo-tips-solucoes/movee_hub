-- =============================================================================
-- 005-cleanup-empresa-teste.sql
-- Feature: cadastro-filiais — limpeza do dado de teste deixado pelo E2E.
-- Entregue ao operador para aplicar no banco — NAO executar automaticamente.
--
-- CONTEXTO: a validacao E2E do cadastro de filiais (2026-06-10) criou uma
-- Empresa de teste em homologacao. O fluxo de "desvincular" (DELETE
-- /grupo/filhos/:id) apenas zera o id_grupo (id_grupo = NULL) — NAO remove a
-- linha da Empresa. Por isso a linha permanece orfa e precisa ser removida
-- diretamente no banco (a role `authenticated` do PostgREST so tem
-- SELECT/INSERT/UPDATE, sem DELETE).
--
-- Alvo:
--   id    = 9
--   email = filial-e2e-1781062857@teste.local
--   cnpj  = 91781062857000   (consumido pela UNIQUE empresa_cnpj_unique)
--
-- Como aplicar:
--   psql $DATABASE_URL -f docs/sql/005-cleanup-empresa-teste.sql
--
-- SEGURO: roda em transacao; o passo 1 mostra a linha (confira antes); o
-- DELETE e GUARDADO por id + email (so apaga se ambos baterem). Idempotente:
-- se a linha ja foi removida, o DELETE afeta 0 linhas sem erro.
-- =============================================================================

BEGIN;

-- 1. Inspecao (confira que e mesmo o dado de teste antes de prosseguir).
--    Esperado: nome "Filial E2E 1781062857", email de teste, cnpj acima,
--    id_grupo = NULL (ja desvinculada).
SELECT id, nome_empresa, email, cnpj, id_grupo
  FROM "Empresa"
 WHERE id = 9;

-- 2. Remocao guardada por id + email (so apaga a linha de teste exata).
DELETE FROM "Empresa"
 WHERE id = 9
   AND email = 'filial-e2e-1781062857@teste.local';

COMMIT;

-- =============================================================================
-- Verificacao (apos aplicar) — deve retornar 0 linhas:
--   SELECT id, email FROM "Empresa" WHERE id = 9;
-- O cnpj 91781062857000 volta a ficar livre para novos cadastros.
-- =============================================================================
