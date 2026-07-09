-- 0035 — claim `admin_plataforma` + visão global de Auditoria (S9 —
-- hub-auditoria-admin; plan.md "Plano por fases" passo 1; data-model.md
-- "Objetos NOVOS de banco" e "Entity: Auditoria — mudança desta feature";
-- spec.md FR-002/FR-003; contracts/auditoria-api.md "Escopo"; tasks.md 1.1).
--
-- Idempotente (CREATE OR REPLACE FUNCTION / DROP POLICY IF EXISTS + CREATE
-- POLICY são reexecutáveis sem erro — mesmo padrão de 0006/0009).
--
-- hub_jwt_admin_plataforma(): lê a claim `admin_plataforma` emitida pelo
-- backend em lib/hub-postgrest-jwt.js (FASE 4.5 desta mesma feature, ainda
-- não implementada nesta migration — a função aqui só PREPARA a leitura;
-- nenhum handler emite a claim ainda). Claim ausente/nula -> false (nega-
-- por-padrão, mesmo padrão de hub_jwt_escopo_ids() em 0006). Usa o mesmo
-- helper hub_jwt_claims() já definido em 0006 (não redefinido aqui).
CREATE OR REPLACE FUNCTION hub_jwt_admin_plataforma()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE((hub_jwt_claims() ->> 'admin_plataforma')::boolean, false);
$$;

-- Substitui a policy SELECT de Auditoria (0006): o ramo antigo liberava
-- INCONDICIONALMENTE qualquer linha com id_empresa IS NULL (eventos globais
-- de autenticação) para todo `authenticated`. A partir desta migration,
-- eventos globais só são visíveis para quem tem o claim admin_plataforma —
-- edge case da spec: "eventos sem entidade... exclusivos da visão
-- admin_plataforma". A policy de INSERT (0009) permanece INALTERADA (não
-- tocada aqui — 1.1.4).
DROP POLICY IF EXISTS auditoria_select_por_escopo ON "Auditoria";
CREATE POLICY auditoria_select_por_escopo ON "Auditoria"
    FOR SELECT
    USING (
        hub_jwt_admin_plataforma()
        OR (id_empresa IS NOT NULL AND id_empresa = ANY (hub_jwt_escopo_ids()))
    );
