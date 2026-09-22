-- 0087 — Famílias de categoria na produção do adiantamento.
--
-- PROBLEMA (medido em produção, 2026-09-21): das 34 categorias de crédito dos
-- últimos 90 dias, 14 são campanhas "Promoção - …" que mudam de nome toda
-- semana (w95, w96, w97…) ou trazem data (31_08, 06_09…). O cálculo compara
-- por IGUALDADE EXATA (`descricao = ANY (categorias_producao)`, 0067), então a
-- campanha da semana seguinte fica fora da produção EM SILÊNCIO até alguém
-- voltar na tela e marcá-la. Mesma coisa com "MISSOES DE <MÊS> …".
--
-- DECISÃO DO OPERADOR (2026-09-21):
--   - "Promoção" = tudo que começa com "Promoção - …", inclusive as campanhas
--     futuras. "Promocao entregador" (recorrente, sem " - ") fica SEPARADA.
--   - "Missões"  = tudo que começa com "MISSOES".
--   - Só categorias com ao menos um lançamento com motorista
--     (`id_da_pessoa_entregadora` preenchido) aparecem para seleção.
--
-- COMO: a configuração passa a aceitar, além de nomes exatos, um TOKEN de
-- família em `categorias_producao` ('familia:promocao', 'familia:missoes').
-- Uma única função SQL decide a família de uma descrição — a tela recebe a
-- família pronta do RPC, então tela e cálculo nunca discordam.
--
-- ENCODING: parte dos lançamentos chega com o acento TROCADO por U+FFFD ("�")
-- na importação — "Promo��o - Corre��es Gerais (Live Team)", 88 lançamentos
-- em produção. A regra casa as três grafias (Promocao / Promoção / Promo��o) e
-- é escrita com chr(), sem acento literal no arquivo, para não depender do
-- encoding com que o migrate.sh envia o arquivo.
--
-- ponytail: famílias fixas nesta função. Nova família = nova migration.
-- Tornar configurável só se aparecer uma terceira.
--
-- COMPATÍVEL nos dois sentidos com o backend: o RPC de categorias só GANHA a
-- coluna `familia` (backend antigo ignora); o cálculo aceita exatamente o que
-- aceitava antes, e mais os tokens.
--
-- ROLLBACK: reaplicar os corpos de `hub_adiantamento_producao` (0067) e de
-- `hub_adiantamento_categorias` (0083, com DROP antes — muda o retorno).
-- ⚠️ Se já houver config salva com token de família, o rollback faz o token
-- parar de casar e a produção CAI sem erro — trocar a config por nomes exatos
-- antes de reverter.

-- 1. A família de uma descrição (NULL = categoria avulsa).
CREATE OR REPLACE FUNCTION hub_adiantamento_categoria_familia(p_descricao text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
    SELECT CASE
        -- "Promoção -" com c/ç/Ç/� e a/ã/Ã/�. Exige o hífen: "Promocao entregador" NÃO entra.
        WHEN p_descricao ~* ('^promo[c' || chr(231) || chr(199) || chr(65533) || ']'
                             || '[a' || chr(227) || chr(195) || chr(65533) || ']o\s*-')
            THEN 'familia:promocao'
        -- "MISSOES"/"Missões"/"Miss�es" como palavra inteira no início.
        WHEN p_descricao ~* ('^miss[o' || chr(245) || chr(213) || chr(65533) || ']es\y')
            THEN 'familia:missoes'
    END;
$$;

-- 2. A descrição conta para a produção? Nome exato OU a família dela.
CREATE OR REPLACE FUNCTION hub_adiantamento_categoria_casa(p_descricao text, p_categorias text[])
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
    SELECT COALESCE(
        p_descricao = ANY (p_categorias)
        OR hub_adiantamento_categoria_familia(p_descricao) = ANY (p_categorias),
        false);
$$;

-- 3. O cálculo: corpo IDÊNTICO ao da 0067, só as duas comparações trocadas.
CREATE OR REPLACE FUNCTION hub_adiantamento_producao(
    p_entregador_id int,
    p_data          date,
    p_config        "AdiantamentoConfiguracao"
)
RETURNS TABLE (
    disponivel    boolean,
    valor         numeric(12,2),
    lancamentos   int,
    por_categoria jsonb
)
LANGUAGE plpgsql STABLE
AS $$
#variable_conflict use_column
DECLARE
    v_id_empresa       int;
    v_tipo_importacao  text;
    v_bloqueada        boolean;
    v_existe           boolean;
    v_valor            numeric(12,2) := 0;
    v_qtd              int := 0;
    v_por_cat          jsonb := '{}'::jsonb;
BEGIN
    SELECT e.id_empresa INTO v_id_empresa FROM "Entregador" e WHERE e.id = p_entregador_id;

    IF p_config.fonte_producao IS NULL THEN
        RETURN QUERY SELECT false, 0::numeric(12,2), 0, '{}'::jsonb;
        RETURN;
    END IF;

    v_tipo_importacao := CASE
        WHEN p_config.fonte_producao IN ('financeiro_lancamento', 'financeiro_referencia') THEN 'faturamento'
        ELSE 'performance'
    END;

    IF v_tipo_importacao = 'faturamento' THEN
        SELECT EXISTS (
            SELECT 1 FROM "FaturamentoLancamento" f
            WHERE f.id_empresa = v_id_empresa
              AND ((p_config.fonte_producao = 'financeiro_lancamento' AND f.data_lancamento = p_data)
                OR (p_config.fonte_producao = 'financeiro_referencia' AND f.data_referencia = p_data))
        ) INTO v_existe;
    ELSE
        SELECT EXISTS (
            SELECT 1 FROM "PerformanceTurno" pt
            WHERE pt.id_empresa = v_id_empresa AND pt.data_periodo = p_data
        ) INTO v_existe;
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM "ImportacaoArquivo" ia
        WHERE ia.id_empresa = v_id_empresa AND ia.tipo = v_tipo_importacao
          AND ia.status IN ('pending', 'validating', 'processing')
    ) INTO v_bloqueada;

    IF NOT v_existe OR v_bloqueada THEN
        RETURN QUERY SELECT false, 0::numeric(12,2), 0, '{}'::jsonb;
        RETURN;
    END IF;

    IF v_tipo_importacao = 'faturamento' THEN
        SELECT COALESCE(sum(f.valor), 0), count(*)
        INTO v_valor, v_qtd
        FROM "FaturamentoLancamento" f
        WHERE f.id_empresa = v_id_empresa AND f.entregador_id = p_entregador_id
          AND f.tipo = 'Credito' AND hub_adiantamento_categoria_casa(f.descricao, p_config.categorias_producao)
          AND ((p_config.fonte_producao = 'financeiro_lancamento' AND f.data_lancamento = p_data)
            OR (p_config.fonte_producao = 'financeiro_referencia' AND f.data_referencia = p_data));

        SELECT COALESCE(jsonb_object_agg(sub.descricao, sub.total::text), '{}'::jsonb)
        INTO v_por_cat
        FROM (
            SELECT f.descricao, sum(f.valor) AS total
            FROM "FaturamentoLancamento" f
            WHERE f.id_empresa = v_id_empresa AND f.entregador_id = p_entregador_id
              AND f.tipo = 'Credito' AND hub_adiantamento_categoria_casa(f.descricao, p_config.categorias_producao)
              AND ((p_config.fonte_producao = 'financeiro_lancamento' AND f.data_lancamento = p_data)
                OR (p_config.fonte_producao = 'financeiro_referencia' AND f.data_referencia = p_data))
            GROUP BY f.descricao
        ) sub;
    ELSE
        SELECT COALESCE(round(sum(pt.taxas_centavos) / 100.0, 2), 0), count(*)
        INTO v_valor, v_qtd
        FROM "PerformanceTurno" pt
        WHERE pt.id_empresa = v_id_empresa AND pt.entregador_id = p_entregador_id AND pt.data_periodo = p_data;

        -- [PROPOSTA]: performance_taxas não tem "categorias" (PerformanceTurno
        -- não tem coluna descricao); por_categoria vira uma única chave.
        v_por_cat := jsonb_build_object('performance_taxas', v_valor::text);
    END IF;

    RETURN QUERY SELECT true, v_valor, v_qtd, v_por_cat;
END;
$$;

-- 4. Lista para a tela: ganha `familia` e esconde categoria SEM nenhum
--    lançamento com motorista. Muda o retorno, então DROP antes.
DROP FUNCTION IF EXISTS hub_adiantamento_categorias(text);
CREATE FUNCTION hub_adiantamento_categorias(p_fonte text DEFAULT NULL)
RETURNS TABLE (descricao text, lancamentos bigint, sem_motorista_identificado boolean, familia text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT f.descricao, count(*), bool_or(f.entregador_id IS NULL),
           hub_adiantamento_categoria_familia(f.descricao)
    FROM "FaturamentoLancamento" f
    WHERE f.id_empresa = ANY (hub_jwt_escopo_ids())
      AND f.tipo = 'Credito'
      AND f.data_referencia >= ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 90)
    GROUP BY f.descricao
    HAVING count(f.entregador_id) > 0
    ORDER BY f.descricao;
$$;
REVOKE ALL ON FUNCTION hub_adiantamento_categorias(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_categorias(text) TO authenticated;
