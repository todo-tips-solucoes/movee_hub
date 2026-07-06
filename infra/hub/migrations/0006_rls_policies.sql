-- 0006 — RLS de reforço, nega-por-padrão (data-model.md; tasks.md FASE 5;
-- research.md Decision 3/4; FR-026/FR-027/FR-028; quickstart Scenario 9).
-- Idempotente (CREATE OR REPLACE / DROP POLICY IF EXISTS / ENABLE ROW LEVEL
-- SECURITY é reexecutável sem erro).
--
-- Cobertura EXATA (FR-027 — "no mínimo os dados novos que carregam associação
-- a uma entidade específica"): "UsuarioEntidade", "ModuloEntidade",
-- "Auditoria". As demais tabelas novas ("Usuario", "Papel", "Permissao",
-- "PapelPermissao", "Modulo", "SessaoRefresh") NÃO carregam coluna de
-- associação a entidade (são globais/por-usuário) — fora do escopo desta
-- camada (expand-only, dec-008: RLS NUNCA se estende às tabelas legadas
-- Empresa/Motorista/EnvioMassa/chatmasterveloz).
--
-- O role `authenticated` já existe e já tem os GRANTs necessários (SELECT/
-- INSERT/UPDATE em 0002/0003, SELECT/INSERT em 0004 para Auditoria) —
-- reconciliação dec-027/dec-029 documentada no cabeçalho de 0002_usuario.sql.
-- Esta migration NÃO recria o role nem altera GRANTs — só HABILITA RLS e
-- adiciona as policies. O dono da tabela (superuser/owner que roda as
-- migrations via migrate.sh) continua com bypass de RLS por padrão (não
-- usamos FORCE ROW LEVEL SECURITY) — necessário para seeds/administração.
--
-- Modelo de claims (research.md Decision 3, lib/hub-postgrest-jwt.js):
--   sub            -> id do Usuario autenticado (string)
--   empresa_ativa  -> id da entidade selecionada no momento (opcional)
--   escopo         -> array de ids de entidade em escopo para o request
--                     (opcional; nesta fundação sempre = [empresa_ativa],
--                     plan.md nota explicitamente que mesmoGrupoQue/
--                     resolveScope de routes/grupo.js NÃO se aplicam ao hub)
--
-- Postura nega-por-padrão (FR-028): se a claim relevante estiver ausente,
-- nula ou vazia, a expressão abaixo resolve para NULL/vazio e a comparação
-- nunca é verdadeira — SQL já nega por construção, sem precisar de um caso
-- especial "se claim ausente então false".

CREATE OR REPLACE FUNCTION hub_jwt_claims()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;

CREATE OR REPLACE FUNCTION hub_jwt_escopo_ids()
RETURNS int[]
LANGUAGE sql
STABLE
AS $$
    -- Converte a claim `escopo` (array JSON de ids) num int[] do Postgres.
    -- Claim ausente/nula -> array vazio -> nenhum empresa_id nunca casa
    -- (nega-por-padrão, FR-028). `elem` não numérico é ignorado silenciosamente
    -- (nunca lança exceção que derrubaria a query inteira por causa de uma
    -- claim malformada — preferimos negar a 500).
    SELECT COALESCE(
        array_agg((elem)::int),
        ARRAY[]::int[]
    )
    FROM jsonb_array_elements_text(
        COALESCE(hub_jwt_claims() -> 'escopo', '[]'::jsonb)
    ) AS elem
    WHERE elem ~ '^-?[0-9]+$';
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- UsuarioEntidade — escopada por `usuario_id = claim.sub` (cada pessoa só
-- lê os PRÓPRIOS vínculos; não depende de empresa_ativa/escopo, pois o
-- próprio propósito de GET /me é listar TODAS as entidades vinculadas para
-- a pessoa escolher). Somente SELECT: nenhuma rota desta fundação
-- escreve em UsuarioEntidade (CRUD de vínculos é S3+, fora de escopo).
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "UsuarioEntidade" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS usuarioentidade_select_proprio ON "UsuarioEntidade";
CREATE POLICY usuarioentidade_select_proprio ON "UsuarioEntidade"
    FOR SELECT
    USING (usuario_id = (hub_jwt_claims() ->> 'sub')::int);

-- ─────────────────────────────────────────────────────────────────────────
-- ModuloEntidade — escopada por `empresa_id ∈ claim.escopo`. Somente SELECT:
-- nenhuma rota desta fundação escreve em ModuloEntidade (ativação de módulo
-- por entidade é administração S3+).
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "ModuloEntidade" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS moduloentidade_select_por_escopo ON "ModuloEntidade";
CREATE POLICY moduloentidade_select_por_escopo ON "ModuloEntidade"
    FOR SELECT
    USING (empresa_id = ANY (hub_jwt_escopo_ids()));

-- ─────────────────────────────────────────────────────────────────────────
-- Auditoria — escopada por `id_empresa ∈ claim.escopo`, EXCETO linhas
-- globais (id_empresa IS NULL — eventos sem entidade ainda escolhida:
-- login/logout/recuperação de senha, FR-006/hub-auth.js) que ficam
-- liberadas incondicionalmente por não carregarem associação a nenhuma
-- entidade específica (fora da cobertura literal de FR-027: "dados... que
-- carregam associação a uma entidade específica"). SELECT + INSERT (o único
-- CRUD que hub-me.js/hub-auth.js exercem sobre Auditoria — UPDATE/DELETE já
-- são bloqueados por REVOKE + trigger em 0004, Decision 6, independente de
-- RLS: defesa em profundidade em DUAS camadas distintas).
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "Auditoria" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS auditoria_select_por_escopo ON "Auditoria";
CREATE POLICY auditoria_select_por_escopo ON "Auditoria"
    FOR SELECT
    USING (
        id_empresa IS NULL
        OR id_empresa = ANY (hub_jwt_escopo_ids())
    );

DROP POLICY IF EXISTS auditoria_insert_por_escopo ON "Auditoria";
CREATE POLICY auditoria_insert_por_escopo ON "Auditoria"
    FOR INSERT
    WITH CHECK (
        id_empresa IS NULL
        OR id_empresa = ANY (hub_jwt_escopo_ids())
    );
