-- 0009 — Correções pós-review do PR #55 (hub-fundacoes / S2):
--   (A) [MÉDIA — segurança] Restringe o ramo global (id_empresa IS NULL) da
--       policy de INSERT em Auditoria, que hoje deixa QUALQUER token
--       `authenticated` forjar eventos globais arbitrários (achado #2 do
--       review de 0006_rls_policies.sql).
--   (B) [MÉDIA — perf] Índices de reforço para os predicados de RLS e das
--       queries de /me e /auditoria que filtram por coluna de entidade
--       isolada (achado #7).
--
-- EXPAND-ONLY / IDEMPOTENTE (regra da S2): esta migration NÃO edita 0006 (já
-- aplicada no hub-homolog persistente). Usa DROP POLICY IF EXISTS + CREATE
-- POLICY e CREATE INDEX IF NOT EXISTS — rodar 2× é no-op. NÃO toca docs/sql/
-- (série congelada) nem tabelas legadas.

-- ─────────────────────────────────────────────────────────────────────────
-- (A) Auditoria — INSERT: fecha o ramo global forjável.
--
-- Modelo original (0006): WITH CHECK (id_empresa IS NULL OR id_empresa = ANY(escopo)).
-- Problema: o ramo `id_empresa IS NULL` era INCONDICIONAL — bastava um token
-- `authenticated` (que todo request autenticado do hub carrega) para inserir
-- eventos globais com qualquer `acao`/`detalhes` forjados, poluindo a trilha
-- imutável (a imutabilidade de 0004 impede corrigir depois).
--
-- Decisão da restrição (documentada aqui conforme pedido do review):
-- os ÚNICOS inserts legítimos com id_empresa NULL são os eventos de
-- autenticação emitidos pelo backend (routes/hub-auth.js via
-- lib/hub-auditoria.js) — login/logout/recuperação/redefinição — e esses são
-- gravados com `claims = {}` (JWT só com role=authenticated, SEM claim `sub`:
-- no login o usuário ainda nem tem sessão/escopo). Portanto NÃO é possível
-- exigir `sub` presente sem quebrar o fluxo de login. A restrição idempotente
-- viável é limitar o ramo global a um CONJUNTO FECHADO de `acao` de
-- autenticação, verificável na própria policy contra a coluna `acao` da linha
-- nova. Isso reduz a superfície de forja de "qualquer evento global" para "no
-- máximo um evento de auth de baixo valor", sem quebrar nenhum insert real
-- (validado por hub-auth-integration.sh e hub-e2e-homolog.sh).
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
        OR (id_empresa IS NOT NULL AND id_empresa = ANY (hub_jwt_escopo_ids()))
    );

-- ─────────────────────────────────────────────────────────────────────────
-- (B) Índices de reforço para RLS/queries por coluna de entidade isolada.
--   - Auditoria(id_empresa): predicado da policy auditoria_select_por_escopo
--     e o filtro id_empresa=eq.<entidade> de GET /auditoria (routes/hub-me.js).
--   - ModuloEntidade(empresa_id): predicado de moduloentidade_select_por_escopo
--     e o filtro empresa_id=eq.<entidade> de GET /me. O UNIQUE(modulo_id,
--     empresa_id) de 0003 é liderado por modulo_id, então NÃO cobre uma busca
--     só por empresa_id — daí o índice dedicado.
--   (UsuarioEntidade(empresa_id) já existe desde 0003: idx_usuarioentidade_empresa_id.)
-- ─────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_auditoria_id_empresa ON "Auditoria"(id_empresa);
CREATE INDEX IF NOT EXISTS idx_moduloentidade_empresa_id ON "ModuloEntidade"(empresa_id);
