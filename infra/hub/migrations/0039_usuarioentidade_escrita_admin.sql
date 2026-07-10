-- 0039 — políticas de SELECT ampliada + INSERT/UPDATE em UsuarioEntidade
-- (S9 — hub-auditoria-admin; migration EMERGENTE descoberta ao implementar
-- FASE 4.2, tasks.md 4.2.0; Decisão dec-032 do state.json da execução).
--
-- Gap encontrado: migration 0006_rls_policies.sql habilitou RLS em
-- "UsuarioEntidade" com APENAS a policy SELECT `usuarioentidade_select_proprio`
-- (usuario_id = claim.sub — "cada pessoa só lê os PRÓPRIOS vínculos"),
-- documentando explicitamente "nenhuma rota desta fundação escreve em
-- UsuarioEntidade (CRUD de vínculos é S3+, fora de escopo)". Esta feature (S9)
-- é exatamente esse S3+ que introduz CRUD de vínculos via routes/hub-usuarios.js
-- (FASE 4.2) — sem policy de INSERT/UPDATE, e sem SELECT cruzado (admin
-- listando vínculos de OUTRAS pessoas na mesma entidade), toda escrita/leitura
-- administrativa de UsuarioEntidade era negada por padrão (RLS enabled sem
-- policy = 0 linhas para o comando).
--
-- Idempotente (DROP POLICY IF EXISTS + CREATE POLICY reexecutáveis, mesmo
-- padrão de 0006/0009/0035/0036).
--
-- Modelo de autorização (mesmo espírito das Decisions 2/4 desta feature):
-- RLS aqui é o BACKSTOP de isolamento de tenant, NÃO o gate de permissão fina
-- — o gate específico (`usuarios.gerenciar`) é responsabilidade do middleware
-- `requirePermission`/`requireModuloAtivo` em routes/hub-usuarios.js (defesa
-- em profundidade: app decide "pode fazer X", RLS garante "só na própria
-- entidade, nunca cross-tenant"). Diferente de ModuloEntidade (0036, exclusivo
-- admin_plataforma — dec-009), aqui admin_entidade TAMBÉM escreve, escopado à
-- própria entidade (contracts/usuarios-api.md — "admin_entidade opera SOMENTE
-- usuários vinculados à entidade_ativa").

-- SELECT: preserva o branch "próprio vínculo" (GET /me continua funcionando
-- para QUALQUER pessoa, independente de permissão) e ACRESCENTA o branch
-- "vínculo de qualquer pessoa na MESMA entidade do escopo do chamador, OU
-- visão global admin_plataforma" — usado por GET /usuarios (lista vínculos de
-- outras pessoas). A UNIÃO dos dois branches nunca reduz acesso já existente.
DROP POLICY IF EXISTS usuarioentidade_select_proprio ON "UsuarioEntidade";
CREATE POLICY usuarioentidade_select_proprio ON "UsuarioEntidade"
    FOR SELECT
    USING (
        usuario_id = (hub_jwt_claims() ->> 'sub')::int
        OR hub_jwt_admin_plataforma()
        OR empresa_id = ANY (hub_jwt_escopo_ids())
    );

-- INSERT: novo vínculo (POST /usuarios cria usuário+1º vínculo; POST
-- /usuarios/:id/vinculos cria vínculo adicional) — escopado à entidade-alvo
-- do escopo do chamador, ou admin_plataforma (qualquer entidade).
DROP POLICY IF EXISTS usuarioentidade_insert_admin ON "UsuarioEntidade";
CREATE POLICY usuarioentidade_insert_admin ON "UsuarioEntidade"
    FOR INSERT
    WITH CHECK (
        hub_jwt_admin_plataforma()
        OR empresa_id = ANY (hub_jwt_escopo_ids())
    );

-- UPDATE: troca de papel e/ou ativo (PUT /usuarios/:id/vinculos/:vinculoId) —
-- mesma regra de escopo do INSERT. Sem policy de DELETE (desativação é
-- sempre `ativo=false`, modelo sem DELETE desde a S2 — GRANT DELETE nunca
-- existiu nesta tabela, nenhuma mudança necessária aqui).
DROP POLICY IF EXISTS usuarioentidade_update_admin ON "UsuarioEntidade";
CREATE POLICY usuarioentidade_update_admin ON "UsuarioEntidade"
    FOR UPDATE
    USING (
        hub_jwt_admin_plataforma()
        OR empresa_id = ANY (hub_jwt_escopo_ids())
    )
    WITH CHECK (
        hub_jwt_admin_plataforma()
        OR empresa_id = ANY (hub_jwt_escopo_ids())
    );

-- Nota: GRANT SELECT/INSERT/UPDATE em "UsuarioEntidade" para `authenticated`
-- já existe desde 0003_papel_permissao_modulo.sql — esta migration não
-- concede GRANT novo, apenas as policies de RLS acima (mesma nota de 0036).
