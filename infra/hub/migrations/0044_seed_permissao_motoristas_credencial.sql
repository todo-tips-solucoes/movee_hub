-- 0044 — Seed aditivo: permissão `motoristas.credencial` (motorista
-- canônico, WS-C fundação; tasks.md 3.2; data-model.md §Permissões;
-- research.md Decision 6, D-C1). Idempotente (ON CONFLICT DO NOTHING).
--
-- Renumeração: descrita como "0043" no data-model.md, mas esse número já
-- foi consumido pela FASE 2/WS-B nesta mesma feature (0042_hub_
-- entregadores_busca_rpc.sql) — a coluna ContaMotorista.senha (também
-- descrita como "0042" no data-model.md) já tomou o número seguinte livre,
-- 0043 (ver 0043_conta_motorista_senha.sql). Este seed é o próximo, 0044.
--
-- Reconciliação do clarify Q1 (research.md Decision 6): DUAS permissões
-- granulares e independentes para o domínio "motorista canônico":
--   1) `motoristas.editar` (JÁ EXISTENTE desde 0007_seed_papeis_
--      permissoes_modulos.sql) — cobre cadastro (POST) + edição (PATCH) de
--      motorista. Não há necessidade de uma permissão `motoristas.criar`
--      distinta: a proposta original (D-C1) foi reconciliada para reusar
--      `motoristas.editar`, reduzindo seeds novos (ver tasks.md 3.2.2).
--   2) `motoristas.credencial` (NOVA, este seed) — cobre as ações de
--      credencial de acesso ao app do motorista (criar/reset-senha/
--      ativar-desativar), tratadas nas fases seguintes desta feature.
-- Um usuário pode ter uma sem a outra (FR-020) — validado por
-- infra/hub/testes/hub-motorista-canonico-fundacao-integration.sh (3.2.4).
--
-- Concessão: apenas aos papéis "admin" (`admin_plataforma`,
-- `admin_entidade`) — gestão de credencial é ação sensível, distinta do
-- cadastro/edição operacional já concedido a `operador` via
-- `motoristas.editar`. `leitura` não recebe (só consulta).

INSERT INTO "Permissao" (codigo, modulo_id)
SELECT 'motoristas.credencial', id FROM "Modulo" WHERE codigo = 'motoristas'
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT p.id, perm.id
FROM "Papel" p
CROSS JOIN "Permissao" perm
WHERE p.nome IN ('admin_plataforma', 'admin_entidade')
  AND perm.codigo = 'motoristas.credencial'
ON CONFLICT DO NOTHING;
