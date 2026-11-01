-- 0120 — `financeiro` e `financeiro_aprovador` passam a poder aprovar no envio
-- em massa (`envio_massa.aprovar`): fechar movimento e excluir linha.
--
-- POR QUE: decisão do operador (2026-10-31). O painel legado deixa de ser usado
-- em 08/11 e o financeiro precisa fechar movimento pelo hub. Até aqui só
-- admin_entidade/admin_plataforma tinham a permissão (seed 0007), e o 403 do
-- `POST /close-movimento` chegava à tela como "[object Object]".
--
-- ⚠️ `financeiro_aprovador` é tratado EXPLICITAMENTE: nasceu (0097) como cópia
-- PONTUAL de `financeiro`, sem vínculo vivo (CLAUDE.md §"Migrations do hub").
-- Mesmo padrão das 0101/0114: os dois na mesma entrega.
--
-- Ids resolvidos por nome/código (variam entre ambientes). Idempotente
-- (ON CONFLICT DO NOTHING), aditiva, sem DELETE. O registro em
-- "SchemaMigration" é feito pelo migrate.sh, como nas vizinhas.

INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT p.id, perm.id
FROM "Papel" p
CROSS JOIN "Permissao" perm
WHERE p.nome IN ('financeiro', 'financeiro_aprovador')
  AND perm.codigo = 'envio_massa.aprovar'
ON CONFLICT DO NOTHING;
