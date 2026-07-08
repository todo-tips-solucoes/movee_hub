-- 0027 — Funções RPC de agregação para `GET /faturamento/resumo` (S6 /
-- hub-faturamento, data-model.md Migration 0027; research.md Decision
-- 2/3/4/7; plan.md "Gate owasp-security" A05 Injection PASS; tasks.md
-- hub-faturamento 1.2). Idempotente (CREATE OR REPLACE FUNCTION). Aplicada
-- por migrate.sh, que registra em "SchemaMigration" e envia SIGUSR1 ao
-- PostgREST.
--
-- Mecanismo obrigatório: agregação via RPC parametrizada do PostgREST — o
-- PostgREST faz bind nativo dos parâmetros (mesma garantia de prepared
-- statement), NUNCA SQL montado por concatenação de string no backend Node
-- (OWASP A05, mesmo padrão de `hub_motoristas_candidatos`/`_busca`, 0023).
-- SECURITY INVOKER (não DEFINER): as funções rodam com os privilégios do
-- role `authenticated` chamador, então a RLS de "FaturamentoLancamento"
-- (0015 — `id_empresa = ANY (hub_jwt_escopo_ids())`) se aplica normalmente
-- dentro da função — nenhum bypass de isolamento multi-tenant. `p_id_empresa`
-- é redundante por design: o backend passa o `id_empresa` resolvido do
-- token, mas mesmo que passasse um valor de outra empresa, a RLS ainda
-- filtra por `hub_jwt_escopo_ids()` e a função retorna zero linhas (task
-- 1.2.6).
--
-- Valores monetários trafegam como `text` (Decision 7) — o cast
-- `::numeric(12,2)::text` acontece DENTRO da função (não no backend Node),
-- fonte única da verdade, garante 2 casas decimais mesmo quando a soma é
-- zero (`"0.00"`, nunca `"0"`) e elimina qualquer chance de o transporte
-- virar `number` JSON com ponto flutuante.
--
-- `p_com_entregador`: NULL = ambos (sem filtro); true = só
-- `entregador_id IS NOT NULL`; false = só agregados/bônus
-- (`entregador_id IS NULL`).
--
-- Validação de `p_group_by` (enum 'dia'|'categoria'|'entregador') é feita
-- no backend Node ANTES de chamar a RPC (contracts/faturamento-api.md
-- "400 groupBy fora do enum") — a função confia no valor já validado, mesmo
-- padrão de confiança de borda já usado pelas RPCs de `hub-motoristas`.

CREATE OR REPLACE FUNCTION hub_faturamento_totais(
    p_id_empresa      int,
    p_de              date,
    p_ate             date,
    p_categoria       text,
    p_entregador_id   int,
    p_subpraca        text,
    p_com_entregador  boolean
)
RETURNS TABLE (
    total_geral             text,
    categoria_maior_valor   text,
    entregadores_distintos  int
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
    WITH filtro AS (
        SELECT *
        FROM "FaturamentoLancamento"
        WHERE id_empresa = p_id_empresa
          AND data_referencia BETWEEN p_de AND p_ate
          AND (p_categoria IS NULL OR descricao = p_categoria)
          AND (p_entregador_id IS NULL OR entregador_id = p_entregador_id)
          AND (p_subpraca IS NULL OR subpraca = p_subpraca)
          AND (
                p_com_entregador IS NULL
                OR (p_com_entregador AND entregador_id IS NOT NULL)
                OR (NOT p_com_entregador AND entregador_id IS NULL)
              )
    )
    SELECT
        COALESCE((SELECT SUM(valor) FROM filtro), 0)::numeric(12,2)::text,
        (
            SELECT descricao FROM filtro
            GROUP BY descricao
            ORDER BY SUM(valor) DESC, descricao ASC
            LIMIT 1
        ),
        (SELECT COUNT(DISTINCT entregador_id) FROM filtro)::int;
$$;

CREATE OR REPLACE FUNCTION hub_faturamento_agrupado(
    p_id_empresa      int,
    p_de              date,
    p_ate             date,
    p_categoria       text,
    p_entregador_id   int,
    p_subpraca        text,
    p_com_entregador  boolean,
    p_group_by        text
)
RETURNS TABLE (
    chave       text,
    total       text,
    quantidade  int
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
    WITH filtro AS (
        SELECT
            CASE p_group_by
                WHEN 'dia'        THEN data_referencia::text
                WHEN 'categoria'  THEN descricao
                WHEN 'entregador' THEN COALESCE(entregador_id::text, 'agregados_bonus')
            END AS chave_calc,
            valor
        FROM "FaturamentoLancamento"
        WHERE id_empresa = p_id_empresa
          AND data_referencia BETWEEN p_de AND p_ate
          AND (p_categoria IS NULL OR descricao = p_categoria)
          AND (p_entregador_id IS NULL OR entregador_id = p_entregador_id)
          AND (p_subpraca IS NULL OR subpraca = p_subpraca)
          AND (
                p_com_entregador IS NULL
                OR (p_com_entregador AND entregador_id IS NOT NULL)
                OR (NOT p_com_entregador AND entregador_id IS NULL)
              )
    )
    SELECT
        chave_calc,
        SUM(valor)::numeric(12,2)::text,
        COUNT(*)::int
    FROM filtro
    WHERE chave_calc IS NOT NULL
    GROUP BY chave_calc;
$$;

GRANT EXECUTE ON FUNCTION hub_faturamento_totais(int, date, date, text, int, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION hub_faturamento_agrupado(int, date, date, text, int, text, boolean, text) TO authenticated;
