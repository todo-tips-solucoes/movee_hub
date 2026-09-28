-- 0100 — divisão da nota (valor da nota / fora da nota) na prévia e no
-- congelado do repasse, para o CSV de conferência com a planilha.
--
-- POR QUE: o operador valida os números do hub contra a planilha de movimento
-- antes do primeiro fechamento (2026-09-28). A planilha traz, por CNPJ,
-- `valor` (base da nota) e `gorjeta` (fora da nota); o CSV do repasse só
-- tinha o total (Créditos). O fechamento já congela essa divisão
-- (`ApuracaoRepasseItem.valor_nota`/`valor_fora_nota`, 0092); a prévia da
-- semana aberta não a calculava.
--
-- O QUE: `hub_adiantamento_repasse` e `hub_adiantamento_repasse_congelado`
-- ganham `valor_nota`, `valor_fora_nota` NO FIM do retorno (o Node lê por
-- nome). Corpo = 0098 (versão vigente), só com a divisão acrescentada — a
-- da prévia é a MESMA regra do fechamento (0092:124-130 / 0098), da semana
-- em si, SEM o saldo carregado (é o que a planilha da semana compara).
-- Nada mais muda: mesmos filtros, mesma ordem, mesmos totais.
--
-- Muda o tipo de retorno => DROP + CREATE + GRANT refeito; depois exige
-- SIGUSR1 no PostgREST (pgadmin_postgrest em produção).
--
-- ROLLBACK: infra/hub/testes/sql/0100-rollback.sql (recria as versões 0098).
-- Idempotente (DROP IF EXISTS + CREATE).

DROP FUNCTION IF EXISTS hub_adiantamento_repasse(date, text, boolean, int, int);

CREATE FUNCTION hub_adiantamento_repasse(
    p_periodo_inicio date, p_busca text DEFAULT NULL, p_somente_negativos boolean DEFAULT false,
    p_offset int DEFAULT 0, p_limite int DEFAULT 20
)
RETURNS TABLE (
    entregador_id int, nome text, creditos numeric, adiantamentos numeric, debitos numeric,
    remanescente numeric, em_processamento boolean, total bigint,
    total_creditos numeric, total_adiantamentos numeric, total_debitos numeric, total_remanescente numeric,
    saldo_anterior numeric, valor_pago numeric, valor_transportado numeric, retido boolean,
    total_saldo_anterior numeric, total_a_pagar numeric, total_transportado numeric,
    valor_nota numeric, valor_fora_nota numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_config "AdiantamentoConfiguracao";
    v_fim    date;
    v_escopo int[] := hub_jwt_escopo_ids();
BEGIN
    SELECT * INTO v_config FROM hub_adiantamento_config_vigente(6);
    IF v_config.id IS NULL OR v_config.apuracao_data_base IS NULL THEN
        RAISE EXCEPTION 'APURACAO_NAO_CONFIGURADA';
    END IF;
    v_fim := p_periodo_inicio + 6;

    RETURN QUERY
    WITH creditos AS (
        -- 0100: a divisão da nota da PRÓPRIA semana, mesma regra do fechamento
        -- (0092/0098): NULA quando ninguém configurou `categorias_nota`.
        SELECT f.entregador_id, sum(f.valor) AS total,
               sum(f.valor) FILTER (WHERE v_config.categorias_nota IS NOT NULL
                     AND hub_adiantamento_categoria_casa(f.descricao, v_config.categorias_nota)) AS total_nota,
               sum(f.valor) FILTER (WHERE v_config.categorias_nota IS NOT NULL
                     AND NOT hub_adiantamento_categoria_casa(f.descricao, v_config.categorias_nota)) AS total_fora
        FROM "FaturamentoLancamento" f
        WHERE f.id_empresa = ANY (v_escopo) AND f.tipo = 'Credito'
          AND hub_adiantamento_categoria_casa(f.descricao, COALESCE(v_config.categorias_extrato, ARRAY[]::text[]))
          AND (
              (v_config.apuracao_data_base = 'data_lancamento' AND f.data_lancamento BETWEEN p_periodo_inicio AND v_fim)
              OR (v_config.apuracao_data_base = 'data_referencia' AND f.data_referencia BETWEEN p_periodo_inicio AND v_fim)
          )
        GROUP BY f.entregador_id
    ),
    debitos_cte AS (
        SELECT f.entregador_id, sum(abs(f.valor)) AS total
        FROM "FaturamentoLancamento" f
        WHERE f.id_empresa = ANY (v_escopo) AND f.tipo = 'Debito'
          AND (
              (v_config.apuracao_data_base = 'data_lancamento' AND f.data_lancamento BETWEEN p_periodo_inicio AND v_fim)
              OR (v_config.apuracao_data_base = 'data_referencia' AND f.data_referencia BETWEEN p_periodo_inicio AND v_fim)
          )
        GROUP BY f.entregador_id
    ),
    adiant AS (
        SELECT s.entregador_id,
               sum(s.valor_bruto) FILTER (WHERE s.status = 'PAGA')      AS pagos,
               sum(s.valor_bruto) FILTER (WHERE s.status = 'EXPORTADA') AS processando
        FROM "AdiantamentoSolicitacao" s
        WHERE s.id_empresa = ANY (v_escopo) AND s.data_producao BETWEEN p_periodo_inicio AND v_fim
          AND s.status IN ('PAGA', 'EXPORTADA')
        GROUP BY s.entregador_id
    ),
    -- F3/Decision 10 (prévia): saldo transportado da semana FECHADA
    -- imediatamente anterior (p_periodo_inicio - 7). Ainda não fechada (ou
    -- fechada pré-0098) => 0 pelo COALESCE abaixo.
    saldo_ant AS (
        SELECT i.entregador_id, i.valor_transportado
        FROM "ApuracaoRepasseItem" i
        JOIN "ApuracaoRepasse" a ON a.id = i.apuracao_id
        WHERE a.id_empresa = ANY (v_escopo) AND a.periodo_inicio = p_periodo_inicio - 7
    ),
    linhas AS (
        SELECT
            e.id AS entregador_id, e.nome,
            COALESCE(c.total, 0) AS creditos,
            CASE WHEN v_config.desconto_adiantamentos THEN COALESCE(a.pagos, 0) ELSE 0 END AS adiantamentos,
            CASE WHEN v_config.desconto_debitos THEN COALESCE(d.total, 0) ELSE 0 END AS debitos,
            COALESCE(a.processando, 0) > 0 AS em_processamento,
            COALESCE(sa.valor_transportado, 0) AS saldo_anterior,
            -- 0 (e não NULL) quando configurado mas sem crédito na semana;
            -- NULL só quando `categorias_nota` não está configurada.
            CASE WHEN v_config.categorias_nota IS NULL THEN NULL ELSE COALESCE(c.total_nota, 0) END AS valor_nota,
            CASE WHEN v_config.categorias_nota IS NULL THEN NULL ELSE COALESCE(c.total_fora, 0) END AS valor_fora_nota
        FROM "Entregador" e
        LEFT JOIN creditos c ON c.entregador_id = e.id
        LEFT JOIN debitos_cte d ON d.entregador_id = e.id
        LEFT JOIN adiant a ON a.entregador_id = e.id
        LEFT JOIN saldo_ant sa ON sa.entregador_id = e.id
        WHERE e.id_empresa = ANY (v_escopo)
          AND (c.entregador_id IS NOT NULL OR d.entregador_id IS NOT NULL OR a.pagos IS NOT NULL
               OR a.processando IS NOT NULL OR COALESCE(sa.valor_transportado, 0) > 0)
          AND (p_busca IS NULL OR hub_normaliza_nome(e.nome) LIKE '%' || hub_normaliza_nome(p_busca) || '%')
    ),
    calc AS (
        SELECT *, (creditos - adiantamentos - debitos) AS remanescente FROM linhas
    ),
    -- F3/Decision 8 (prévia): mesma regra de piso do fechamento, com o piso
    -- VIGENTE AGORA (nada é gravado; é só previsão, Decision 12).
    piso AS (
        SELECT c.*,
               CASE
                   WHEN c.remanescente < 0 THEN 0::numeric
                   WHEN (c.remanescente + c.saldo_anterior) > 0
                        AND (c.remanescente + c.saldo_anterior) < v_config.repasse_valor_minimo THEN 0::numeric
                   ELSE (c.remanescente + c.saldo_anterior)
               END AS valor_pago,
               CASE
                   WHEN c.remanescente < 0 THEN c.saldo_anterior
                   WHEN (c.remanescente + c.saldo_anterior) > 0
                        AND (c.remanescente + c.saldo_anterior) < v_config.repasse_valor_minimo
                        THEN (c.remanescente + c.saldo_anterior)
                   ELSE 0::numeric
               END AS valor_transportado
        FROM calc c
    ),
    filtradas AS (
        SELECT * FROM piso WHERE (NOT p_somente_negativos OR remanescente < 0)
    )
    -- As janelas `OVER ()` são avaliadas sobre TODAS as linhas de
    -- `filtradas`, antes de OFFSET/LIMIT — mesmo cuidado de sempre: os
    -- totais são do período, não da página.
    SELECT f.entregador_id, f.nome, f.creditos, f.adiantamentos, f.debitos, f.remanescente,
           f.em_processamento, count(*) OVER (),
           sum(f.creditos) OVER (), sum(f.adiantamentos) OVER (),
           sum(f.debitos) OVER (), sum(f.remanescente) OVER (),
           f.saldo_anterior, f.valor_pago, f.valor_transportado,
           (f.remanescente >= 0 AND f.valor_pago = 0 AND f.valor_transportado > 0),
           sum(f.saldo_anterior) OVER (), sum(f.valor_pago) OVER (), sum(f.valor_transportado) OVER (),
           f.valor_nota, f.valor_fora_nota
    FROM filtradas f
    ORDER BY f.nome
    OFFSET p_offset LIMIT p_limite;
END;
$$;

-- DROP apaga o GRANT — refazer.
REVOKE ALL ON FUNCTION hub_adiantamento_repasse(date, text, boolean, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_repasse(date, text, boolean, int, int) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. hub_adiantamento_repasse_congelado (de 0086) — lê as colunas
--    congeladas (NULL num item pré-regra). Muda o tipo de retorno.
-- ═══════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS hub_adiantamento_repasse_congelado(date, text, boolean, int, int);

CREATE FUNCTION hub_adiantamento_repasse_congelado(
    p_periodo_inicio date, p_busca text DEFAULT NULL, p_somente_negativos boolean DEFAULT false,
    p_offset int DEFAULT 0, p_limite int DEFAULT 20
)
RETURNS TABLE (
    entregador_id int, nome text, creditos numeric, adiantamentos numeric, debitos numeric,
    remanescente numeric, em_processamento boolean, total bigint,
    total_creditos numeric, total_adiantamentos numeric, total_debitos numeric, total_remanescente numeric,
    saldo_anterior numeric, valor_pago numeric, valor_transportado numeric, retido boolean,
    total_saldo_anterior numeric, total_a_pagar numeric, total_transportado numeric,
    valor_nota numeric, valor_fora_nota numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_escopo int[] := hub_jwt_escopo_ids();
BEGIN
    RETURN QUERY
    WITH linhas AS (
        SELECT i.entregador_id, e.nome, i.creditos, i.adiantamentos, i.debitos, i.remanescente,
               i.saldo_anterior, i.valor_pago, i.valor_transportado,
               -- O fechamento grava NULL quando a soma filtrada não tem linha
               -- (motorista sem crédito fora da nota, ou só fora dela). Para
               -- a conferência, NULL fica reservado a "divisão não configurada
               -- NA CONFIGURAÇÃO DAQUELA APURAÇÃO"; configurada => 0.
               CASE WHEN cfg.categorias_nota IS NULL THEN NULL ELSE COALESCE(i.valor_nota, 0) END AS valor_nota,
               CASE WHEN cfg.categorias_nota IS NULL THEN NULL ELSE COALESCE(i.valor_fora_nota, 0) END AS valor_fora_nota
        FROM "ApuracaoRepasseItem" i
        JOIN "ApuracaoRepasse" a ON a.id = i.apuracao_id
        LEFT JOIN "AdiantamentoConfiguracao" cfg ON cfg.id = a.configuracao_id
        JOIN "Entregador" e ON e.id = i.entregador_id
        WHERE a.id_empresa = ANY (v_escopo)
          AND a.periodo_inicio = p_periodo_inicio
          AND (p_busca IS NULL OR hub_normaliza_nome(e.nome) LIKE '%' || hub_normaliza_nome(p_busca) || '%')
    ),
    filtradas AS (
        SELECT * FROM linhas WHERE (NOT p_somente_negativos OR remanescente < 0)
    )
    SELECT f.entregador_id, f.nome, f.creditos, f.adiantamentos, f.debitos, f.remanescente,
           false, count(*) OVER (),
           sum(f.creditos) OVER (), sum(f.adiantamentos) OVER (),
           sum(f.debitos) OVER (), sum(f.remanescente) OVER (),
           f.saldo_anterior, f.valor_pago, f.valor_transportado,
           -- NULL num item pré-regra (valor_pago/valor_transportado NULL)
           -- se propaga aqui de propósito: "não sabemos" é diferente de
           -- "não está retido".
           (f.remanescente >= 0 AND f.valor_pago = 0 AND f.valor_transportado > 0),
           sum(f.saldo_anterior) OVER (), sum(f.valor_pago) OVER (), sum(f.valor_transportado) OVER (),
           f.valor_nota, f.valor_fora_nota
    FROM filtradas f
    ORDER BY f.nome
    OFFSET p_offset LIMIT p_limite;
END;
$$;

REVOKE ALL ON FUNCTION hub_adiantamento_repasse_congelado(date, text, boolean, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_repasse_congelado(date, text, boolean, int, int) TO authenticated;
