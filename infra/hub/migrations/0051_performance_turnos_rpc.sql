-- 0051 — a unidade da tela de Performance passa a ser o TURNO.
--
-- Plano: docs/plans/performance-linha-por-turno.md
--
-- ── O problema ──────────────────────────────────────────────────────────────
--
-- A meta é cadastrada por PRAÇA × TURNO (0048/0049) e vinha sendo aplicada por
-- LINHA — mas a linha é a fatia de uma praça DENTRO do turno. Quem roda em
-- duas praças recebia dois vereditos para o mesmo turno, e nenhum dos dois
-- números era o desempenho da pessoa naquele turno.
--
-- Caso reproduzido no hub-homolog (entregador `DEMO 0050 Duas Pracas`,
-- 2026-08-10): a tabela mostrava linhas de 25,0% e 12,5%; o turno foi 37,5% —
-- que é o que o CARD já mostrava ao filtrar por esse entregador. Tabela e card
-- discordavam sobre o mesmo dia da mesma pessoa.
--
-- ── O que este arquivo faz ──────────────────────────────────────────────────
--
-- 1. Completa `mv_performance_dia` com os 3 contadores que faltavam
--    (rejeitadas, canceladas, pedidos concluídos) — o grão da MV JÁ é o turno
--    (id_empresa, data_periodo, periodo, entregador_id) desde 0031, é isso que
--    torna esta mudança barata.
-- 2. Cria `hub_performance_turnos(...)`: a lista paginada NO GRÃO DO TURNO,
--    com as praças do turno como detalhe (`pracas` jsonb) e `total_turnos`.
--    A FORMA dessa consulta foi medida sob 900k turnos — ver o bloco 3.
-- 3. Substitui o filtro de sub-praça das RPCs de resumo por um SEMI-JOIN.
--
-- ── (3) merece explicação: é MUDANÇA DE SEMÂNTICA, decidida pelo operador ───
--
-- D1 do plano (2026-08-18): «o filtro de sub-praça escolhe QUAIS turnos
-- entram; os indicadores continuam sendo os do turno inteiro».
--
-- Até 0050, filtrar por sub-praça fazia as RPCs de resumo agregarem só as
-- linhas daquela sub-praça — "% do período que a pessoa passou online NESTA
-- sub-praça". Sob a D1 isso volta a divergir da lista (que agora mostra o
-- turno), reintroduzindo pela porta do filtro exatamente a discordância
-- tabela × card que esta entrega existe para acabar.
--
-- Com o semi-join (`EXISTS`), a sub-praça deixa de ser dimensão de agregação e
-- passa a ser critério de seleção: "os turnos em que a pessoa passou por esta
-- sub-praça, medidos por inteiro". A tela avisa isso por escrito quando o
-- filtro está aplicado.
--
-- Efeito colateral bem-vindo: os dois ramos `IF p_subpraca IS NULL ... ELSE`
-- de 0050 somem, e com eles a segunda cópia da fórmula do tempo disponível —
-- a fórmula passa a existir num lugar só (a MV). Duas cópias de uma regra
-- destas é como a deriva entra sem nenhum teste ficar vermelho.
--
-- O que este arquivo NÃO faz: não deduplica as linhas gêmeas da origem (3 em
-- 2.720 — o tempo já tem teto, corridas/taxas ainda contam em dobro; dívida
-- registrada como D5 do plano) e não toca em `tempo_disponivel_pct`, o
-- `escalado` cru da origem.
--
-- Idempotente (DROP+CREATE da MV / CREATE OR REPLACE das funções). Aplicada
-- por migrate.sh (registra em "SchemaMigration", SIGUSR1 no PostgREST).
--
-- ⚠️ CUSTO: o CREATE da MV varre `PerformanceTurno` inteira. Em produção
-- (2.720 linhas) são milissegundos; ainda assim é DDL — aplicar fora do
-- horário de importação.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. MV recriada — mesmo grão (o TURNO), mais 3 contadores.
--
-- `CREATE MATERIALIZED VIEW IF NOT EXISTS` NÃO altera a forma de uma MV que já
-- existe (foi por isso que 0050 também usou DROP+CREATE). Os índices e os
-- REVOKEs precisam ser recriados junto — eles morrem com o DROP.
--
-- `pedidos_concluidos` continua ANULÁVEL: a origem não manda o campo em todo
-- arquivo, e `SUM` de tudo NULL devolve NULL. Ausência de leitura nunca vira
-- zero — zero é uma afirmação sobre o desempenho, NULL é a ausência dela.
-- Os outros quatro contadores são `NOT NULL DEFAULT 0` na tabela.
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
        SUM(corridas_rejeitadas)::bigint          AS corridas_rejeitadas,
        SUM(corridas_completadas)::bigint         AS corridas_completadas,
        SUM(corridas_canceladas)::bigint          AS corridas_canceladas,
        SUM(pedidos_concluidos)::bigint           AS pedidos_concluidos,
        SUM(COALESCE(taxas_centavos, 0))::bigint  AS taxas_centavos,
        -- Numerador: online do turno inteiro (praças somadas), com teto na
        -- duração do próprio turno (linhas gêmeas da origem) — 0050.
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

-- Índice que serve o recorte por sub-praça DENTRO de uma janela de datas.
-- `idx_performance_empresa_subpraca` (0020) é (id_empresa, subpraca,
-- entregador_id) e não ajuda no intervalo de `data_periodo` — a contagem de
-- turnos com filtro de sub-praça varria todas as linhas daquela sub-praça, de
-- qualquer data. Medido sob 900k turnos: 1,5s com o índice de 0020 e 0,2s com
-- este. Em produção (2.720 linhas) o índice é irrelevante em custo.
CREATE INDEX IF NOT EXISTS idx_performance_empresa_subpraca_data
    ON "PerformanceTurno" (id_empresa, subpraca, data_periodo);

-- Isolamento multi-tenant (0031): a MV não tem RLS. Acesso SOMENTE pelas RPCs
-- SECURITY DEFINER, que aplicam `hub_jwt_escopo_ids()` explicitamente.
REVOKE ALL ON mv_performance_dia FROM PUBLIC;
REVOKE ALL ON mv_performance_dia FROM authenticated;
REVOKE ALL ON mv_performance_dia FROM hub_web_anon;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Resumo (cards e agrupado) — sub-praça vira SEMI-JOIN.
--
-- Mesma assinatura, mesmo contrato de saída de 0030/0031/0050 (taxas com 4
-- casas, tempo com 2, `taxas_reais` '0.00' em vazio, NULL nos denominadores
-- zero — SC-009). O que muda é só o significado de `p_subpraca`, acima.
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
          AND (p_subpraca IS NULL OR EXISTS (
                  SELECT 1 FROM "PerformanceTurno" pt
                  WHERE pt.id_empresa    = mv.id_empresa
                    AND pt.entregador_id = mv.entregador_id
                    AND pt.data_periodo  = mv.data_periodo
                    AND pt.periodo       = mv.periodo
                    AND pt.subpraca      = p_subpraca))
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
          AND (p_subpraca IS NULL OR EXISTS (
                  SELECT 1 FROM "PerformanceTurno" pt
                  WHERE pt.id_empresa    = mv.id_empresa
                    AND pt.entregador_id = mv.entregador_id
                    AND pt.data_periodo  = mv.data_periodo
                    AND pt.periodo       = mv.periodo
                    AND pt.subpraca      = p_subpraca))
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
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. A lista, no grão do turno.
--
-- Por que RPC e não PostgREST direto: a lista precisa AGREGAR (turno = N
-- linhas) e PostgREST não agrega; a MV, que já tem o agregado, não pode ser
-- exposta porque MV não carrega RLS.
--
-- ── A FORMA DESTA CONSULTA FOI MEDIDA, não escolhida por gosto ─────────────
--
-- Volume sintético de 900k turnos (990k linhas, 3.000 entregadores × 100 dias
-- × 3 turnos, 10% multi-praça), medido no hub-homolog dentro de uma transação
-- revertida. Janela de 30 dias = 270k turnos, página de 20:
--
--   página servida pelo índice, sem join e sem contagem ......    0,8 ms
--   + `count(*) OVER ()` na mesma consulta ...................  366   ms
--   + ORDER BY pelo NOME do entregador .......................  1595  ms
--   desenho abaixo (página + contagem isolada + join na página)  180  ms
--   idem, com filtro de sub-praça ............................   35   ms
--
-- A primeira versão desta função juntava as três coisas e levava 18,7s numa
-- janela de 30 dias e 44s na janela inteira — contra o teto de 1s do SC-004.
-- As três decisões abaixo saem daí:
--
-- (a) ORDENAÇÃO `data_periodo DESC, periodo DESC, entregador_id DESC`, que é
--     exatamente `uq_mv_performance_dia_grao` lido de trás para frente: o
--     Postgres corta no LIMIT sem ordenar nada. A D4 do plano propunha ordenar
--     pelo NOME do entregador; o nome vive noutra tabela, então ordenar por ele
--     obriga a juntar e ordenar o conjunto INTEIRO antes do LIMIT — 1,6s só
--     nisso, e cresce com a janela. Fica registrado para o operador decidir se
--     o alfabético vale um índice novo; a busca por pessoa já existe no filtro
--     de entregador.
--
-- (b) CONTAGEM resolvida à parte, em variável, e não por `count(*) OVER ()`. A
--     janela é calculada antes do ORDER BY/LIMIT, o que obriga a materializar o
--     conjunto filtrado inteiro e mata o corte pelo índice; contando à parte, a
--     contagem é um index-only scan e a página fica em 0,8ms. O predicado é
--     REPETIDO de propósito: uma CTE compartilhada seria referenciada duas
--     vezes e o PG a materializaria, voltando ao problema.
--
-- (c) `Entregador` e o LATERAL das praças entram DEPOIS do LIMIT — no máximo
--     `p_limit` buscas por índice, nunca uma por turno do período.
--
-- ⚠️ `p_offset` além do fim devolve zero linhas, e com elas o total. A tela
-- volta para a página 1 a cada mudança de filtro, então o caso não aparece na
-- navegação normal.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION hub_performance_turnos(
    p_id_empresa      int,
    p_de              date,
    p_ate             date,
    p_periodo         text,
    p_subpraca        text,
    p_entregador_id   int,
    p_limit           int,
    p_offset          int
)
RETURNS TABLE (
    entregador_id                int,
    entregador_nome              text,
    data_periodo                 date,
    periodo                      text,
    praca                        text,
    corridas_ofertadas           bigint,
    corridas_aceitas             bigint,
    corridas_rejeitadas          bigint,
    corridas_completadas         bigint,
    corridas_canceladas          bigint,
    pedidos_concluidos           bigint,
    taxas_centavos               bigint,
    tempo_disponivel_periodo_pct text,
    pracas                       jsonb,
    total_turnos                 bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_total bigint;
BEGIN
    -- Fora do escopo: ZERO linhas, nunca erro (mesmo contrato das irmãs) —
    -- um 500 diria ao chamador que a empresa existe.
    IF p_id_empresa IS NULL OR NOT (p_id_empresa = ANY (hub_jwt_escopo_ids())) THEN
        RETURN;
    END IF;

    -- A contagem é resolvida ANTES, em variável, e não como subconsulta na
    -- lista de saída: assim cada caso usa o seu caminho, e o total não é
    -- recalculado por linha da página.
    --
    -- Os dois ramos contam LINHAS DA MV — nunca a tabela-base. Contar turnos
    -- distintos em `PerformanceTurno` daria o mesmo número quase sempre e um
    -- número MAIOR que a lista enquanto a MV estivesse defasada, o que
    -- apareceria como "página vazia com total > 0".
    IF p_subpraca IS NULL THEN
        SELECT COUNT(*) INTO v_total
        FROM mv_performance_dia mv
        WHERE mv.id_empresa = p_id_empresa
          AND mv.data_periodo BETWEEN p_de AND p_ate
          AND (p_periodo IS NULL OR mv.periodo = p_periodo)
          AND (p_entregador_id IS NULL OR mv.entregador_id = p_entregador_id);
    ELSE
        -- `IN (subconsulta)` e não `EXISTS` correlacionado: o EXISTS obriga uma
        -- sonda por turno do período (270k sondas = 1,5s medidos); o `IN` deixa
        -- o planejador montar UM semi-join de hash contra as linhas daquela
        -- sub-praça na janela, que o índice acima entrega prontas.
        SELECT COUNT(*) INTO v_total
        FROM mv_performance_dia mv
        WHERE mv.id_empresa = p_id_empresa
          AND mv.data_periodo BETWEEN p_de AND p_ate
          AND (p_periodo IS NULL OR mv.periodo = p_periodo)
          AND (p_entregador_id IS NULL OR mv.entregador_id = p_entregador_id)
          AND (mv.entregador_id, mv.data_periodo, mv.periodo) IN (
                SELECT pt.entregador_id, pt.data_periodo, pt.periodo
                FROM "PerformanceTurno" pt
                WHERE pt.id_empresa   = p_id_empresa
                  AND pt.subpraca     = p_subpraca
                  AND pt.data_periodo BETWEEN p_de AND p_ate);
    END IF;

    RETURN QUERY
    WITH pagina AS (
        SELECT
            mv.entregador_id                          AS f_entregador_id,
            mv.data_periodo                           AS f_data,
            mv.periodo                                AS f_periodo,
            mv.corridas_ofertadas                     AS f_ofertadas,
            mv.corridas_aceitas                       AS f_aceitas,
            mv.corridas_rejeitadas                    AS f_rejeitadas,
            mv.corridas_completadas                   AS f_completadas,
            mv.corridas_canceladas                    AS f_canceladas,
            mv.pedidos_concluidos                     AS f_pedidos,
            mv.taxas_centavos                         AS f_taxas,
            (mv.online_epoch / NULLIF(mv.periodo_epoch, 0) * 100)::numeric(6,2) AS f_tempo
        FROM mv_performance_dia mv
        WHERE mv.id_empresa = p_id_empresa
          AND mv.data_periodo BETWEEN p_de AND p_ate
          AND (p_periodo IS NULL OR mv.periodo = p_periodo)
          AND (p_entregador_id IS NULL OR mv.entregador_id = p_entregador_id)
          AND (p_subpraca IS NULL OR EXISTS (
                  SELECT 1 FROM "PerformanceTurno" pt
                  WHERE pt.id_empresa    = mv.id_empresa
                    AND pt.entregador_id = mv.entregador_id
                    AND pt.data_periodo  = mv.data_periodo
                    AND pt.periodo       = mv.periodo
                    AND pt.subpraca      = p_subpraca))
        -- Ordem do índice unique, lida de trás para frente (ver (a) acima).
        ORDER BY mv.data_periodo DESC, mv.periodo DESC, mv.entregador_id DESC
        LIMIT  COALESCE(NULLIF(p_limit, 0), 20)
        OFFSET COALESCE(p_offset, 0)
    )
    SELECT
        p.f_entregador_id::int,
        e.nome,
        p.f_data,
        p.f_periodo,
        det.praca_predominante,
        p.f_ofertadas,
        p.f_aceitas,
        p.f_rejeitadas,
        p.f_completadas,
        p.f_canceladas,
        p.f_pedidos,
        p.f_taxas,
        p.f_tempo::text,
        COALESCE(det.lista, '[]'::jsonb),
        v_total
    FROM pagina p
    LEFT JOIN "Entregador" e
           ON e.id = p.f_entregador_id
          AND e.id_empresa = p_id_empresa
    LEFT JOIN LATERAL (
        SELECT
            jsonb_agg(jsonb_build_object(
                'subpraca',            x.subpraca,
                'praca',               x.praca,
                'tempoDisponivelPct',  x.tempo_pct,
                'corridasOfertadas',   x.ofertadas,
                'corridasAceitas',     x.aceitas,
                'corridasCompletadas', x.completadas,
                'taxasCentavos',       x.taxas
            ) ORDER BY x.tempo_pct DESC NULLS LAST, x.ofertadas DESC, x.subpraca ASC)
                                                                       AS lista,
            -- A meta é por PRAÇA × turno, e o turno pode atravessar praças.
            -- O veredito precisa de UMA praça: a PREDOMINANTE — mais tempo
            -- online, desempate por ofertadas e depois pelo nome da
            -- sub-praça. Com uma praça só (a esmagadora maioria) é
            -- exatamente o que a tela já fazia por linha.
            (array_agg(x.praca
                ORDER BY x.tempo_pct DESC NULLS LAST, x.ofertadas DESC, x.subpraca ASC))[1]
                                                                       AS praca_predominante
        FROM (
            SELECT
                pt.subpraca,
                pt.praca,
                -- Soma da coluna gerada de 0050 (% do período POR LINHA, já
                -- somável entre praças do mesmo turno). `CASE` antes do
                -- `LEAST` porque LEAST IGNORA NULL: sem esse guard, a
                -- sub-praça sem leitura nenhuma sairia com 100% — ausência
                -- virando nota máxima, a mesma armadilha que 0050 documenta.
                CASE
                    WHEN SUM(pt.tempo_disponivel_periodo_pct) IS NULL THEN NULL
                    ELSE LEAST(SUM(pt.tempo_disponivel_periodo_pct), 100::numeric)
                END                                    AS tempo_pct,
                SUM(pt.corridas_ofertadas)::bigint     AS ofertadas,
                SUM(pt.corridas_aceitas)::bigint       AS aceitas,
                SUM(pt.corridas_completadas)::bigint   AS completadas,
                SUM(COALESCE(pt.taxas_centavos, 0))::bigint AS taxas
            FROM "PerformanceTurno" pt
            WHERE pt.id_empresa    = p_id_empresa
              AND pt.entregador_id = p.f_entregador_id
              AND pt.data_periodo  = p.f_data
              AND pt.periodo       = p.f_periodo
            GROUP BY pt.subpraca, pt.praca
        ) x
    ) det ON true
    ORDER BY p.f_data DESC, p.f_periodo DESC, p.f_entregador_id DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION hub_performance_totais(int, date, date, text, text, int) TO authenticated;
GRANT EXECUTE ON FUNCTION hub_performance_agrupado(int, date, date, text, text, int, text) TO authenticated;
GRANT EXECUTE ON FUNCTION hub_performance_turnos(int, date, date, text, text, int, int, int) TO authenticated;
