-- 0090 — F3: marcar quais categorias entram na NOTA.
--
-- Decisão do operador (2026-09-22): a base da nota é a produção da semana
-- MENOS as categorias parametrizadas como "não entra na nota" (hoje a gorjeta;
-- amanhã o que for). A marcação pertence às categorias do EXTRATO — uma lista
-- só para configurar.
--
-- ⚠️ RESTRIÇÃO DO OPERADOR (2026-09-23): "valores dessa semana não podem ser
-- alterados". Esta migration é ADITIVA e NÃO muda nenhum cálculo:
--   - `categorias_nota` nasce NULA e NADA a lê para somar dinheiro;
--   - `hub_adiantamento_repasse`, `..._fechar`, `..._motorista`,
--     `hub_adiantamento_producao` e o adiantamento NÃO são tocados;
--   - o `total` do extrato continua idêntico — a divisão é só EXIBIÇÃO;
--   - enquanto `categorias_nota` for NULA, o extrato devolve a divisão como
--     NULL e a tela do motorista fica exatamente como está hoje.
-- O teste 0090 mede isso: mesma semana, mesmos números, antes e depois.
--
-- ⚠️ Versões mais recentes (conferido, não presumido):
--   hub_adiantamento_configuracao_salvar -> 0075 (NÃO a 0067)
--   hub_adiantamento_extrato_motorista   -> 0089
--
-- ROLLBACK: ver infra/hub/testes/sql/0090-rollback.sql. A coluna pode ficar
-- (nada a lê); o rollback reaplica as duas funções anteriores.

-- 1. A coluna. Aditiva e nula: nenhuma configuração existente muda.
ALTER TABLE "AdiantamentoConfiguracao" ADD COLUMN IF NOT EXISTS categorias_nota text[];

COMMENT ON COLUMN "AdiantamentoConfiguracao".categorias_nota IS
  'F3: subconjunto de categorias_extrato que compõe a base da NOTA. NULL = ainda não configurado (a tela do motorista não mostra divisão). Aceita token de família, como as demais listas.';

-- 2. `salvar` passa a carregar o campo novo entre versões (corpo da 0075, com
--    a coluna acrescentada no INSERT e o COALESCE de carry-through).
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
            apuracao_dias_ate_repasse, apuracao_data_base, categorias_extrato, categorias_nota,
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
            -- F3: NULL enquanto ninguém configurar. Sem isso, salvar uma versão
            -- nova perderia a marcação da versão anterior.
            COALESCE((SELECT array_agg(x) FROM jsonb_array_elements_text(p_dados -> 'categoriasNota') x), v_atual.categorias_nota),
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

-- 3. O extrato ganha a divisão. Corpo da 0089; o `total` é o MESMO.
DROP FUNCTION IF EXISTS hub_adiantamento_extrato_motorista();
CREATE OR REPLACE FUNCTION hub_adiantamento_extrato_motorista()
RETURNS TABLE (
    visivel        boolean,
    periodo_inicio date,
    periodo_fim    date,
    total          numeric(12,2),
    -- F3: NULOS enquanto `categorias_nota` não for configurada — a tela não
    -- mostra divisão nenhuma, e nada muda para quem já usa.
    total_nota     numeric(12,2),
    total_outros   numeric(12,2),
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
        RETURN QUERY SELECT false, NULL::date, NULL::date, NULL::numeric(12,2), NULL::numeric(12,2), NULL::numeric(12,2), NULL::jsonb;
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
        SELECT data, descricao, count(*)::int AS quantidade, sum(valor)::numeric(12,2) AS valor,
               CASE WHEN v_config.categorias_nota IS NULL THEN NULL
                    ELSE hub_adiantamento_categoria_casa(descricao, v_config.categorias_nota) END AS na_nota
        FROM itens GROUP BY data, descricao
    ),
    por_dia AS (
        SELECT data,
               sum(valor)::numeric(12,2) AS total,
               jsonb_agg(jsonb_build_object(
                   'descricao', descricao, 'quantidade', quantidade, 'valor', valor, 'naNota', na_nota
               ) ORDER BY valor DESC, descricao) AS itens
        FROM por_categoria GROUP BY data
    )
    SELECT
        true,
        v_inicio,
        v_fim,
        -- `total` é o mesmo de antes da F3: soma de TUDO. A divisão abaixo não
        -- tira nada dele — só explica como ele se reparte.
        COALESCE((SELECT sum(total)::numeric(12,2) FROM por_dia), 0::numeric(12,2)),
        CASE WHEN v_config.categorias_nota IS NULL THEN NULL::numeric(12,2)
             ELSE COALESCE((SELECT sum(valor)::numeric(12,2) FROM por_categoria WHERE na_nota), 0::numeric(12,2)) END,
        CASE WHEN v_config.categorias_nota IS NULL THEN NULL::numeric(12,2)
             ELSE COALESCE((SELECT sum(valor)::numeric(12,2) FROM por_categoria WHERE na_nota IS NOT TRUE), 0::numeric(12,2)) END,
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'data', data, 'total', total, 'itens', itens
                 ) ORDER BY data) FROM por_dia), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION hub_adiantamento_extrato_motorista() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_extrato_motorista() TO authenticated;
