-- 0111 — Corte das "notas pendentes" do motorista, configurável no hub.
--
-- POR QUE EXISTE: o recorte de quais movimentos o motorista pode regularizar no
-- app estava FIXO no código (`routes/motorista.js`: 90 dias por created_at e
-- corte 2026-07-20 por dt_inicial). Mudar exigia deploy. Passa a viver na
-- config versionada do adiantamento (mesma tela, mesma permissão
-- `adiantamentos.configurar`, mesmo histórico/auditoria).
--
-- SEMÂNTICA: o operador escolhe UM modo — 'dias' (janela móvel: últimos N dias)
-- ou 'data' (a partir de uma data fixa). Os dois comparam com
-- "EnvioMassa".dt_inicial (semana do movimento), nunca com created_at. O filtro
-- antigo de 90 dias por created_at deixa de existir. Defaults = comportamento
-- vigente: modo 'data', 2026-07-20 (dias 90 fica guardado para quando trocar
-- de modo). Linhas já existentes recebem os defaults.
--
-- `hub_adiantamento_configuracao_salvar` vem da **0098** (a versão viva; foi
-- redefinida em 0067, 0075, 0090, 0091 e 0098). Mesma assinatura e tipo de
-- retorno (linha inteira da tabela) → CREATE OR REPLACE mantém os GRANTs da
-- 0067; só acrescenta as 3 colunas no INSERT, com o mesmo padrão COALESCE.
--
-- Aditiva e idempotente. ROLLBACK: reaplicar a função da 0098; as colunas podem
-- ficar (inertes) ou sair com DROP COLUMN. Depois de aplicar: SIGUSR1 no PostgREST.

ALTER TABLE "AdiantamentoConfiguracao"
  ADD COLUMN IF NOT EXISTS notas_pendentes_corte_modo text NOT NULL DEFAULT 'data',
  ADD COLUMN IF NOT EXISTS notas_pendentes_corte_dias int  NOT NULL DEFAULT 90,
  ADD COLUMN IF NOT EXISTS notas_pendentes_corte_data date NOT NULL DEFAULT DATE '2026-07-20';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'adiantamentoconfiguracao_notas_pendentes_corte_modo_valido') THEN
    ALTER TABLE "AdiantamentoConfiguracao" ADD CONSTRAINT adiantamentoconfiguracao_notas_pendentes_corte_modo_valido
      CHECK (notas_pendentes_corte_modo IN ('dias', 'data'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'adiantamentoconfiguracao_notas_pendentes_corte_dias_faixa') THEN
    ALTER TABLE "AdiantamentoConfiguracao" ADD CONSTRAINT adiantamentoconfiguracao_notas_pendentes_corte_dias_faixa
      CHECK (notas_pendentes_corte_dias BETWEEN 1 AND 3650);
  END IF;
END $$;

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
    v_piso_novo numeric(14,2);
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.configurar') THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;
    IF NOT (6 = ANY (hub_jwt_escopo_ids())) THEN RAISE EXCEPTION 'FORA_DO_GRUPO_MOVEE'; END IF;

    SELECT * INTO v_atual FROM "AdiantamentoConfiguracao"
        WHERE id_empresa = 6 ORDER BY versao DESC LIMIT 1 FOR UPDATE;
    IF v_atual.versao IS DISTINCT FROM p_versao_esperada THEN
        RAISE EXCEPTION 'VERSAO_DESATUALIZADA';
    END IF;

    -- F3/FR-026 (Decision 12): alterar o piso exige a permissão MAIS
    -- restrita (pagamento_confirmar), não a genérica (configurar) já
    -- checada acima. Repete a checagem de `> 0` do backend em defesa de
    -- profundidade (o CHECK do banco também recusaria, mas com uma
    -- mensagem genérica de constraint em vez do motivo de negócio).
    IF p_dados ? 'repasseValorMinimo' THEN
        v_piso_novo := NULLIF(p_dados ->> 'repasseValorMinimo', '')::numeric;
        IF v_piso_novo IS NULL OR v_piso_novo <= 0 THEN
            RAISE EXCEPTION 'DADOS_INVALIDOS_REPASSE_VALOR_MINIMO';
        END IF;
        IF v_piso_novo IS DISTINCT FROM v_atual.repasse_valor_minimo THEN
            IF NOT hub_adiantamento_tem_permissao('adiantamentos.pagamento_confirmar') THEN
                RAISE EXCEPTION 'PERMISSAO_NEGADA_PISO';
            END IF;
        END IF;
    END IF;

    BEGIN
        INSERT INTO "AdiantamentoConfiguracao" (
            id_empresa, versao, vigente_desde, timezone, dias_habilitados, horario_abertura,
            horario_corte, percentual, taxa_fixa, fonte_producao, categorias_producao,
            previsao_pagamento_texto, descricao_pix_modelo, apuracao_dia_inicio,
            apuracao_dias_ate_repasse, apuracao_data_base, categorias_extrato, categorias_nota,
            mensagem1_modelo, mensagem2_modelo, repasse_valor_minimo,
            desconto_adiantamentos, desconto_debitos, repasse_visivel_app,
            notas_pendentes_corte_modo, notas_pendentes_corte_dias, notas_pendentes_corte_data,
            criado_por, motivo
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
            COALESCE((SELECT array_agg(x) FROM jsonb_array_elements_text(p_dados -> 'categoriasNota') x), v_atual.categorias_nota),
            COALESCE(p_dados ->> 'mensagem1Modelo', v_atual.mensagem1_modelo),
            COALESCE(p_dados ->> 'mensagem2Modelo', v_atual.mensagem2_modelo),
            -- F3: sem isso, salvar qualquer outro campo voltaria o piso ao
            -- default (5.50) em vez de manter o valor vigente.
            COALESCE(v_piso_novo, v_atual.repasse_valor_minimo, 5.50),
            COALESCE((p_dados ->> 'descontoAdiantamentos')::boolean, v_atual.desconto_adiantamentos, true),
            COALESCE((p_dados ->> 'descontoDebitos')::boolean, v_atual.desconto_debitos, false),
            COALESCE((p_dados ->> 'repasseVisivelApp')::boolean, v_atual.repasse_visivel_app, false),
            -- 0111: corte das notas pendentes do motorista. Sem isto, salvar qualquer
            -- outro campo voltaria o corte ao default em vez de manter o vigente.
            COALESCE(p_dados ->> 'notasPendentesCorteModo', v_atual.notas_pendentes_corte_modo, 'data'),
            COALESCE((p_dados ->> 'notasPendentesCorteDias')::int, v_atual.notas_pendentes_corte_dias, 90),
            COALESCE((p_dados ->> 'notasPendentesCorteData')::date, v_atual.notas_pendentes_corte_data, DATE '2026-07-20'),
            v_sub,
            p_dados ->> 'motivo'
        ) RETURNING * INTO v_nova;
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'VERSAO_DESATUALIZADA';
    END;

    RETURN v_nova;
END;
$$;
