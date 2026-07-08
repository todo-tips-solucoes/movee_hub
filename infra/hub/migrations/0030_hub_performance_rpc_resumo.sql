-- 0030 — Funções RPC de agregação para `GET /performance/resumo` (S7 /
-- hub-performance, data-model.md Migration 0030; research.md Decision
-- 2/3/4/12; plan.md "Gate owasp-security" A05 Injection PASS; tasks.md
-- hub-performance 1.2). Idempotente (CREATE OR REPLACE FUNCTION). Aplicada
-- por migrate.sh, que registra em "SchemaMigration" e envia SIGUSR1 ao
-- PostgREST.
--
-- Mecanismo obrigatório: agregação via RPC parametrizada do PostgREST — o
-- PostgREST faz bind nativo dos parâmetros (mesma garantia de prepared
-- statement), NUNCA SQL montado por concatenação de string no backend Node
-- (OWASP A05, mesmo padrão de `hub_faturamento_totais`/`_agrupado`, 0027).
-- SECURITY INVOKER (não DEFINER): as funções rodam com os privilégios do
-- role `authenticated` chamador, então a RLS de "PerformanceTurno" (0015 —
-- `performanceturno_select_por_escopo`, escopo por `id_empresa`) se aplica
-- normalmente dentro da função — nenhum bypass de isolamento multi-tenant.
-- `p_id_empresa` é redundante por design: o backend passa o `id_empresa`
-- resolvido do token, mas mesmo que passasse um valor de outra empresa, a
-- RLS ainda filtra pelo escopo do JWT e a função retorna zero linhas
-- (task 1.2.6).
--
-- Fórmula de `tempoDisponivelMedio`/`tempo_disponivel_medio` (Decision 2/3
-- — Σ(pct×duração)/Σduração ponderado por `duracao` interval já persistido
-- na 0014, com fallback para média aritmética simples do CONJUNTO/GRUPO
-- inteiro quando qualquer registro elegível (tempo_disponivel_pct IS NOT
-- NULL) do conjunto/grupo tem duracao IS NULL — nunca apenas descarta o
-- peso daquele registro):
--
--   CASE
--     WHEN COUNT(*) FILTER (WHERE tempo_disponivel_pct IS NOT NULL) = 0
--       THEN NULL
--     WHEN bool_or(duracao IS NULL) FILTER (WHERE tempo_disponivel_pct IS NOT NULL)
--       THEN AVG(tempo_disponivel_pct) FILTER (WHERE tempo_disponivel_pct IS NOT NULL)
--     ELSE SUM(tempo_disponivel_pct * EXTRACT(EPOCH FROM duracao))
--            FILTER (WHERE tempo_disponivel_pct IS NOT NULL)
--          / NULLIF(SUM(EXTRACT(EPOCH FROM duracao))
--            FILTER (WHERE tempo_disponivel_pct IS NOT NULL), 0)
--   END
--
-- `NULLIF(..., 0)` é defesa em profundidade residual — bool_or já garante
-- que só entramos no ramo ponderado quando toda duracao elegível é
-- não-nula.
--
-- `taxaAceitacao`/`taxaConclusao`: razão entre SOMAS (nunca média de
-- percentuais linha a linha — SC-002), `NULL` quando o denominador da soma
-- é zero (SC-009), calculado via `NULLIF`, formatado com 4 casas decimais
-- fixas (`::numeric(6,4)::text`, contract "0.8333"/"0.9000" — trailing
-- zero preservado pelo cast numeric antes do text).
--
-- `taxasReais`: `SUM(COALESCE(taxas_centavos,0))::numeric/100`, formatado
-- como `text` com `::numeric(12,2)::text` (Decision 7, mesmo padrão de
-- `hub_faturamento_totais`) — 2 casas decimais garantidas mesmo quando a
-- soma é zero ("0.00", nunca "0").
--
-- `entregador_id` é NOT NULL desde a origem (0014) — sem bucket
-- "agregados/sem entregador" (Decision 4, ao contrário de faturamento).
--
-- Validação de `p_group_by` (enum 'dia'|'periodo'|'entregador' — Decision
-- 12, não 'turno') é feita no backend Node ANTES de chamar a RPC
-- (contracts/performance-api.md "400 GROUP_BY_INVALIDO") — a função confia
-- no valor já validado, mesmo padrão de confiança de borda já usado pelas
-- RPCs de `hub-faturamento`/`hub-motoristas`.

CREATE OR REPLACE FUNCTION hub_performance_totais(
    p_id_empresa      int,
    p_de              date,
    p_ate             date,
    p_periodo         text,
    p_subpraca        text,
    p_entregador_id   int
)
RETURNS TABLE (
    corridas_completadas    int,
    taxa_aceitacao          text,
    taxa_conclusao          text,
    tempo_disponivel_medio  text,
    taxas_reais             text
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
    WITH filtro AS (
        SELECT *
        FROM "PerformanceTurno"
        WHERE id_empresa = p_id_empresa
          AND data_periodo BETWEEN p_de AND p_ate
          AND (p_periodo IS NULL OR periodo = p_periodo)
          AND (p_subpraca IS NULL OR subpraca = p_subpraca)
          AND (p_entregador_id IS NULL OR entregador_id = p_entregador_id)
    )
    SELECT
        COALESCE((SELECT SUM(corridas_completadas) FROM filtro), 0)::int,
        (
            SELECT (SUM(corridas_aceitas)::numeric / NULLIF(SUM(corridas_ofertadas), 0))::numeric(6,4)::text
            FROM filtro
        ),
        (
            SELECT (SUM(corridas_completadas)::numeric / NULLIF(SUM(corridas_aceitas), 0))::numeric(6,4)::text
            FROM filtro
        ),
        (
            SELECT
                CASE
                    WHEN COUNT(*) FILTER (WHERE tempo_disponivel_pct IS NOT NULL) = 0
                        THEN NULL
                    WHEN bool_or(duracao IS NULL) FILTER (WHERE tempo_disponivel_pct IS NOT NULL)
                        THEN (AVG(tempo_disponivel_pct) FILTER (WHERE tempo_disponivel_pct IS NOT NULL))::numeric(6,2)::text
                    ELSE (
                        SUM(tempo_disponivel_pct * EXTRACT(EPOCH FROM duracao))
                            FILTER (WHERE tempo_disponivel_pct IS NOT NULL)
                        / NULLIF(SUM(EXTRACT(EPOCH FROM duracao))
                            FILTER (WHERE tempo_disponivel_pct IS NOT NULL), 0)
                    )::numeric(6,2)::text
                END
            FROM filtro
        ),
        (COALESCE((SELECT SUM(COALESCE(taxas_centavos, 0)) FROM filtro), 0)::numeric / 100)::numeric(12,2)::text;
$$;

CREATE OR REPLACE FUNCTION hub_performance_agrupado(
    p_id_empresa      int,
    p_de              date,
    p_ate             date,
    p_periodo         text,
    p_subpraca        text,
    p_entregador_id   int,
    p_group_by        text
)
RETURNS TABLE (
    chave                   text,
    quantidade              int,
    corridas_completadas    int,
    taxa_aceitacao          text,
    taxa_conclusao          text,
    tempo_disponivel_medio  text,
    taxas_reais             text
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
    WITH filtro AS (
        SELECT
            CASE p_group_by
                WHEN 'dia'        THEN data_periodo::text
                WHEN 'periodo'    THEN periodo
                WHEN 'entregador' THEN entregador_id::text
            END AS chave_calc,
            corridas_ofertadas,
            corridas_aceitas,
            corridas_completadas,
            tempo_disponivel_pct,
            duracao,
            taxas_centavos
        FROM "PerformanceTurno"
        WHERE id_empresa = p_id_empresa
          AND data_periodo BETWEEN p_de AND p_ate
          AND (p_periodo IS NULL OR periodo = p_periodo)
          AND (p_subpraca IS NULL OR subpraca = p_subpraca)
          AND (p_entregador_id IS NULL OR entregador_id = p_entregador_id)
    )
    SELECT
        chave_calc,
        COUNT(*)::int,
        SUM(corridas_completadas)::int,
        (SUM(corridas_aceitas)::numeric / NULLIF(SUM(corridas_ofertadas), 0))::numeric(6,4)::text,
        (SUM(corridas_completadas)::numeric / NULLIF(SUM(corridas_aceitas), 0))::numeric(6,4)::text,
        CASE
            WHEN COUNT(*) FILTER (WHERE tempo_disponivel_pct IS NOT NULL) = 0
                THEN NULL
            WHEN bool_or(duracao IS NULL) FILTER (WHERE tempo_disponivel_pct IS NOT NULL)
                THEN (AVG(tempo_disponivel_pct) FILTER (WHERE tempo_disponivel_pct IS NOT NULL))::numeric(6,2)::text
            ELSE (
                SUM(tempo_disponivel_pct * EXTRACT(EPOCH FROM duracao))
                    FILTER (WHERE tempo_disponivel_pct IS NOT NULL)
                / NULLIF(SUM(EXTRACT(EPOCH FROM duracao))
                    FILTER (WHERE tempo_disponivel_pct IS NOT NULL), 0)
            )::numeric(6,2)::text
        END,
        (SUM(COALESCE(taxas_centavos, 0))::numeric / 100)::numeric(12,2)::text
    FROM filtro
    WHERE chave_calc IS NOT NULL
    GROUP BY chave_calc;
$$;

GRANT EXECUTE ON FUNCTION hub_performance_totais(int, date, date, text, text, int) TO authenticated;
GRANT EXECUTE ON FUNCTION hub_performance_agrupado(int, date, date, text, text, int, text) TO authenticated;
