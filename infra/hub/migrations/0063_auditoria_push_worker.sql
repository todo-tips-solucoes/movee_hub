-- 0063 — Auditoria: aceita eventos globais do push-worker (dec-123).
--
-- Achado (execute-task onda-023, dec-123): `registrarChaveVapid`
-- (lib/hub-push-worker.js) audita `push_chave_registrada`/
-- `push_chave_substituida` como evento GLOBAL (id_empresa NULL, mesmo
-- espírito de login_sucesso/login_falha/... — o worker roda no boot, sem
-- empresa/escopo). A policy `auditoria_insert_por_escopo` (0009) só abre o
-- ramo `id_empresa IS NULL` para o conjunto fechado de ações de
-- autenticação; qualquer outra ação global cai no ramo
-- `id_empresa IS NOT NULL AND id_empresa = ANY(hub_jwt_escopo_ids())`, que
-- nunca casa (id_empresa É NULL) — INSERT negado por RLS (42501),
-- silenciado pelo catch best-effort de `registrarAuditoria` (nunca bloqueia
-- o boot). Resultado: a trilha da chave VAPID nunca era gravada.
--
-- Fix mínimo: reusa o claim `hub_push_worker` já validado por
-- `hub_jwt_push_worker()` (0061, usado nas policies de
-- Aviso/AvisoEntrega/PushChaveVapid) e abre um 3º ramo, restrito às 2 ações
-- do worker de push — não amplia a superfície de forja além disso (mesma
-- lógica de fechamento por `acao IN (...)` que 0009 já usa para auth).
--
-- EXPAND-ONLY / IDEMPOTENTE: DROP POLICY IF EXISTS + CREATE POLICY (rodar
-- 2× é no-op). Não edita 0009 (já aplicada no hub-homolog persistente).
DROP POLICY IF EXISTS auditoria_insert_por_escopo ON "Auditoria";
CREATE POLICY auditoria_insert_por_escopo ON "Auditoria"
    FOR INSERT
    WITH CHECK (
        (
            id_empresa IS NULL
            AND acao IN (
                'login_sucesso',
                'login_falha',
                'logout',
                'recuperacao_senha_solicitada',
                'senha_redefinida'
            )
        )
        OR (
            id_empresa IS NULL
            AND acao IN ('push_chave_registrada', 'push_chave_substituida')
            AND hub_jwt_push_worker()
        )
        OR (id_empresa IS NOT NULL AND id_empresa = ANY (hub_jwt_escopo_ids()))
    );
