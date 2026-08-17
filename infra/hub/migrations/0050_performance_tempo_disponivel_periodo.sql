-- 0050 — `tempo disponível` passa a medir o PERÍODO, e passa a somar as praças
-- do mesmo turno. Corrige a métrica de FR-003/FR-004 (substitui a fórmula de
-- 0030/0031, decidida em dec-011 antes de conhecermos a semântica do CSV).
--
-- ── O que estava errado (medido no CSV real, 2.720 linhas / 2.669 turnos) ────
--
-- (1) A COLUNA ERRADA. `tempo_disponivel_pct` é o `tempo_disponivel_escalado`
--     do arquivo, e esse campo NÃO é `absoluto / duração do período`: é o
--     tempo online sobre o tempo que a pessoa SE ESCALOU. Em 229 linhas de
--     turno único ele diverge de `absoluto/duração` — e sempre para mais,
--     nunca para menos (0 casos ao contrário), com p95 de 36pp e máximo de
--     96pp. Quem se escalou meia hora de um turno de 4h e ficou online essa
--     meia hora aparecia com ~100%.
--
-- (2) O PESO ERRADO quando o entregador roda em mais de uma praça. Nos 47
--     turnos multi-praça do arquivo, a `duracao_do_periodo` vem REPETIDA
--     idêntica em todas as linhas (47 de 47). Ponderar por `duracao` da LINHA
--     conta o mesmo turno 2-3 vezes no denominador, e a média ponderada
--     degenera em média simples dos percentuais. Caso real do arquivo, turno
--     de 3,98h em 2 sub-praças: linhas com 0,58% e 99,80% -> a tela mostrava
--     50,19% para alguém que ficou online 0,66h de 3,98h (16,68%).
--
--     Impacto medido por entregador (n=755): 24,5% divergiam >1pp, 13,1%
--     >10pp, 7,5% >20pp (máx +69pp, mín -30pp) — e 7-8% trocavam de lado numa
--     meta de 60%/70% na tela de metas (0048/0049).
--
-- ── A fórmula nova (decisão do operador, 2026-08-17) ────────────────────────
--
--     tempo disponível = Σ tempo_disponivel_absoluto / Σ duracao_do_periodo
--
-- com a duração contada UMA VEZ POR TURNO (entregador × dia × período), que é
-- exatamente o grão da `mv_performance_dia`. Somar o online das praças e
-- dividir pela duração única é o que o dado real pede: nos 47 turnos
-- multi-praça a soma encosta no teto sem furar (99,91% · 99,72% · 99,53% ·
-- 99,23%…) — se a origem repetisse o tempo do turno em cada praça em vez de
-- reparti-lo, esses casos estourariam 150-200%.
--
-- Teto de 100% (`LEAST`): a origem emitiu 3 linhas gêmeas em 2.720 (mesmos
-- online/corridas/taxas, diferindo só por `sub_praca` vazia numa delas), e o
-- dedupe por `hash_linha` não as pega justamente porque a sub-praça difere.
-- Uma delas produzia um turno de 158%, número fisicamente impossível que
-- queima a confiança na tela inteira. O clamp é por TURNO (e por linha, na
-- coluna gerada), não sobre o agregado — clampar depois de somar esconderia
-- o problema de todo mundo dentro do de um.
--
-- O que este arquivo NÃO faz: não deduplica as linhas gêmeas (0,1% do
-- arquivo; elas ainda contam corridas em dobro) e não mexe em
-- `tempo_disponivel_pct`, que continua sendo o `escalado` da origem — fato
-- append-only, entra no `hash_linha`, e apagá-lo destruiria a rastreabilidade
-- do que o parceiro nos mandou.
--
-- Idempotente (IF NOT EXISTS / DROP+CREATE / CREATE OR REPLACE). Aplicada por
-- migrate.sh (registra em "SchemaMigration" e envia SIGUSR1 ao PostgREST).
--
-- ⚠️ CUSTO DE APLICAÇÃO: `ADD COLUMN ... GENERATED ... STORED` reescreve a
-- tabela sob ACCESS EXCLUSIVE, e o CREATE da MV a varre inteira. Em
-- `PerformanceTurno` (fato append-only, sem escrita concorrente fora da
-- janela de importação) são segundos — mas é DDL bloqueante: aplicar fora do
-- horário de importação.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Coluna gerada — a MÉTRICA por linha, ao lado do `escalado` da origem.
--
-- Coluna gerada, e não cálculo no backend: a lista, o export CSV e o
-- julgamento de meta do servidor leem esta mesma linha por PostgREST, que não
-- calcula expressão no `select=`. Fazer a conta em JS exigiria trafegar dois
-- `interval` e reimplementar o parse em cada um dos três pontos — três cópias
-- de uma definição que precisa ser uma só.
--
-- `CASE` em vez de `LEAST(a, b)` direto: `LEAST` IGNORA NULL, então
-- `tempo_disponivel IS NULL` retornaria a duração e viraria 100% — inverteria
-- exatamente o pior caso (ausência de leitura virando nota máxima).
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "PerformanceTurno"
    ADD COLUMN IF NOT EXISTS tempo_disponivel_periodo_pct numeric(6,2)
    GENERATED ALWAYS AS (
        CASE
            WHEN tempo_disponivel IS NULL
              OR duracao IS NULL
              OR EXTRACT(EPOCH FROM duracao) <= 0
                THEN NULL
            ELSE LEAST(
                EXTRACT(EPOCH FROM tempo_disponivel) / EXTRACT(EPOCH FROM duracao) * 100,
                100::double precision
            )
        END
    ) STORED;

COMMENT ON COLUMN "PerformanceTurno".tempo_disponivel_periodo_pct IS
    '% do período em que o entregador esteve online NESTA linha '
    '(tempo_disponivel / duracao, teto 100). Somável entre as praças do mesmo '
    'turno. É a métrica exibida — tempo_disponivel_pct guarda o `escalado` cru '
    'da origem, que mede sobre o tempo escalado, não sobre o período.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. MV recriada — numerador e denominador, não mais média de percentuais.
--
-- DROP+CREATE porque `CREATE MATERIALIZED VIEW IF NOT EXISTS` não altera a
-- forma de uma MV existente. As RPCs abaixo dependem da MV só em tempo de
-- execução (função não registra dependência), então a ordem drop -> create ->
-- replace das funções é segura dentro da transação do migrate.sh.
--
-- Grão inalterado: (id_empresa, data_periodo, periodo, entregador_id) = O
-- TURNO. É o que torna a correção possível sem coluna nova de agrupamento —
-- `MAX(duracao)` no grão é a duração do período contada uma vez, e
-- `SUM(tempo_disponivel)` soma as praças. As duas somas são decomponíveis
-- (Σnum / Σden em qualquer agrupamento acima), então continua valendo o
-- SC-002: nunca média de médias.
--
-- Os campos `pct_*` de 0031 (pct_n / pct_soma / pct_x_duracao_soma /
-- duracao_epoch_soma / pct_com_duracao_nula) saem: existiam só para recompor
-- a fórmula antiga. Com eles ia embora também o ramo de fallback "alguma
-- `duracao` NULL -> média aritmética simples" — sem duração não há período,
-- e média de percentuais sobre período desconhecido é justamente o que esta
-- migration existe para eliminar. Linha sem `duracao` ou sem
-- `tempo_disponivel` fica FORA das duas somas: ausência de leitura, nunca
-- zero.
-- ─────────────────────────────────────────────────────────────────────────

DROP MATERIALIZED VIEW IF EXISTS mv_performance_dia;

CREATE MATERIALIZED VIEW mv_performance_dia AS
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
        -- Numerador: online do turno inteiro (praças somadas), com teto na
        -- duração do próprio turno (linhas gêmeas da origem).
        LEAST(
            SUM(EXTRACT(EPOCH FROM tempo_disponivel))
                FILTER (WHERE tempo_disponivel IS NOT NULL AND duracao IS NOT NULL),
            MAX(EXTRACT(EPOCH FROM duracao))
                FILTER (WHERE tempo_disponivel IS NOT NULL AND duracao IS NOT NULL)
        )                                         AS online_epoch,
        -- Denominador: a duração do período UMA vez (vem repetida por linha).
        MAX(EXTRACT(EPOCH FROM duracao))
            FILTER (WHERE tempo_disponivel IS NOT NULL AND duracao IS NOT NULL)
                                                  AS periodo_epoch
    FROM "PerformanceTurno"
    GROUP BY id_empresa, data_periodo, periodo, entregador_id
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_performance_dia_grao
    ON mv_performance_dia (id_empresa, data_periodo, periodo, entregador_id);
CREATE INDEX IF NOT EXISTS idx_mv_performance_dia_empresa_periodo
    ON mv_performance_dia (id_empresa, periodo, data_periodo);
CREATE INDEX IF NOT EXISTS idx_mv_performance_dia_empresa_entregador
    ON mv_performance_dia (id_empresa, entregador_id, data_periodo);

-- Isolamento multi-tenant inalterado (0031): MV não tem RLS, acesso só via as
-- RPCs SECURITY DEFINER que aplicam `hub_jwt_escopo_ids()` explicitamente.
REVOKE ALL ON mv_performance_dia FROM PUBLIC;
REVOKE ALL ON mv_performance_dia FROM authenticated;
REVOKE ALL ON mv_performance_dia FROM hub_web_anon;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. RPCs — mesma assinatura e mesmo contrato de 0030/0031 (taxas com 4
-- casas, tempo com 2, `taxas_reais` '0.00' em vazio, NULL nos denominadores
-- zero — SC-009). Só a fórmula do tempo muda.
--
-- O caminho de fallback (filtro por sub-praça, dimensão fora da MV) agora
-- agrupa por turno ANTES de somar: sem isso, um turno com duas linhas na
-- MESMA sub-praça (as gêmeas da origem) contaria a duração duas vezes — o
-- mesmo defeito, no caminho menos testado. Com o filtro de sub-praça o
-- denominador continua sendo o período INTEIRO: o número passa a ler "% do
-- período que a pessoa passou online nesta sub-praça", que é o que a
-- pergunta com filtro significa.
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
                   mv.online_epoch         AS f_online,
                   mv.periodo_epoch        AS f_periodo
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
                SELECT (SUM(f.f_online) / NULLIF(SUM(f.f_periodo), 0) * 100)::numeric(6,2)::text
                FROM filtro f
            ),
            (COALESCE((SELECT SUM(f.f_taxas) FROM filtro f), 0)::numeric / 100)::numeric(12,2)::text;
    ELSE
        RETURN QUERY
        WITH filtro AS (
            SELECT SUM(pt.corridas_ofertadas)          AS f_ofertadas,
                   SUM(pt.corridas_aceitas)            AS f_aceitas,
                   SUM(pt.corridas_completadas)        AS f_completadas,
                   SUM(COALESCE(pt.taxas_centavos, 0)) AS f_taxas,
                   LEAST(
                       SUM(EXTRACT(EPOCH FROM pt.tempo_disponivel))
                           FILTER (WHERE pt.tempo_disponivel IS NOT NULL AND pt.duracao IS NOT NULL),
                       MAX(EXTRACT(EPOCH FROM pt.duracao))
                           FILTER (WHERE pt.tempo_disponivel IS NOT NULL AND pt.duracao IS NOT NULL)
                   )                                   AS f_online,
                   MAX(EXTRACT(EPOCH FROM pt.duracao))
                       FILTER (WHERE pt.tempo_disponivel IS NOT NULL AND pt.duracao IS NOT NULL)
                                                       AS f_periodo
            FROM "PerformanceTurno" pt
            WHERE pt.id_empresa = p_id_empresa
              AND pt.data_periodo BETWEEN p_de AND p_ate
              AND (p_periodo IS NULL OR pt.periodo = p_periodo)
              AND pt.subpraca = p_subpraca
              AND (p_entregador_id IS NULL OR pt.entregador_id = p_entregador_id)
            GROUP BY pt.entregador_id, pt.data_periodo, pt.periodo
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
                SELECT (SUM(f.f_online) / NULLIF(SUM(f.f_periodo), 0) * 100)::numeric(6,2)::text
                FROM filtro f
            ),
            (COALESCE((SELECT SUM(f.f_taxas) FROM filtro f), 0)::numeric / 100)::numeric(12,2)::text;
    END IF;
END;
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
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_id_empresa IS NULL OR NOT (p_id_empresa = ANY (hub_jwt_escopo_ids())) THEN
        RETURN;
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
                mv.online_epoch         AS f_online,
                mv.periodo_epoch        AS f_periodo
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
            (SUM(f.f_online) / NULLIF(SUM(f.f_periodo), 0) * 100)::numeric(6,2)::text,
            (SUM(f.f_taxas)::numeric / 100)::numeric(12,2)::text
        FROM filtro f
        WHERE f.chave_calc IS NOT NULL
        GROUP BY f.chave_calc;
    ELSE
        RETURN QUERY
        WITH filtro AS (
            SELECT
                CASE p_group_by
                    WHEN 'dia'        THEN pt.data_periodo::text
                    WHEN 'periodo'    THEN pt.periodo
                    WHEN 'entregador' THEN pt.entregador_id::text
                END                                    AS chave_calc,
                COUNT(*)                               AS f_quantidade,
                SUM(pt.corridas_ofertadas)             AS f_ofertadas,
                SUM(pt.corridas_aceitas)               AS f_aceitas,
                SUM(pt.corridas_completadas)           AS f_completadas,
                SUM(COALESCE(pt.taxas_centavos, 0))    AS f_taxas,
                LEAST(
                    SUM(EXTRACT(EPOCH FROM pt.tempo_disponivel))
                        FILTER (WHERE pt.tempo_disponivel IS NOT NULL AND pt.duracao IS NOT NULL),
                    MAX(EXTRACT(EPOCH FROM pt.duracao))
                        FILTER (WHERE pt.tempo_disponivel IS NOT NULL AND pt.duracao IS NOT NULL)
                )                                      AS f_online,
                MAX(EXTRACT(EPOCH FROM pt.duracao))
                    FILTER (WHERE pt.tempo_disponivel IS NOT NULL AND pt.duracao IS NOT NULL)
                                                       AS f_periodo
            FROM "PerformanceTurno" pt
            WHERE pt.id_empresa = p_id_empresa
              AND pt.data_periodo BETWEEN p_de AND p_ate
              AND (p_periodo IS NULL OR pt.periodo = p_periodo)
              AND pt.subpraca = p_subpraca
              AND (p_entregador_id IS NULL OR pt.entregador_id = p_entregador_id)
            GROUP BY pt.entregador_id, pt.data_periodo, pt.periodo
        )
        SELECT
            f.chave_calc,
            SUM(f.f_quantidade)::int,
            SUM(f.f_completadas)::int,
            (SUM(f.f_aceitas)::numeric / NULLIF(SUM(f.f_ofertadas), 0))::numeric(6,4)::text,
            (SUM(f.f_completadas)::numeric / NULLIF(SUM(f.f_aceitas), 0))::numeric(6,4)::text,
            (SUM(f.f_online) / NULLIF(SUM(f.f_periodo), 0) * 100)::numeric(6,2)::text,
            (SUM(f.f_taxas)::numeric / 100)::numeric(12,2)::text
        FROM filtro f
        WHERE f.chave_calc IS NOT NULL
        GROUP BY f.chave_calc;
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION hub_performance_totais(int, date, date, text, text, int) TO authenticated;
GRANT EXECUTE ON FUNCTION hub_performance_agrupado(int, date, date, text, text, int, text) TO authenticated;
