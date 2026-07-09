-- 0031 — `mv_performance_dia` + refresh + RPCs de resumo lendo da MV
-- (follow-up S7 / hub-performance — SC-004: GET /performance/resumo < 1s).
-- Mesma mitigação do follow-up da S6 (`mv_faturamento_dia`, migration 0028),
-- acionada pela evidência da onda de E2E da S7 (dec-029): ~900k linhas/1 ano
-- -> 1,6-2,2s HTTP end-to-end em todos os agrupamentos (EXPLAIN ANALYZE em
-- docs/plans/hub-frota/evidencias/S7/fase6-e2e-perf-resultado.md — custo
-- dominante é a CTE de 900k linhas re-escaneada 5x em `totais` e o
-- HashAggregate de 900k em `agrupado`). Idempotente (IF NOT EXISTS /
-- CREATE OR REPLACE). Aplicada por migrate.sh (registra em
-- "SchemaMigration" e envia SIGUSR1 ao PostgREST).
--
-- ── Desenho da MV ──────────────────────────────────────────────────────────
-- Grão = (id_empresa, data_periodo, periodo, entregador_id) — cobre os 3
-- `groupBy` do contrato (dia/periodo/entregador — Decision 12) e os filtros
-- `periodo`/`entregadorId`. Todas as colunas do grão são NOT NULL no fato
-- (0014: `entregador_id` é obrigatório neste CSV, ao contrário do
-- faturamento) — o índice ÚNICO exigido pelo REFRESH CONCURRENTLY sai
-- direto das colunas do grão, sem coluna-chave sintética.
--
-- Métricas DECOMPONÍVEIS (nunca média de médias — SC-002): Σ de cada
-- contador de corridas, Σ`taxas_centavos` e, para `tempo_disponivel_medio`
-- (ponderado por `duracao`, dec-011/Decision 2/3), o numerador e o
-- denominador separados (Σ(pct×duração) e Σduração das linhas com pct
-- não-nulo) + Σpct e count(pct) para o fallback de média simples + o flag
-- bool_or(duracao IS NULL entre as elegíveis) que decide o ramo — as RPCs
-- recompõem EXATAMENTE a fórmula de 0030 a partir das somas
-- (Σnum/Σden; AVG = Σpct/count(pct)).
--
-- Única dimensão NÃO coberta: `subpraca` (fora do grão para não explodir a
-- cardinalidade; filtro raro, fora do caminho medido pelo SC-004). Quando
-- `p_subpraca` é informado, as RPCs caem no caminho antigo (tabela-base) —
-- fallback correto, mesma semântica de 0030 (e mesmo padrão de 0028).
--
-- ── Isolamento multi-tenant (CRÍTICO — MV NÃO tem RLS) ─────────────────────
-- Postgres não aplica policies de RLS a materialized views. O acesso à MV é
-- EXCLUSIVO via as RPCs abaixo: SELECT direto é REVOGADO dos papéis do
-- PostgREST (`authenticated`, `hub_web_anon`). As funções viram SECURITY
-- DEFINER (senão o invocador `authenticated` não leria a MV) e, para
-- preservar a MESMA defesa-em-profundidade da RLS de 0015
-- (`performanceturno_select_por_escopo`), aplicam o predicado da policy
-- explicitamente: `p_id_empresa = ANY (hub_jwt_escopo_ids())` — um
-- `p_id_empresa` fora do escopo do JWT retorna o MESMO resultado
-- vazio/zerado que a RLS retornava em 0030, inclusive no caminho de
-- fallback (tabela-base), que agora também roda como DEFINER. `search_path`
-- fixado (padrão obrigatório para SECURITY DEFINER).
--
-- ── Estratégia de refresh / staleness ──────────────────────────────────────
-- Os fatos só mudam via pipeline de importações (S4, append-only). O
-- processador (hub-import-processor.js) chama `hub_performance_refresh_mv()`
-- ao final de toda importação de performance bem-sucedida
-- (completed/completed_with_errors) — staleness efetivo = a janela do
-- próprio processamento. Casos residuais (falha best-effort do refresh;
-- importação cancelada após inserir lotes) ficam visíveis em
-- GET /performance (tabela-base, sempre fresca) e entram no /resumo no
-- próximo refresh — aceito e documentado (contracts/performance-api.md).
-- RPC manual disponível para reconciliação.
--
-- REFRESH ... CONCURRENTLY não roda dentro de bloco de transação, e o
-- PostgREST envolve TODA RPC numa transação -> a função usa dblink (conexão
-- local via socket, `trust` no pg_hba padrão da imagem postgres) para
-- executar o REFRESH numa sessão própria, fora da transação. Fallback: se o
-- dblink falhar, REFRESH bloqueante (permitido em transação; trava leituras
-- da MV por alguns segundos — aceitável 1x/dia).

CREATE EXTENSION IF NOT EXISTS dblink;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_performance_dia AS
    SELECT
        id_empresa,
        data_periodo,
        periodo,
        entregador_id,
        COUNT(*)::bigint                          AS quantidade,
        SUM(corridas_ofertadas)::bigint           AS corridas_ofertadas,
        SUM(corridas_aceitas)::bigint             AS corridas_aceitas,
        SUM(corridas_completadas)::bigint         AS corridas_completadas,
        SUM(COALESCE(taxas_centavos, 0))::bigint  AS taxas_centavos,
        -- Decomposição do tempo_disponivel_medio (fórmula de 0030):
        COUNT(*) FILTER (WHERE tempo_disponivel_pct IS NOT NULL)::bigint
            AS pct_n,
        SUM(tempo_disponivel_pct)
            FILTER (WHERE tempo_disponivel_pct IS NOT NULL)
            AS pct_soma,
        bool_or(duracao IS NULL)
            FILTER (WHERE tempo_disponivel_pct IS NOT NULL)
            AS pct_com_duracao_nula,
        SUM(tempo_disponivel_pct * EXTRACT(EPOCH FROM duracao))
            FILTER (WHERE tempo_disponivel_pct IS NOT NULL)
            AS pct_x_duracao_soma,
        SUM(EXTRACT(EPOCH FROM duracao))
            FILTER (WHERE tempo_disponivel_pct IS NOT NULL)
            AS duracao_epoch_soma
    FROM "PerformanceTurno"
    GROUP BY id_empresa, data_periodo, periodo, entregador_id
WITH DATA;

-- Índice ÚNICO (pré-requisito do REFRESH CONCURRENTLY) — também serve o
-- range-scan principal (id_empresa + data_periodo).
CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_performance_dia_grao
    ON mv_performance_dia (id_empresa, data_periodo, periodo, entregador_id);

-- Índices de filtro (espelham os da tabela-base, 0014, + filtro periodo).
CREATE INDEX IF NOT EXISTS idx_mv_performance_dia_empresa_periodo
    ON mv_performance_dia (id_empresa, periodo, data_periodo);
CREATE INDEX IF NOT EXISTS idx_mv_performance_dia_empresa_entregador
    ON mv_performance_dia (id_empresa, entregador_id, data_periodo);

-- Sem SELECT direto para os papéis do PostgREST (isolamento multi-tenant:
-- MV não tem RLS — acesso só via RPC com filtro explícito de escopo).
REVOKE ALL ON mv_performance_dia FROM PUBLIC;
REVOKE ALL ON mv_performance_dia FROM authenticated;
REVOKE ALL ON mv_performance_dia FROM hub_web_anon;

-- ─────────────────────────────────────────────────────────────────────────
-- hub_performance_totais — mesma assinatura/contrato de 0030 (taxas com 4
-- casas, tempo com 2, taxas_reais '0.00' em vazio; NULL nos denominadores
-- zero — SC-009). MV quando p_subpraca IS NULL; senão, caminho original na
-- tabela-base. plpgsql (era sql em 0030) para o branch MV×fallback — todas
-- as colunas internas recebem alias f_* (nomes de saída viram variáveis em
-- plpgsql; referência não-qualificada seria ambígua).
-- ─────────────────────────────────────────────────────────────────────────

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
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- Predicado da policy de 0015 aplicado explicitamente (DEFINER não passa
    -- pela RLS): fora do escopo do JWT -> mesma linha zerada que a RLS
    -- produzia em 0030 (zero linhas no filtro).
    IF p_id_empresa IS NULL OR NOT (p_id_empresa = ANY (hub_jwt_escopo_ids())) THEN
        RETURN QUERY SELECT 0::int, NULL::text, NULL::text, NULL::text,
                            (0::numeric(12,2))::text;
        RETURN;
    END IF;

    IF p_subpraca IS NULL THEN
        RETURN QUERY
        WITH filtro AS (
            SELECT mv.corridas_ofertadas   AS f_ofertadas,
                   mv.corridas_aceitas     AS f_aceitas,
                   mv.corridas_completadas AS f_completadas,
                   mv.taxas_centavos       AS f_taxas,
                   mv.pct_n                AS f_pct_n,
                   mv.pct_soma             AS f_pct_soma,
                   mv.pct_com_duracao_nula AS f_pct_dur_nula,
                   mv.pct_x_duracao_soma   AS f_pct_x_dur,
                   mv.duracao_epoch_soma   AS f_dur
            FROM mv_performance_dia mv
            WHERE mv.id_empresa = p_id_empresa
              AND mv.data_periodo BETWEEN p_de AND p_ate
              AND (p_periodo IS NULL OR mv.periodo = p_periodo)
              AND (p_entregador_id IS NULL OR mv.entregador_id = p_entregador_id)
        )
        SELECT
            COALESCE((SELECT SUM(f.f_completadas) FROM filtro f), 0)::int,
            (
                SELECT (SUM(f.f_aceitas)::numeric / NULLIF(SUM(f.f_ofertadas), 0))::numeric(6,4)::text
                FROM filtro f
            ),
            (
                SELECT (SUM(f.f_completadas)::numeric / NULLIF(SUM(f.f_aceitas), 0))::numeric(6,4)::text
                FROM filtro f
            ),
            (
                SELECT
                    CASE
                        WHEN COALESCE(SUM(f.f_pct_n), 0) = 0
                            THEN NULL
                        WHEN bool_or(f.f_pct_dur_nula)
                            THEN (SUM(f.f_pct_soma) / SUM(f.f_pct_n))::numeric(6,2)::text
                        ELSE (
                            SUM(f.f_pct_x_dur) / NULLIF(SUM(f.f_dur), 0)
                        )::numeric(6,2)::text
                    END
                FROM filtro f
            ),
            (COALESCE((SELECT SUM(f.f_taxas) FROM filtro f), 0)::numeric / 100)::numeric(12,2)::text;
    ELSE
        -- Fallback (filtro por subpraça — dimensão fora da MV): corpo de 0030.
        RETURN QUERY
        WITH filtro AS (
            SELECT pt.corridas_ofertadas    AS f_ofertadas,
                   pt.corridas_aceitas      AS f_aceitas,
                   pt.corridas_completadas  AS f_completadas,
                   pt.tempo_disponivel_pct  AS f_pct,
                   pt.duracao               AS f_duracao,
                   pt.taxas_centavos        AS f_taxas
            FROM "PerformanceTurno" pt
            WHERE pt.id_empresa = p_id_empresa
              AND pt.data_periodo BETWEEN p_de AND p_ate
              AND (p_periodo IS NULL OR pt.periodo = p_periodo)
              AND pt.subpraca = p_subpraca
              AND (p_entregador_id IS NULL OR pt.entregador_id = p_entregador_id)
        )
        SELECT
            COALESCE((SELECT SUM(f.f_completadas) FROM filtro f), 0)::int,
            (
                SELECT (SUM(f.f_aceitas)::numeric / NULLIF(SUM(f.f_ofertadas), 0))::numeric(6,4)::text
                FROM filtro f
            ),
            (
                SELECT (SUM(f.f_completadas)::numeric / NULLIF(SUM(f.f_aceitas), 0))::numeric(6,4)::text
                FROM filtro f
            ),
            (
                SELECT
                    CASE
                        WHEN COUNT(*) FILTER (WHERE f.f_pct IS NOT NULL) = 0
                            THEN NULL
                        WHEN bool_or(f.f_duracao IS NULL) FILTER (WHERE f.f_pct IS NOT NULL)
                            THEN (AVG(f.f_pct) FILTER (WHERE f.f_pct IS NOT NULL))::numeric(6,2)::text
                        ELSE (
                            SUM(f.f_pct * EXTRACT(EPOCH FROM f.f_duracao))
                                FILTER (WHERE f.f_pct IS NOT NULL)
                            / NULLIF(SUM(EXTRACT(EPOCH FROM f.f_duracao))
                                FILTER (WHERE f.f_pct IS NOT NULL), 0)
                        )::numeric(6,2)::text
                    END
                FROM filtro f
            ),
            (COALESCE((SELECT SUM(COALESCE(f.f_taxas, 0)) FROM filtro f), 0)::numeric / 100)::numeric(12,2)::text;
    END IF;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- hub_performance_agrupado — mesma assinatura/contrato de 0030. MV cobre os
-- 3 group_by (dia/periodo/entregador); fallback só para p_subpraca.
-- ─────────────────────────────────────────────────────────────────────────

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
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_id_empresa IS NULL OR NOT (p_id_empresa = ANY (hub_jwt_escopo_ids())) THEN
        RETURN; -- mesmo resultado (0 linhas) que a RLS produzia em 0030
    END IF;

    IF p_subpraca IS NULL THEN
        RETURN QUERY
        WITH filtro AS (
            SELECT
                CASE p_group_by
                    WHEN 'dia'        THEN mv.data_periodo::text
                    WHEN 'periodo'    THEN mv.periodo
                    WHEN 'entregador' THEN mv.entregador_id::text
                END AS chave_calc,
                mv.quantidade           AS f_quantidade,
                mv.corridas_ofertadas   AS f_ofertadas,
                mv.corridas_aceitas     AS f_aceitas,
                mv.corridas_completadas AS f_completadas,
                mv.taxas_centavos       AS f_taxas,
                mv.pct_n                AS f_pct_n,
                mv.pct_soma             AS f_pct_soma,
                mv.pct_com_duracao_nula AS f_pct_dur_nula,
                mv.pct_x_duracao_soma   AS f_pct_x_dur,
                mv.duracao_epoch_soma   AS f_dur
            FROM mv_performance_dia mv
            WHERE mv.id_empresa = p_id_empresa
              AND mv.data_periodo BETWEEN p_de AND p_ate
              AND (p_periodo IS NULL OR mv.periodo = p_periodo)
              AND (p_entregador_id IS NULL OR mv.entregador_id = p_entregador_id)
        )
        SELECT
            f.chave_calc,
            SUM(f.f_quantidade)::int,
            SUM(f.f_completadas)::int,
            (SUM(f.f_aceitas)::numeric / NULLIF(SUM(f.f_ofertadas), 0))::numeric(6,4)::text,
            (SUM(f.f_completadas)::numeric / NULLIF(SUM(f.f_aceitas), 0))::numeric(6,4)::text,
            CASE
                WHEN COALESCE(SUM(f.f_pct_n), 0) = 0
                    THEN NULL
                WHEN bool_or(f.f_pct_dur_nula)
                    THEN (SUM(f.f_pct_soma) / SUM(f.f_pct_n))::numeric(6,2)::text
                ELSE (
                    SUM(f.f_pct_x_dur) / NULLIF(SUM(f.f_dur), 0)
                )::numeric(6,2)::text
            END,
            (SUM(f.f_taxas)::numeric / 100)::numeric(12,2)::text
        FROM filtro f
        WHERE f.chave_calc IS NOT NULL
        GROUP BY f.chave_calc;
    ELSE
        -- Fallback (filtro por subpraça): corpo de 0030.
        RETURN QUERY
        WITH filtro AS (
            SELECT
                CASE p_group_by
                    WHEN 'dia'        THEN pt.data_periodo::text
                    WHEN 'periodo'    THEN pt.periodo
                    WHEN 'entregador' THEN pt.entregador_id::text
                END AS chave_calc,
                pt.corridas_ofertadas   AS f_ofertadas,
                pt.corridas_aceitas     AS f_aceitas,
                pt.corridas_completadas AS f_completadas,
                pt.tempo_disponivel_pct AS f_pct,
                pt.duracao              AS f_duracao,
                pt.taxas_centavos       AS f_taxas
            FROM "PerformanceTurno" pt
            WHERE pt.id_empresa = p_id_empresa
              AND pt.data_periodo BETWEEN p_de AND p_ate
              AND (p_periodo IS NULL OR pt.periodo = p_periodo)
              AND pt.subpraca = p_subpraca
              AND (p_entregador_id IS NULL OR pt.entregador_id = p_entregador_id)
        )
        SELECT
            f.chave_calc,
            COUNT(*)::int,
            SUM(f.f_completadas)::int,
            (SUM(f.f_aceitas)::numeric / NULLIF(SUM(f.f_ofertadas), 0))::numeric(6,4)::text,
            (SUM(f.f_completadas)::numeric / NULLIF(SUM(f.f_aceitas), 0))::numeric(6,4)::text,
            CASE
                WHEN COUNT(*) FILTER (WHERE f.f_pct IS NOT NULL) = 0
                    THEN NULL
                WHEN bool_or(f.f_duracao IS NULL) FILTER (WHERE f.f_pct IS NOT NULL)
                    THEN (AVG(f.f_pct) FILTER (WHERE f.f_pct IS NOT NULL))::numeric(6,2)::text
                ELSE (
                    SUM(f.f_pct * EXTRACT(EPOCH FROM f.f_duracao))
                        FILTER (WHERE f.f_pct IS NOT NULL)
                    / NULLIF(SUM(EXTRACT(EPOCH FROM f.f_duracao))
                        FILTER (WHERE f.f_pct IS NOT NULL), 0)
                )::numeric(6,2)::text
            END,
            (SUM(COALESCE(f.f_taxas, 0))::numeric / 100)::numeric(12,2)::text
        FROM filtro f
        WHERE f.chave_calc IS NOT NULL
        GROUP BY f.chave_calc;
    END IF;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- hub_performance_refresh_mv — refresh CONCURRENTLY via dblink (sessão
-- própria, fora da transação do PostgREST); fallback bloqueante. Chamada
-- pelo processador de importações e disponível como RPC manual.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION hub_performance_refresh_mv()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    t0    timestamptz := clock_timestamp();
    modo  text;
BEGIN
    -- Só para chamadores com escopo (bloqueia anon/JWT sem escopo). O
    -- refresh em si não expõe dado algum — o guard limita o vetor de abuso.
    IF COALESCE(array_length(hub_jwt_escopo_ids(), 1), 0) = 0 THEN
        RAISE EXCEPTION 'escopo vazio — refresh negado'
            USING ERRCODE = '42501';
    END IF;

    BEGIN
        PERFORM dblink_exec(
            'dbname=' || current_database() || ' user=' || current_user,
            'REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_performance_dia'
        );
        modo := 'concurrent';
    EXCEPTION WHEN OTHERS THEN
        -- dblink indisponível/falhou: refresh bloqueante (válido em
        -- transação; trava leituras da MV durante a execução).
        REFRESH MATERIALIZED VIEW public.mv_performance_dia;
        modo := 'blocking';
    END;

    RETURN jsonb_build_object(
        'modo', modo,
        'duracao_ms', round(extract(epoch FROM clock_timestamp() - t0) * 1000)
    );
END;
$$;

-- CREATE OR REPLACE preserva grants existentes, mas os re-declaramos para a
-- migration ser autocontida em banco fresco (hub-test-*).
REVOKE ALL ON FUNCTION hub_performance_refresh_mv() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_performance_totais(int, date, date, text, text, int) TO authenticated;
GRANT EXECUTE ON FUNCTION hub_performance_agrupado(int, date, date, text, text, int, text) TO authenticated;
GRANT EXECUTE ON FUNCTION hub_performance_refresh_mv() TO authenticated;
