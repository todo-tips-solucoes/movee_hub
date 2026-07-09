-- 0036 — políticas de escrita em ModuloEntidade, exclusivas de
-- admin_plataforma (S9 — hub-auditoria-admin; plan.md "Plano por fases"
-- passo 1; data-model.md "Entity: ModuloEntidade — ganha políticas de
-- ESCRITA"; contracts/admin-modulos-api.md; spec.md FR-007/FR-017;
-- tasks.md 1.2).
--
-- Idempotente (DROP POLICY IF EXISTS + CREATE POLICY reexecutáveis).
--
-- SELECT: acrescenta o branch hub_jwt_admin_plataforma() (visão global,
-- qualquer entidade) preservando o filtro por escopo já existente (0006)
-- para quem não tem o claim (admin_entidade continua restrito à própria
-- entidade).
DROP POLICY IF EXISTS moduloentidade_select_por_escopo ON "ModuloEntidade";
CREATE POLICY moduloentidade_select_por_escopo ON "ModuloEntidade"
    FOR SELECT
    USING (
        hub_jwt_admin_plataforma()
        OR empresa_id = ANY (hub_jwt_escopo_ids())
    );

-- INSERT/UPDATE: exclusivas do claim admin_plataforma (dec-009 — habilitar/
-- desabilitar módulo por entidade é administração de plataforma, nunca de
-- admin_entidade). Nenhuma policy de DELETE — toggle é sempre `ativo=true|
-- false` via UPDATE, nunca remoção de linha (Decision 4 do research.md).
DROP POLICY IF EXISTS moduloentidade_insert_admin_plataforma ON "ModuloEntidade";
CREATE POLICY moduloentidade_insert_admin_plataforma ON "ModuloEntidade"
    FOR INSERT
    WITH CHECK (hub_jwt_admin_plataforma());

DROP POLICY IF EXISTS moduloentidade_update_admin_plataforma ON "ModuloEntidade";
CREATE POLICY moduloentidade_update_admin_plataforma ON "ModuloEntidade"
    FOR UPDATE
    USING (hub_jwt_admin_plataforma())
    WITH CHECK (hub_jwt_admin_plataforma());

-- Nota (1.2.5): os GRANTs INSERT/UPDATE em "ModuloEntidade" para o role
-- `authenticated` já existem desde 0003_papel_permissao_modulo.sql — esta
-- migration NÃO concede GRANT novo, apenas as policies de RLS acima (a
-- policy é quem de fato restringe a admin_plataforma; o GRANT é a permissão
-- de tabela, mais ampla, já necessária desde a fundação). Confirmado por
-- inspeção: nenhum GRANT DELETE existe em "ModuloEntidade" em nenhuma
-- migration anterior (0003/0006/0009) — não há necessidade de REVOKE.
