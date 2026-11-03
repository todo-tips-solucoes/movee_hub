-- 0126 — `financeiro` e `financeiro_aprovador` passam a ter `motoristas.editar`.
--
-- POR QUE: decisão do operador (2026-11-03), nascida de um caso concreto: o
-- entregador estava na base antiga com outro nome, o vínculo automático por nome
-- falhou e o financeiro não tinha como resolver. "Criar credencial"
-- (`motoristas.credencial`, 0114) recusa CNPJ que já tem conta ou senha, de
-- propósito, e "Vincular" exigia `.editar`.
--
-- ⚠️ REVÊ, DE PROPÓSITO, a exclusão deliberada da 0101 (reafirmada na 0114).
-- `motoristas.dados_sensiveis` CONTINUA FORA: se precisar entrar, é decisão nova.
--
-- O QUE A PERMISSÃO GOVERNA (routes/hub-motoristas.js):
--   - POST/DELETE /:id/vinculo → vincular conta existente / desvincular;
--   - GET /:id/sugestoes e /contas-elegiveis → sugestões e busca de conta;
--   - POST / e PATCH /:id → cadastrar e editar o entregador (nome, ativo);
--   - POST /:id/entrego-enriquecimento → buscar dados na EntreGô.
--
-- ⚠️ `financeiro_aprovador` é tratado EXPLICITAMENTE: nasceu (0097) como cópia
-- PONTUAL de `financeiro`, sem vínculo vivo (CLAUDE.md §"Migrations do hub").
--
-- Ids resolvidos por nome/código. Idempotente (ON CONFLICT DO NOTHING),
-- aditiva, sem DELETE. O registro em "SchemaMigration" é feito pelo migrate.sh.

INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT p.id, perm.id
FROM "Papel" p
CROSS JOIN "Permissao" perm
WHERE p.nome IN ('financeiro', 'financeiro_aprovador')
  AND perm.codigo = 'motoristas.editar'
ON CONFLICT DO NOTHING;
