-- 0081 — FASE 13 (converge, 13.6/FR-013+FR-042): `hub_adiantamento_recalcular`
-- muda o status da solicitação (LIBERADA ou INELEGIVEL, via
-- hub_adiantamento_calcular_liberacao) e nunca notifica o motorista. O tick
-- (0067:2106) faz a MESMA transição e já notifica; 11.22/12.x (0075:497,525)
-- corrigiram os irmãos `lote_cancelar`/`reprocessar` na mesma sessão de
-- convergência — `recalcular` ficou de fora. Mesmo CASE do tick, reusado
-- tal-e-qual.
--
-- Assinatura/retorno inalterados — GRANT/REVOKE de 0067 permanecem válidos.

CREATE OR REPLACE FUNCTION hub_adiantamento_recalcular(p_id bigint)
RETURNS TABLE (id bigint, status text, valor_liquido numeric)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_sol    "AdiantamentoSolicitacao";
    v_config "AdiantamentoConfiguracao";
    v_calc   RECORD;
BEGIN
    SELECT * INTO v_sol FROM "AdiantamentoSolicitacao" WHERE id = p_id AND id_empresa = ANY (hub_jwt_escopo_ids());
    IF NOT FOUND THEN RAISE EXCEPTION 'NAO_ENCONTRADA'; END IF;
    IF v_sol.status <> 'AGUARDANDO_PRODUCAO' THEN
        RAISE EXCEPTION 'TRANSICAO_INVALIDA';
    END IF;

    SELECT * INTO v_config FROM "AdiantamentoConfiguracao" WHERE id = v_sol.configuracao_id;
    SELECT * INTO v_calc FROM hub_adiantamento_calcular_liberacao(v_sol.entregador_id, v_sol.data_producao, v_config);

    IF NOT v_calc.disponivel THEN
        RAISE EXCEPTION 'PRODUCAO_INDISPONIVEL';
    END IF;

    UPDATE "AdiantamentoSolicitacao" SET
        fonte_producao = v_config.fonte_producao,
        categorias_producao = v_config.categorias_producao,
        producao_valor = v_calc.prod_valor,
        producao_lancamentos = v_calc.prod_lancamentos,
        producao_por_categoria = v_calc.prod_por_categoria,
        percentual = v_config.percentual,
        valor_bruto = v_calc.valor_bruto,
        taxa = v_config.taxa_fixa,
        valor_liquido = v_calc.valor_liquido,
        calculado_em = now(),
        status = v_calc.novo_status,
        motivo_status = v_calc.motivo,
        conta_bancaria_id = COALESCE(v_calc.conta_bancaria_id, conta_bancaria_id)
    WHERE id = p_id;

    -- 13.6: mesma notificação que o tick (0067:2106) já dá para a idêntica
    -- transição — recalcular é ação manual do financeiro, mas o motorista
    -- também precisa saber que o valor mudou.
    PERFORM hub_adiantamento_notificar(p_id, CASE WHEN v_calc.novo_status = 'LIBERADA' THEN 'liberada' ELSE 'inelegivel' END);

    RETURN QUERY SELECT p_id, v_calc.novo_status, v_calc.valor_liquido;
END;
$$;
