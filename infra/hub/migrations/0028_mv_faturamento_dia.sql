-- 0028 — `mv_faturamento_dia` + refresh + RPCs de resumo lendo da MV
-- (follow-up S6 / hub-faturamento — SC-004: GET /faturamento/resumo < 1s).
-- Mitigação PRÉ-APROVADA no plano técnico §12.6 ("se o dashboard pesar
-- (>1 s), criar view materializada diária mv_faturamento_dia"), acionada
-- pela evidência da onda-008 (dec-035): ~900k linhas/1 ano -> 2,2-2,6s sem
-- groupBy e 1,6-1,7s com groupBy=categoria (EXPLAIN ANALYZE em
-- docs/plans/hub-frota/evidencias/S6/). Idempotente (IF NOT EXISTS /
-- CREATE OR REPLACE). Aplicada por migrate.sh (registra em
-- "SchemaMigration" e envia SIGUSR1 ao PostgREST).
--
-- ── Desenho da MV ──────────────────────────────────────────────────────────
-- Grão = (id_empresa, data_referencia, descricao, entregador_id) — MAIS fino
-- que o "por dia + categoria + flag" do §12.6, de propósito: com o
-- `entregador_id` no grão a MV cobre TAMBÉM `groupBy=entregador`, o filtro
-- `entregadorId` e o card `entregadores_distintos` (COUNT(DISTINCT) não é
-- decomponível a partir de uma flag booleana). Medido no seed real de 900k
-- linhas: 27.960 linhas na MV (compressão ~32x) — agregação em milissegundos.
-- `entregador_key` (COALESCE(entregador_id, 0)) existe só para o índice
-- ÚNICO: REFRESH CONCURRENTLY exige índice único por COLUNAS (sem expressão)
-- cobrindo todas as linhas, e `entregador_id` é NULL nos agregados/bônus
-- (0 nunca colide: `Entregador.id` é serial >= 1). `data_referencia` e
-- `descricao` são NOT NULL no fato (0013).
--
-- Única dimensão NÃO coberta: `subpraca` (fora do grão para não explodir a
-- cardinalidade; filtro raro, fora do caminho medido pelo SC-004). Quando
-- `p_subpraca` é informado, as RPCs caem no caminho antigo (tabela-base) —
-- fallback correto, mesma semântica de 0027.
--
-- ── Isolamento multi-tenant (CRÍTICO — MV NÃO tem RLS) ─────────────────────
-- Postgres não aplica policies de RLS a materialized views. O acesso à MV é
-- EXCLUSIVO via as RPCs abaixo: SELECT direto é REVOGADO dos papéis do
-- PostgREST (`authenticated`, `hub_web_anon`) — o PostgREST nem expõe a
-- relação sem privilégio. As funções viram SECURITY DEFINER (senão o
-- invocador `authenticated` não leria a MV) e, para preservar a MESMA
-- defesa-em-profundidade da RLS de 0015, aplicam o predicado da policy
-- explicitamente: `p_id_empresa = ANY (hub_jwt_escopo_ids())` — um
-- `p_id_empresa` fora do escopo do JWT retorna o MESMO resultado vazio/zerado
-- que a RLS retornava em 0027, inclusive no caminho de fallback
-- (tabela-base), que agora também roda como DEFINER. `search_path` fixado
-- (padrão obrigatório para SECURITY DEFINER).
--
-- ── Estratégia de refresh / staleness ──────────────────────────────────────
-- Os fatos só mudam via pipeline de importações (S4, append-only). O
-- processador (hub-import-processor.js) chama `hub_faturamento_refresh_mv()`
-- ao final de toda importação de faturamento bem-sucedida
-- (completed/completed_with_errors) — staleness efetivo = a janela do próprio
-- processamento (segundos/minutos, 1 arquivo/dia/tipo). Casos residuais
-- (falha best-effort do refresh; importação cancelada após inserir lotes)
-- ficam visíveis em GET /faturamento (tabela-base, sempre fresca) e entram
-- no /resumo no próximo refresh — aceito e documentado
-- (contracts/faturamento-api.md). RPC manual disponível para reconciliação.
--
-- REFRESH ... CONCURRENTLY não roda dentro de bloco de transação, e o
-- PostgREST envolve TODA RPC numa transação -> a função usa dblink (conexão
-- local via socket, `trust` no pg_hba padrão da imagem postgres) para
-- executar o REFRESH numa sessão própria, fora da transação. Fallback: se o
-- dblink falhar, REFRESH bloqueante (permitido em transação; trava leituras
-- da MV por ~1-3s — aceitável 1x/dia).

CREATE EXTENSION IF NOT EXISTS dblink;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_faturamento_dia AS
    SELECT
        id_empresa,
        data_referencia,
        descricao,
        entregador_id,
        COALESCE(entregador_id, 0)   AS entregador_key,
        (entregador_id IS NOT NULL)  AS com_entregador,
        COUNT(*)::bigint             AS quantidade,
        SUM(valor)::numeric(14,2)    AS total
    FROM "FaturamentoLancamento"
    GROUP BY id_empresa, data_referencia, descricao, entregador_id
WITH DATA;

-- Índice ÚNICO (pré-requisito do REFRESH CONCURRENTLY) — também serve o
-- range-scan principal (id_empresa + data_referencia).
CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_faturamento_dia_grao
    ON mv_faturamento_dia (id_empresa, data_referencia, descricao, entregador_key);

-- Índices de filtro (espelham os da tabela-base, 0013).
CREATE INDEX IF NOT EXISTS idx_mv_faturamento_dia_empresa_descricao
    ON mv_faturamento_dia (id_empresa, descricao, data_referencia);
CREATE INDEX IF NOT EXISTS idx_mv_faturamento_dia_empresa_entregador
    ON mv_faturamento_dia (id_empresa, entregador_id, data_referencia);

-- Sem SELECT direto para os papéis do PostgREST (isolamento multi-tenant:
-- MV não tem RLS — acesso só via RPC com filtro explícito de escopo).
REVOKE ALL ON mv_faturamento_dia FROM PUBLIC;
REVOKE ALL ON mv_faturamento_dia FROM authenticated;
REVOKE ALL ON mv_faturamento_dia FROM hub_web_anon;

-- ─────────────────────────────────────────────────────────────────────────
-- hub_faturamento_totais — mesma assinatura/contrato de 0027 (valores como
-- text, Decision 7; linha zerada em período vazio, FR-012). MV quando
-- p_subpraca IS NULL; senão, caminho original na tabela-base.
-- ─────────────────────────────────────────────────────────────────────────

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
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- Predicado da policy de 0015 aplicado explicitamente (DEFINER não passa
    -- pela RLS): fora do escopo do JWT -> mesma linha zerada que a RLS
    -- produzia em 0027 (zero linhas no filtro).
    IF p_id_empresa IS NULL OR NOT (p_id_empresa = ANY (hub_jwt_escopo_ids())) THEN
        RETURN QUERY SELECT 0::numeric(12,2)::text, NULL::text, 0::int;
        RETURN;
    END IF;

    IF p_subpraca IS NULL THEN
        RETURN QUERY
        WITH filtro AS (
            SELECT mv.descricao AS f_descricao,
                   mv.entregador_id AS f_entregador_id,
                   mv.total AS f_total
            FROM mv_faturamento_dia mv
            WHERE mv.id_empresa = p_id_empresa
              AND mv.data_referencia BETWEEN p_de AND p_ate
              AND (p_categoria IS NULL OR mv.descricao = p_categoria)
              AND (p_entregador_id IS NULL OR mv.entregador_id = p_entregador_id)
              AND (p_com_entregador IS NULL OR mv.com_entregador = p_com_entregador)
        )
        SELECT
            COALESCE((SELECT SUM(f_total) FROM filtro), 0)::numeric(12,2)::text,
            (
                SELECT f_descricao FROM filtro
                GROUP BY f_descricao
                ORDER BY SUM(f_total) DESC, f_descricao ASC
                LIMIT 1
            ),
            (SELECT COUNT(DISTINCT f_entregador_id) FROM filtro)::int;
    ELSE
        -- Fallback (filtro por subpraça — dimensão fora da MV): corpo de 0027.
        RETURN QUERY
        WITH filtro AS (
            SELECT fl.descricao AS f_descricao,
                   fl.entregador_id AS f_entregador_id,
                   fl.valor AS f_valor
            FROM "FaturamentoLancamento" fl
            WHERE fl.id_empresa = p_id_empresa
              AND fl.data_referencia BETWEEN p_de AND p_ate
              AND (p_categoria IS NULL OR fl.descricao = p_categoria)
              AND (p_entregador_id IS NULL OR fl.entregador_id = p_entregador_id)
              AND fl.subpraca = p_subpraca
              AND (
                    p_com_entregador IS NULL
                    OR (p_com_entregador AND fl.entregador_id IS NOT NULL)
                    OR (NOT p_com_entregador AND fl.entregador_id IS NULL)
                  )
        )
        SELECT
            COALESCE((SELECT SUM(f_valor) FROM filtro), 0)::numeric(12,2)::text,
            (
                SELECT f_descricao FROM filtro
                GROUP BY f_descricao
                ORDER BY SUM(f_valor) DESC, f_descricao ASC
                LIMIT 1
            ),
            (SELECT COUNT(DISTINCT f_entregador_id) FROM filtro)::int;
    END IF;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- hub_faturamento_agrupado — mesma assinatura/contrato de 0027. MV cobre os
-- 3 group_by (dia/categoria/entregador); fallback só para p_subpraca.
-- ─────────────────────────────────────────────────────────────────────────

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
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_id_empresa IS NULL OR NOT (p_id_empresa = ANY (hub_jwt_escopo_ids())) THEN
        RETURN; -- mesmo resultado (0 linhas) que a RLS produzia em 0027
    END IF;

    IF p_subpraca IS NULL THEN
        RETURN QUERY
        WITH filtro AS (
            SELECT
                CASE p_group_by
                    WHEN 'dia'        THEN mv.data_referencia::text
                    WHEN 'categoria'  THEN mv.descricao
                    WHEN 'entregador' THEN COALESCE(mv.entregador_id::text, 'agregados_bonus')
                END AS chave_calc,
                mv.total AS f_total,
                mv.quantidade AS f_quantidade
            FROM mv_faturamento_dia mv
            WHERE mv.id_empresa = p_id_empresa
              AND mv.data_referencia BETWEEN p_de AND p_ate
              AND (p_categoria IS NULL OR mv.descricao = p_categoria)
              AND (p_entregador_id IS NULL OR mv.entregador_id = p_entregador_id)
              AND (p_com_entregador IS NULL OR mv.com_entregador = p_com_entregador)
        )
        SELECT
            chave_calc,
            SUM(f_total)::numeric(12,2)::text,
            SUM(f_quantidade)::int
        FROM filtro
        WHERE chave_calc IS NOT NULL
        GROUP BY chave_calc;
    ELSE
        -- Fallback (filtro por subpraça): corpo de 0027.
        RETURN QUERY
        WITH filtro AS (
            SELECT
                CASE p_group_by
                    WHEN 'dia'        THEN fl.data_referencia::text
                    WHEN 'categoria'  THEN fl.descricao
                    WHEN 'entregador' THEN COALESCE(fl.entregador_id::text, 'agregados_bonus')
                END AS chave_calc,
                fl.valor AS f_valor
            FROM "FaturamentoLancamento" fl
            WHERE fl.id_empresa = p_id_empresa
              AND fl.data_referencia BETWEEN p_de AND p_ate
              AND (p_categoria IS NULL OR fl.descricao = p_categoria)
              AND (p_entregador_id IS NULL OR fl.entregador_id = p_entregador_id)
              AND fl.subpraca = p_subpraca
              AND (
                    p_com_entregador IS NULL
                    OR (p_com_entregador AND fl.entregador_id IS NOT NULL)
                    OR (NOT p_com_entregador AND fl.entregador_id IS NULL)
                  )
        )
        SELECT
            chave_calc,
            SUM(f_valor)::numeric(12,2)::text,
            COUNT(*)::int
        FROM filtro
        WHERE chave_calc IS NOT NULL
        GROUP BY chave_calc;
    END IF;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- hub_faturamento_refresh_mv — refresh CONCURRENTLY via dblink (sessão
-- própria, fora da transação do PostgREST); fallback bloqueante. Chamada
-- pelo processador de importações e disponível como RPC manual.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION hub_faturamento_refresh_mv()
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
            'REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_faturamento_dia'
        );
        modo := 'concurrent';
    EXCEPTION WHEN OTHERS THEN
        -- dblink indisponível/falhou: refresh bloqueante (válido em
        -- transação; trava leituras da MV durante a execução).
        REFRESH MATERIALIZED VIEW public.mv_faturamento_dia;
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
REVOKE ALL ON FUNCTION hub_faturamento_refresh_mv() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_faturamento_totais(int, date, date, text, int, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION hub_faturamento_agrupado(int, date, date, text, int, text, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION hub_faturamento_refresh_mv() TO authenticated;
