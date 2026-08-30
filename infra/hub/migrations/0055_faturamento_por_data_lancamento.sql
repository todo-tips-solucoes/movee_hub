-- 0055 — o módulo Financeiro passa a filtrar por `data_lancamento` (a data em
-- que o lançamento foi emitido) no lugar de `data_referencia` (a competência,
-- o dia do turno a que o lançamento se refere).
--
-- ── POR QUE ─────────────────────────────────────────────────────────────────
-- Decisão do operador em 2026-08-30. O módulo Performance filtra `data_periodo`
-- (a data do turno) e o Financeiro filtrava `data_referencia`; as duas colunas
-- divergem em parte das linhas, então "o dia 28" significava coisas diferentes
-- nas duas telas. Medido no arquivo real de 28/08/2026: das 4.786 linhas,
-- 1.058 (22%) tinham `data_referencia` = 27/08 — lançadas no dia 28, referentes
-- ao turno do dia 27. No arquivo de 27/08: 1.174 de 4.354 (27%).
--
-- ⚠️ EFEITO ESPERADO E ACEITO: todo total diário JÁ EXIBIDO OU EXPORTADO muda
-- retroativamente. Um relatório do "dia 27" tirado antes desta migration não
-- bate com o mesmo relatório tirado depois. Não há perda de dado — as duas
-- colunas continuam gravadas em `FaturamentoLancamento`, e a lista passa a
-- mostrar as duas; o que muda é qual delas o filtro e os agregados usam.
--
-- ── O QUE MUDA ──────────────────────────────────────────────────────────────
-- 1. `mv_faturamento_dia` recriada com `data_lancamento` no grão (DROP+CREATE:
--    `CREATE ... IF NOT EXISTS` não altera a forma de uma MV existente — mesmo
--    motivo de 0050/0051). Índices e REVOKEs morrem com o DROP e são recriados.
-- 2. `hub_faturamento_totais` e `hub_faturamento_agrupado`: a janela `p_de`/
--    `p_ate` e o `group_by='dia'` passam a usar `data_lancamento`, nos dois
--    ramos (MV e fallback por sub-praça).
-- 3. Índices novos na tabela-base por `data_lancamento` — os de 0013 são todos
--    por `data_referencia`, e sem estes o filtro da lista viraria seq scan.
--    Os antigos FICAM: `data_referencia` continua no `select` da lista, no CSV
--    e na ordenação secundária.
--
-- Idempotente (IF EXISTS / IF NOT EXISTS / CREATE OR REPLACE), aditiva nos
-- índices, sem reescrita de dados: nenhuma linha de fato é tocada.
--
-- ROLLBACK: reaplicar 0028 na íntegra (ela é `CREATE OR REPLACE` nas funções e
-- recria a MV pelo mesmo caminho) e, opcionalmente, dropar os 2 índices novos.
-- Nenhum dado precisa ser restaurado — a migration não escreve em tabela.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Índices da tabela-base para a nova coluna de filtro (espelham 0013)
-- ─────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_faturamentolancamento_empresa_lancamento
    ON "FaturamentoLancamento"(id_empresa, data_lancamento);
CREATE INDEX IF NOT EXISTS idx_faturamentolancamento_empresa_entregador_lancamento
    ON "FaturamentoLancamento"(id_empresa, entregador_id, data_lancamento);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. MV recriada com `data_lancamento` no grão
--
-- `data_lancamento` é NOT NULL no fato (0013), igual à `data_referencia` que
-- ela substitui aqui — o índice ÚNICO exigido pelo REFRESH CONCURRENTLY
-- continua cobrindo todas as linhas. `entregador_key` permanece pelo mesmo
-- motivo de 0028 (índice único não aceita expressão, e `entregador_id` é NULL
-- em agregados/bônus).
-- ─────────────────────────────────────────────────────────────────────────

DROP MATERIALIZED VIEW IF EXISTS mv_faturamento_dia;

CREATE MATERIALIZED VIEW mv_faturamento_dia AS
    SELECT
        id_empresa,
        data_lancamento,
        descricao,
        entregador_id,
        COALESCE(entregador_id, 0)   AS entregador_key,
        (entregador_id IS NOT NULL)  AS com_entregador,
        COUNT(*)::bigint             AS quantidade,
        SUM(valor)::numeric(14,2)    AS total
    FROM "FaturamentoLancamento"
    GROUP BY id_empresa, data_lancamento, descricao, entregador_id
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_faturamento_dia_grao
    ON mv_faturamento_dia (id_empresa, data_lancamento, descricao, entregador_key);

CREATE INDEX IF NOT EXISTS idx_mv_faturamento_dia_empresa_descricao
    ON mv_faturamento_dia (id_empresa, descricao, data_lancamento);
CREATE INDEX IF NOT EXISTS idx_mv_faturamento_dia_empresa_entregador
    ON mv_faturamento_dia (id_empresa, entregador_id, data_lancamento);

-- Isolamento multi-tenant: MV não tem RLS, o acesso é EXCLUSIVO via as RPCs
-- SECURITY DEFINER abaixo (mesma defesa de 0028 — os REVOKEs morreram no DROP).
REVOKE ALL ON mv_faturamento_dia FROM PUBLIC;
REVOKE ALL ON mv_faturamento_dia FROM authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. RPCs de resumo — mesma assinatura e mesmo contrato de saída de 0027/0028.
--    Só a COLUNA da janela (e do `group_by='dia'`) muda.
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
              AND mv.data_lancamento BETWEEN p_de AND p_ate
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
        -- Fallback (filtro por sub-praça — dimensão fora da MV).
        RETURN QUERY
        WITH filtro AS (
            SELECT fl.descricao AS f_descricao,
                   fl.entregador_id AS f_entregador_id,
                   fl.valor AS f_valor
            FROM "FaturamentoLancamento" fl
            WHERE fl.id_empresa = p_id_empresa
              AND fl.data_lancamento BETWEEN p_de AND p_ate
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
        RETURN;
    END IF;

    IF p_subpraca IS NULL THEN
        RETURN QUERY
        WITH filtro AS (
            SELECT
                CASE p_group_by
                    WHEN 'dia'        THEN mv.data_lancamento::text
                    WHEN 'categoria'  THEN mv.descricao
                    WHEN 'entregador' THEN COALESCE(mv.entregador_id::text, 'agregados_bonus')
                END AS chave_calc,
                mv.total AS f_total,
                mv.quantidade AS f_quantidade
            FROM mv_faturamento_dia mv
            WHERE mv.id_empresa = p_id_empresa
              AND mv.data_lancamento BETWEEN p_de AND p_ate
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
        RETURN QUERY
        WITH filtro AS (
            SELECT
                CASE p_group_by
                    WHEN 'dia'        THEN fl.data_lancamento::text
                    WHEN 'categoria'  THEN fl.descricao
                    WHEN 'entregador' THEN COALESCE(fl.entregador_id::text, 'agregados_bonus')
                END AS chave_calc,
                fl.valor AS f_valor
            FROM "FaturamentoLancamento" fl
            WHERE fl.id_empresa = p_id_empresa
              AND fl.data_lancamento BETWEEN p_de AND p_ate
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
