-- 0097 — Papel `financeiro_aprovador` + trava de banco para papéis restritos
-- (repasse-saldo-minimo F2, US2; spec.md FR-006..FR-012b; data-model.md
-- Entities Papel/PapelPermissao/UsuarioEntidade; research.md Decisions 3, 4,
-- 5; contracts/hub-usuarios-trava.md; tasks.md FASE 2.2).
--
-- Furo corrigido (controle negativo 2.1, evidência em
-- docs/plans/repasse-saldo-minimo/EVIDENCIA-F2-CONTROLE-NEGATIVO.md): até
-- aqui, fechar apuração/gerar notas/confirmar-devolver lote (FR-006) exigia
-- só `adiantamentos.pagamento_confirmar`, e a migration 0070 concedeu essa
-- permissão a `financeiro` e a `admin_entidade` além de `admin_plataforma` —
-- ou seja, QUALQUER admin de entidade (não só o financeiro) já aprovava
-- pagamento sem nenhum papel dedicado, e nada impedia um `admin_entidade`
-- de conceder/alterar/desativar vínculo de papel restrito (inclusive o
-- próprio `admin_plataforma`) pela rota OU direto no PostgREST.
--
-- Idempotente: INSERT ... ON CONFLICT DO NOTHING, DELETE por condição
-- (reexecutável sem efeito colateral), CREATE OR REPLACE FUNCTION,
-- DROP POLICY IF EXISTS + CREATE POLICY, REVOKE/GRANT reexecutáveis.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Helper hub_papel_restrito (tasks.md 2.2.1) — espelho SQL de
--    app_homologacao/backend/lib/hub-papeis-restritos.js. Papéis restritos:
--    só admin_plataforma pode conceder/alterar/desativar o vínculo de outro
--    usuário com eles. SECURITY DEFINER + search_path fixo (padrão obrigatório
--    desta base para funções DEFINER, ver 0037/0028/0031); STABLE porque só
--    lê o catálogo fixo de Papel dentro da MESMA transação/statement.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION hub_papel_restrito(p_papel_id int)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM "Papel"
        WHERE id = p_papel_id
          AND nome IN ('admin_plataforma', 'financeiro_aprovador')
    );
$$;

REVOKE ALL ON FUNCTION hub_papel_restrito(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_papel_restrito(int) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Papel novo `financeiro_aprovador` (tasks.md 2.2.3) — escopo entidade,
--    is_sistema (mesmo molde do `financeiro` em 0070). Cópia das permissões
--    vigentes de `financeiro` + `adiantamentos.pagamento_confirmar` (FR-008).
--
--    DÍVIDA DELIBERADA (tasks.md 2.2.7, nota espelhada em CLAUDE.md
--    §"Migrations do hub"): esta é uma cópia PONTUAL, na data desta
--    migration — não há vínculo vivo entre `financeiro` e
--    `financeiro_aprovador`. Uma permissão nova concedida só a `financeiro`
--    depois da 0097 NÃO se propaga automaticamente para
--    `financeiro_aprovador`.
-- ─────────────────────────────────────────────────────────────────────────

INSERT INTO "Papel" (nome, escopo, is_sistema) VALUES
    ('financeiro_aprovador', 'entidade', true)
ON CONFLICT (nome) DO NOTHING;

INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT novo.id, pp.permissao_id
FROM "PapelPermissao" pp
JOIN "Papel" origem ON origem.id = pp.papel_id AND origem.nome = 'financeiro'
CROSS JOIN (SELECT id FROM "Papel" WHERE nome = 'financeiro_aprovador') AS novo
ON CONFLICT DO NOTHING;

INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT novo.id, perm.id
FROM "Permissao" perm
CROSS JOIN (SELECT id FROM "Papel" WHERE nome = 'financeiro_aprovador') AS novo
WHERE perm.codigo = 'adiantamentos.pagamento_confirmar'
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Remove `adiantamentos.pagamento_confirmar` de todo papel EXCETO
--    admin_plataforma e financeiro_aprovador (tasks.md 2.2.4, FR-006/FR-007)
--    — fecha o furo de 0070 (financeiro e admin_entidade tinham a permissão
--    sem nenhum papel dedicado de aprovação).
-- ─────────────────────────────────────────────────────────────────────────

DELETE FROM "PapelPermissao"
WHERE permissao_id = (SELECT id FROM "Permissao" WHERE codigo = 'adiantamentos.pagamento_confirmar')
  AND papel_id NOT IN (SELECT id FROM "Papel" WHERE nome IN ('admin_plataforma', 'financeiro_aprovador'));

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Políticas de UsuarioEntidade refeitas a partir do corpo vigente
--    (0039:46/58, tasks.md 2.2.5) — acrescenta a trava de papel restrito.
--    INSERT: novo vínculo só pode carregar papel restrito se
--    hub_jwt_admin_plataforma(). UPDATE: USING cobre a linha ATUAL (bloqueia
--    alterar/desativar vínculo cujo papel já É restrito — PATCH devolve 0
--    linhas); WITH CHECK cobre a linha NOVA (bloqueia promover um vínculo
--    para papel restrito — PATCH levanta 42501). Mesma regra de escopo do
--    corpo 0039 nos dois ramos, só ACRESCIDA da condição de papel restrito.
-- ─────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS usuarioentidade_insert_admin ON "UsuarioEntidade";
CREATE POLICY usuarioentidade_insert_admin ON "UsuarioEntidade"
    FOR INSERT
    WITH CHECK (
        hub_jwt_admin_plataforma()
        OR (
            empresa_id = ANY (hub_jwt_escopo_ids())
            AND NOT hub_papel_restrito(papel_id)
        )
    );

DROP POLICY IF EXISTS usuarioentidade_update_admin ON "UsuarioEntidade";
CREATE POLICY usuarioentidade_update_admin ON "UsuarioEntidade"
    FOR UPDATE
    USING (
        hub_jwt_admin_plataforma()
        OR (
            empresa_id = ANY (hub_jwt_escopo_ids())
            AND NOT hub_papel_restrito(papel_id)
        )
    )
    WITH CHECK (
        hub_jwt_admin_plataforma()
        OR (
            empresa_id = ANY (hub_jwt_escopo_ids())
            AND NOT hub_papel_restrito(papel_id)
        )
    );

-- ─────────────────────────────────────────────────────────────────────────
-- 5. REVOKE de escrita direta na matriz RBAC (tasks.md 2.2.6, FR-012b,
--    block-005 — decisão do operador). A escrita legítima da matriz
--    papel×permissão segue exclusivamente pela RPC SECURITY DEFINER
--    `hub_papel_permissao_set` (0037, que já checa hub_jwt_admin_plataforma()
--    internamente); seeds/administração continuam via `psql_t`/migrations
--    (dono da tabela, bypassa GRANT). GRANT original: 0003:58
--    (`GRANT SELECT, INSERT, UPDATE ON "Papel", "Modulo", "Permissao",
--    "PapelPermissao", "ModuloEntidade", "UsuarioEntidade" TO authenticated`)
--    — aqui só as 4 tabelas da matriz perdem INSERT/UPDATE;
--    ModuloEntidade/UsuarioEntidade continuam com o GRANT original (a
--    escrita de UsuarioEntidade é legítima via routes/hub-usuarios.js,
--    agora com a trava de RLS acima).
-- ─────────────────────────────────────────────────────────────────────────

REVOKE INSERT, UPDATE ON "Papel", "PapelPermissao", "Permissao", "Modulo" FROM authenticated;
