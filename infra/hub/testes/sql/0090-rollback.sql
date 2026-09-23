-- ROLLBACK da 0090 (F3 — "entra na nota").
--
-- Restaura as DUAS funções para a versão imediatamente anterior:
--   hub_adiantamento_configuracao_salvar -> 0075
--   hub_adiantamento_extrato_motorista   -> 0089
--
-- A COLUNA `categorias_nota` NÃO é derrubada de propósito: dropar apagaria a
-- configuração de quem já marcou, e ela é inócua sem as funções (ninguém lê).
-- Se for mesmo para sumir, é decisão separada, depois de conferir que nada
-- salvou nela:
--   SELECT count(*) FROM "AdiantamentoConfiguracao" WHERE categorias_nota IS NOT NULL;
--
-- ⚠️ Depois de reverter, o `salvar` volta a NÃO carregar `categorias_nota`
-- entre versões: o próximo salvamento zera a marcação de quem já configurou.

CREATE OR REPLACE FUNCTION hub_adiantamento_configuracao_salvar(p_versao_esperada int, p_dados jsonb)
RETURNS "AdiantamentoConfiguracao"
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_sub   int := NULLIF(hub_jwt_claims() ->> 'sub', '')::int;
    v_atual "AdiantamentoConfiguracao";
    v_nova  "AdiantamentoConfiguracao";
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.configurar') THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;
    IF NOT (6 = ANY (hub_jwt_escopo_ids())) THEN RAISE EXCEPTION 'FORA_DO_GRUPO_MOVEE'; END IF;

    -- 11.11 (converge onda-039, FR-023): compara contra a MAIOR versão
    -- gravada (independente de `vigente_desde`), não contra
    -- `hub_adiantamento_config_vigente` (que filtra `vigente_desde <= now()`
    -- e por isso não enxerga uma versão agendada para o futuro). `FOR
    -- UPDATE` fecha a corrida entre o SELECT e o INSERT — dois salvamentos
    -- concorrentes: o segundo cai no `unique_violation` abaixo e recebe
    -- VERSAO_DESATUALIZADA (contrato: lib/hub/adiantamentos-api.ts:40 já
    -- sabe traduzir), nunca DADOS_INVALIDOS genérico.
    SELECT * INTO v_atual FROM "AdiantamentoConfiguracao"
        WHERE id_empresa = 6 ORDER BY versao DESC LIMIT 1 FOR UPDATE;
    IF v_atual.versao IS DISTINCT FROM p_versao_esperada THEN
        RAISE EXCEPTION 'VERSAO_DESATUALIZADA';
    END IF;

    BEGIN
        INSERT INTO "AdiantamentoConfiguracao" (
            id_empresa, versao, vigente_desde, timezone, dias_habilitados, horario_abertura,
            horario_corte, percentual, taxa_fixa, fonte_producao, categorias_producao,
            previsao_pagamento_texto, descricao_pix_modelo, apuracao_dia_inicio,
            apuracao_dias_ate_repasse, apuracao_data_base, categorias_extrato,
            desconto_adiantamentos, desconto_debitos, repasse_visivel_app, criado_por, motivo
        ) VALUES (
            6,
            COALESCE(v_atual.versao, 0) + 1,
            COALESCE((p_dados ->> 'vigenteDesde')::timestamptz, now()),
            COALESCE(p_dados ->> 'timezone', COALESCE(v_atual.timezone, 'America/Sao_Paulo')),
            COALESCE((SELECT array_agg(x::smallint) FROM jsonb_array_elements_text(p_dados -> 'diasHabilitados') x), v_atual.dias_habilitados),
            COALESCE((p_dados ->> 'horarioAbertura')::time, v_atual.horario_abertura),
            COALESCE((p_dados ->> 'horarioCorte')::time, v_atual.horario_corte),
            COALESCE((p_dados ->> 'percentual')::numeric, v_atual.percentual),
            COALESCE((p_dados ->> 'taxaFixa')::numeric, v_atual.taxa_fixa),
            COALESCE(p_dados ->> 'fonteProducao', v_atual.fonte_producao),
            COALESCE((SELECT array_agg(x) FROM jsonb_array_elements_text(p_dados -> 'categoriasProducao') x), v_atual.categorias_producao),
            COALESCE(p_dados ->> 'previsaoPagamentoTexto', v_atual.previsao_pagamento_texto),
            COALESCE(p_dados ->> 'descricaoPixModelo', v_atual.descricao_pix_modelo),
            COALESCE((p_dados ->> 'apuracaoDiaInicio')::smallint, v_atual.apuracao_dia_inicio),
            COALESCE((p_dados ->> 'apuracaoDiasAteRepasse')::smallint, v_atual.apuracao_dias_ate_repasse),
            COALESCE(p_dados ->> 'apuracaoDataBase', v_atual.apuracao_data_base),
            COALESCE((SELECT array_agg(x) FROM jsonb_array_elements_text(p_dados -> 'categoriasExtrato') x), v_atual.categorias_extrato),
            COALESCE((p_dados ->> 'descontoAdiantamentos')::boolean, v_atual.desconto_adiantamentos, true),
            COALESCE((p_dados ->> 'descontoDebitos')::boolean, v_atual.desconto_debitos, false),
            COALESCE((p_dados ->> 'repasseVisivelApp')::boolean, v_atual.repasse_visivel_app, false),
            v_sub,
            p_dados ->> 'motivo'
        ) RETURNING * INTO v_nova;
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'VERSAO_DESATUALIZADA';
    END;

    RETURN v_nova;
END;
$$;

DROP FUNCTION IF EXISTS hub_adiantamento_extrato_motorista();
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
