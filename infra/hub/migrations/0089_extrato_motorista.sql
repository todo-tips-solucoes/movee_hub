-- 0089 — F2: o extrato da semana para o motorista.
--
-- O app mostrava só o TOTAL do repasse (`hub_adiantamento_repasse_motorista`).
-- O motorista não conseguia ver DE ONDE o número vinha. Esta função devolve a
-- mesma semana, aberta por dia e por categoria.
--
-- MESMA base do repasse, de propósito: mesma resolução do motorista (CNPJ do
-- JWT -> ContaMotorista -> Entregador), mesmas guardas (`repasse_visivel_app`,
-- `apuracao_dia_inicio`), mesma janela (dia de início da config, no timezone
-- da config) e o MESMO filtro de categoria (`categoria_casa`, com a regra de
-- família da 0087/0088). Se divergir, o motorista vê dois números diferentes
-- para a mesma semana — e acredita no menor.
--
-- Agregação no SQL, não no app: o total da semana é a soma dos dias, que é a
-- soma das categorias. Uma origem só.
--
-- `valor` vem da coluna `valor` de FaturamentoLancamento (decisão 9 do
-- briefing repasse-nota-producao).
--
-- ROLLBACK: `DROP FUNCTION hub_adiantamento_extrato_motorista();` — nada
-- depende dela; o app tolera 404 (a tela não renderiza).

CREATE OR REPLACE FUNCTION hub_adiantamento_extrato_motorista()
RETURNS TABLE (
    visivel        boolean,
    periodo_inicio date,
    periodo_fim    date,
    total          numeric(12,2),
    dias           jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_cnpj               text := hub_jwt_motorista_cnpj();
    v_conta_motorista_id int;
    v_entregador         RECORD;
    v_config             "AdiantamentoConfiguracao";
    v_hoje               date;
    v_inicio             date;
    v_fim                date;
BEGIN
    IF v_cnpj IS NULL THEN RETURN; END IF;
    SELECT cm.id INTO v_conta_motorista_id FROM "ContaMotorista" cm WHERE cm.cnpj_prestador = v_cnpj;
    IF v_conta_motorista_id IS NULL THEN RETURN; END IF;
    SELECT e.* INTO v_entregador FROM "Entregador" e WHERE e.motorista_id = v_conta_motorista_id;
    IF NOT FOUND THEN RETURN; END IF;

    SELECT * INTO v_config FROM hub_adiantamento_config_vigente(v_entregador.id_empresa);
    IF v_config.id IS NULL OR NOT v_config.repasse_visivel_app OR v_config.apuracao_dia_inicio IS NULL THEN
        RETURN QUERY SELECT false, NULL::date, NULL::date, NULL::numeric(12,2), NULL::jsonb;
        RETURN;
    END IF;

    v_hoje   := (now() AT TIME ZONE v_config.timezone)::date;
    v_inicio := v_hoje - ((extract(dow FROM v_hoje)::int - v_config.apuracao_dia_inicio + 7) % 7);
    v_fim    := v_inicio + 6;

    RETURN QUERY
    WITH itens AS (
        SELECT
            CASE WHEN v_config.apuracao_data_base = 'data_lancamento'
                 THEN f.data_lancamento ELSE f.data_referencia END AS data,
            f.descricao,
            f.valor
        FROM "FaturamentoLancamento" f
        WHERE f.entregador_id = v_entregador.id
          AND f.tipo = 'Credito'
          AND hub_adiantamento_categoria_casa(f.descricao, COALESCE(v_config.categorias_extrato, ARRAY[]::text[]))
          AND (
              (v_config.apuracao_data_base = 'data_lancamento' AND f.data_lancamento BETWEEN v_inicio AND v_fim)
              OR (v_config.apuracao_data_base = 'data_referencia' AND f.data_referencia BETWEEN v_inicio AND v_fim)
          )
    ),
    -- Um lançamento por corrida deixaria a tela ilegível: agrupa por dia e
    -- categoria, com a quantidade ao lado.
    por_categoria AS (
        SELECT data, descricao, count(*)::int AS quantidade, sum(valor)::numeric(12,2) AS valor
        FROM itens GROUP BY data, descricao
    ),
    por_dia AS (
        SELECT data,
               sum(valor)::numeric(12,2) AS total,
               jsonb_agg(jsonb_build_object(
                   'descricao', descricao, 'quantidade', quantidade, 'valor', valor
               ) ORDER BY valor DESC, descricao) AS itens
        FROM por_categoria GROUP BY data
    )
    SELECT
        true,
        v_inicio,
        v_fim,
        COALESCE((SELECT sum(total)::numeric(12,2) FROM por_dia), 0::numeric(12,2)),
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'data', data, 'total', total, 'itens', itens
                 ) ORDER BY data) FROM por_dia), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION hub_adiantamento_extrato_motorista() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_extrato_motorista() TO authenticated;
