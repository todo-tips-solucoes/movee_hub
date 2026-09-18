-- 0069 — Auditoria: dois ramos novos na policy de INSERT para a feature
-- "Adiantamento pelo App, Dados Bancários e Exportação Transfeera"
-- (tasks.md 1.3; contracts/sql-rpc.md "Alterações em funções existentes";
-- PLANO.md §22 "Eventos iniciados pelo motorista precisam de ramo próprio
-- na policy de INSERT da Auditoria (como a 0063 fez para push_chave_*)").
--
-- (a) Ações iniciadas pelo MOTORISTA (app, claim `motorista_cnpj` via
--     `hub_jwt_motorista_cnpj()`): `adiantamento.solicitado`,
--     `adiantamento.cancelado`, `conta_bancaria.solicitada`
--     (`POST /motorista/adiantamentos`, `.../cancelar`,
--     `/motorista/conta-bancaria/solicitacoes` — contracts/motorista-api.md).
--     Diferente do ramo global de auth (0009) e do ramo push-worker (0063),
--     que gravam `id_empresa IS NULL`: aqui `id_empresa` é conhecido e NÃO
--     pode ser um valor arbitrário do corpo da requisição — a policy exige
--     que seja exatamente o `id_empresa` do `Entregador` ativo vinculado ao
--     CNPJ do claim (mesmo lookup que `hub_adiantamento_solicitar`/
--     `hub_conta_bancaria_solicitar` fazem, 0067), fechando a forja de
--     `id_empresa` de outra empresa por um motorista autenticado.
--
-- (b) Ações do tick/worker (claim `hub_adiantamento_worker`, mesma de
--     `hub_adiantamento_processar` — 0067): `adiantamento.calculado`,
--     `adiantamento.aguardando_producao`. `id_empresa` vem do retorno da
--     própria RPC (real, computado pelo banco) — o Node só repassa o que
--     `hub_adiantamento_processar` devolveu, nunca dado de requisição.
--
-- As demais ações de PLANO.md §22 (`.rejeitado`, `.recalculado`,
-- `.encerrado`, `.reprocessado`, `.configuracao_alterada`,
-- `conta_bancaria.aprovada/.rejeitada/.visualizada`, `lote_*`,
-- `pagamento_confirmado/.pagamento_falhou`, `retorno_importado`,
-- `apuracao_fechada`) são iniciadas por usuário do hub (claims
-- `sub`/`empresa_ativa`/`escopo`) e já caem no ramo existente
-- `id_empresa = ANY (hub_jwt_escopo_ids())` — sem mudança.
--
-- hub_jwt_motorista_id_empresa() — id_empresa do Entregador ativo vinculado
-- ao CNPJ do claim (NULL se claim ausente ou sem vínculo). SECURITY DEFINER:
-- roda como o dono da tabela, contornando `entregador_select_por_escopo`
-- (0015, `id_empresa = ANY(hub_jwt_escopo_ids())`) — uma sessão só com claim
-- de motorista não tem `escopo` e não enxergaria NENHUMA linha de
-- "Entregador" via SELECT normal sob RLS (mesmo motivo de
-- `hub_adiantamento_solicitar` ser SECURITY DEFINER, 0067). Só é chamada de
-- dentro da própria policy abaixo; sem GRANT extra (EXECUTE default a
-- PUBLIC, mesmo padrão de `hub_jwt_escopo_ids`/`hub_jwt_motorista_cnpj`).
CREATE OR REPLACE FUNCTION hub_jwt_motorista_id_empresa()
RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT e.id_empresa
    FROM "Entregador" e
    JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
    WHERE cm.cnpj_prestador = hub_jwt_motorista_cnpj() AND e.ativo
    LIMIT 1;
$$;

-- EXPAND-ONLY / IDEMPOTENTE: DROP POLICY IF EXISTS + CREATE POLICY (rodar
-- 2× é no-op), mesmo padrão de 0063. Não edita 0009/0063 (já aplicadas no
-- hub-homolog persistente).
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
        OR (
            -- 1.3.1: motorista via app.
            acao IN ('adiantamento.solicitado', 'adiantamento.cancelado', 'conta_bancaria.solicitada')
            AND hub_jwt_motorista_cnpj() IS NOT NULL
            AND id_empresa IS NOT NULL
            AND id_empresa = hub_jwt_motorista_id_empresa()
        )
        OR (
            -- 1.3.2: tick/worker.
            acao IN ('adiantamento.calculado', 'adiantamento.aguardando_producao')
            AND hub_jwt_adiantamento_worker()
            AND id_empresa IS NOT NULL
        )
        OR (id_empresa IS NOT NULL AND id_empresa = ANY (hub_jwt_escopo_ids()))
    );
