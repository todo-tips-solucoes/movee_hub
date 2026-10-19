-- 0114 — `financeiro` e `financeiro_aprovador` passam a poder criar a
-- credencial de acesso do motorista ao app e resetar a senha dele
-- (`motoristas.credencial`).
--
-- POR QUE: pedido do operador (2026-10-19), nascido de um caso concreto do
-- financeiro: entregador novo entra no meio da semana e precisa de acesso ao
-- app para antecipar; e o reset de senha ainda é feito pelo sistema antigo
-- porque o botão não aparece no hub para esse perfil (a tela só o mostra com
-- `motoristas.credencial` nas permissões efetivas).
--
-- ⚠️ ESTA MIGRATION REVERTE UMA DECISÃO ANTERIOR, DE PROPÓSITO. A 0101
-- (2026-09-29) deu ao financeiro Motoristas como "leitura, não operação" e
-- excluiu `motoristas.credencial` explicitamente (junto de `.editar` e
-- `.dados_sensiveis`). Aquela exclusão era deliberada, não esquecimento. O
-- operador a revisou em 2026-10-19 pelo motivo operacional acima. Nada mais
-- da 0101 muda: `motoristas.editar` e `motoristas.dados_sensiveis`
-- CONTINUAM FORA do financeiro — se um dia precisarem entrar, é decisão
-- nova, não herança desta.
--
-- O QUE A PERMISSÃO GOVERNA (routes/hub-motoristas.js), quatro rotas:
--   POST  /:id/credencial                     criar credencial
--   POST  /:id/credencial/reset-senha         iniciar reset (invalida a senha
--                                             atual e devolve o token)
--   POST  /:id/credencial/reset-senha/definir definir a nova senha
--   PATCH /:id/credencial                     ativar/desativar
-- O PATCH vem junto (mesmo gate, não dá para conceder só três). A RLS dessas
-- tabelas é por escopo da entidade, não por permissão: o gate é o do backend.
--
-- ⚠️ `financeiro_aprovador` é tratado EXPLICITAMENTE. Ele nasceu (0097) como
-- cópia PONTUAL de `financeiro`, sem vínculo vivo: permissão dada só a um não
-- chega ao outro (CLAUDE.md §"Migrations do hub"). Conceder só ao
-- `financeiro` deixaria o papel mais forte com menos acesso. A 0101 fez
-- igual: os dois na mesma entrega.
--
-- Ids resolvidos por nome/código (variam entre ambientes). Idempotente
-- (ON CONFLICT DO NOTHING), aditiva, sem DELETE.

INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT p.id, perm.id
FROM "Papel" p
CROSS JOIN "Permissao" perm
WHERE p.nome IN ('financeiro', 'financeiro_aprovador')
  AND perm.codigo = 'motoristas.credencial'
ON CONFLICT DO NOTHING;
