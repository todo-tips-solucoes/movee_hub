-- 0071 — GET /motorista/repasse (tasks.md 3.9, gap identificado onda-019):
-- `hub_adiantamento_repasse_motorista()` (0067:979) só devolvia
-- {visivel, periodo_inicio, periodo_fim, data_repasse, previsao} — previsao
-- era só a soma dos adiantamentos JÁ pagos no período (o lado "débito"),
-- insuficiente para o contrato (contracts/motorista-api.md §GET
-- /motorista/repasse) e para o cliente já tipado em
-- app_homologacao/frontend_motorista/lib/adiantamento-api.ts (onda-019, tipo
-- `Repasse`: situacao/creditos/adiantamentos[]/debitos/remanescente/negativo).
--
-- Reaproveita a MESMA fonte/fórmula de `hub_adiantamento_repasse` (0067:1760,
-- listagem do hub): "FaturamentoLancamento" (créditos/débitos por categoria e
-- data-base configuradas) + "AdiantamentoSolicitacao" (adiantamentos pagos no
-- período) — só que escopada a UM entregador via `hub_jwt_motorista_cnpj()`
-- em vez de `hub_jwt_escopo_ids()`. `situacao` vem de existir ou não uma
-- "ApuracaoRepasse" para (id_empresa, periodo_inicio) — mesma tabela que
-- `hub_adiantamento_repasse_fechar` grava (imutável, R-15/R-16).
--
-- Assinatura muda (colunas novas) — precisa DROP antes do CREATE (mesmo
-- padrão de 0068:292 para `hub_adiantamento_notificar`).

DROP FUNCTION IF EXISTS hub_adiantamento_repasse_motorista();

CREATE FUNCTION hub_adiantamento_repasse_motorista()
RETURNS TABLE (
    visivel       boolean,
    periodo_inicio date,
    periodo_fim   date,
    data_repasse  date,
    situacao      text,
    creditos      numeric(12,2),
    debitos       numeric(12,2),
    remanescente  numeric(12,2),
    negativo      boolean,
    adiantamentos jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_cnpj        text := hub_jwt_motorista_cnpj();
    v_conta_motorista_id int;
    v_entregador  RECORD;
    v_config      "AdiantamentoConfiguracao";
    v_inicio      date;
    v_fim         date;
    v_creditos    numeric(12,2) := 0;
    v_debitos     numeric(12,2) := 0;
    v_desconto    numeric(12,2) := 0;
    v_adiant      jsonb := '[]'::jsonb;
    v_fechada     boolean;
BEGIN
    IF v_cnpj IS NULL THEN RETURN; END IF;
    SELECT cm.id INTO v_conta_motorista_id FROM "ContaMotorista" cm WHERE cm.cnpj_prestador = v_cnpj;
    IF v_conta_motorista_id IS NULL THEN RETURN; END IF;
    SELECT e.* INTO v_entregador FROM "Entregador" e WHERE e.motorista_id = v_conta_motorista_id;
    IF NOT FOUND THEN RETURN; END IF;

    SELECT * INTO v_config FROM hub_adiantamento_config_vigente(v_entregador.id_empresa);
    IF v_config.id IS NULL OR NOT v_config.repasse_visivel_app OR v_config.apuracao_dia_inicio IS NULL THEN
        RETURN QUERY SELECT false, NULL::date, NULL::date, NULL::date, NULL::text,
            NULL::numeric(12,2), NULL::numeric(12,2), NULL::numeric(12,2), NULL::boolean, NULL::jsonb;
        RETURN;
    END IF;

    v_inicio := current_date - ((extract(dow FROM current_date)::int - v_config.apuracao_dia_inicio + 7) % 7);
    v_fim := v_inicio + 6;

    -- Créditos (produção do período) — mesma CTE `creditos` de hub_adiantamento_repasse.
    SELECT COALESCE(sum(f.valor), 0) INTO v_creditos
    FROM "FaturamentoLancamento" f
    WHERE f.entregador_id = v_entregador.id AND f.tipo = 'Credito'
      AND f.descricao = ANY (COALESCE(v_config.categorias_extrato, ARRAY[]::text[]))
      AND (
          (v_config.apuracao_data_base = 'data_lancamento' AND f.data_lancamento BETWEEN v_inicio AND v_fim)
          OR (v_config.apuracao_data_base = 'data_referencia' AND f.data_referencia BETWEEN v_inicio AND v_fim)
      );

    -- Outros débitos do extrato (gated por desconto_debitos) — mesma CTE
    -- `debitos_cte` de hub_adiantamento_repasse.
    IF v_config.desconto_debitos THEN
        SELECT COALESCE(sum(abs(f.valor)), 0) INTO v_debitos
        FROM "FaturamentoLancamento" f
        WHERE f.entregador_id = v_entregador.id AND f.tipo = 'Debito'
          AND (
              (v_config.apuracao_data_base = 'data_lancamento' AND f.data_lancamento BETWEEN v_inicio AND v_fim)
              OR (v_config.apuracao_data_base = 'data_referencia' AND f.data_referencia BETWEEN v_inicio AND v_fim)
          );
    END IF;

    -- Lista de adiantamentos do período (display, independente do flag de
    -- desconto — o motorista vê o que recebeu mesmo que a empresa não
    -- deduza do repasse).
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', s.id, 'dataProducao', s.data_producao, 'valorBruto', s.valor_bruto,
        'emProcessamento', s.status = 'EXPORTADA'
    ) ORDER BY s.data_producao), '[]'::jsonb) INTO v_adiant
    FROM "AdiantamentoSolicitacao" s
    WHERE s.entregador_id = v_entregador.id AND s.status IN ('PAGA', 'EXPORTADA')
      AND s.data_producao BETWEEN v_inicio AND v_fim;

    -- Dedução do bruto dos adiantamentos pagos (gated por desconto_adiantamentos)
    -- — mesma soma que a `previsao` da versão anterior desta função.
    IF v_config.desconto_adiantamentos THEN
        SELECT COALESCE(sum(s.valor_bruto), 0) INTO v_desconto
        FROM "AdiantamentoSolicitacao" s
        WHERE s.entregador_id = v_entregador.id AND s.status IN ('PAGA', 'EXPORTADA')
          AND s.data_producao BETWEEN v_inicio AND v_fim;
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM "ApuracaoRepasse" ar
        WHERE ar.id_empresa = v_entregador.id_empresa AND ar.periodo_inicio = v_inicio
    ) INTO v_fechada;

    RETURN QUERY SELECT true, v_inicio, v_fim, v_fim + v_config.apuracao_dias_ate_repasse,
        (CASE WHEN v_fechada THEN 'FECHADA' ELSE 'EM_APURACAO' END)::text,
        v_creditos, v_debitos, (v_creditos - v_desconto - v_debitos),
        ((v_creditos - v_desconto - v_debitos) < 0), v_adiant;
END;
$$;

REVOKE ALL ON FUNCTION hub_adiantamento_repasse_motorista() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_repasse_motorista() TO authenticated;
