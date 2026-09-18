-- 0082 — FASE 13 (converge, 13.7/FR-039, o achado mais crítico da 3a
-- passada): `hub_adiantamento_repasse_fechar` (CTE `pagas`, 0067:1979)
-- congela `ApuracaoRepasseItem.adiantamentos` só com `status = 'PAGA'`,
-- enquanto a listagem do hub (`hub_adiantamento_repasse`, 0067:1841) e o
-- detalhe do app (`hub_adiantamento_repasse_motorista`, 0071:99,107) usam
-- `status IN ('PAGA', 'EXPORTADA')` na MESMA janela de período. Alinha o
-- critério de fechamento ao da listagem/app.
--
-- `ApuracaoRepasse`/`ApuracaoRepasseItem` são IMUTÁVEIS por trigger
-- (0066:463/477) — fechar com o critério errado não se desfaz depois, daí
-- a criticidade. Na prática, `hub_adiantamento_repasse_pode_fechar` já
-- recusa fechar (`APURACAO_COM_PENDENCIAS`) enquanto existir solicitação
-- `EXPORTADA` com `data_producao` no período, então o conjunto adicional é
-- vazio sob o fluxo normal — a mudança é defesa em profundidade (alinha o
-- filtro ao das duas fontes irmãs, para não depender de essa invariante de
-- gate nunca relaxar/ter um furo de corrida) e documenta explicitamente a
-- intenção de "mesma fonte de cálculo" já afirmada no comentário original
-- da função. Provar com o driver de integração (não só unit): fechar um
-- período e conferir que o item congelado bate com o que a listagem
-- informa (tasks.md 13.7).
--
-- Assinatura/retorno inalterados — GRANT/REVOKE de 0067 permanecem válidos.

CREATE OR REPLACE FUNCTION hub_adiantamento_repasse_fechar(p_periodo_inicio date)
RETURNS TABLE (apuracao_id bigint, motoristas int, total numeric, nao_pagos_no_periodo int)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_sub      int := NULLIF(hub_jwt_claims() ->> 'sub', '')::int;
    v_config   "AdiantamentoConfiguracao";
    v_fim      date;
    v_escopo   int[] := hub_jwt_escopo_ids();
    v_pendencias jsonb;
    v_apuracao_id bigint;
    v_motoristas  int;
    v_total       numeric(14,2);
    v_nao_pagos   int;
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.pagamento_confirmar') THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;

    SELECT * INTO v_config FROM hub_adiantamento_config_vigente(6);
    IF v_config.id IS NULL OR v_config.apuracao_data_base IS NULL THEN
        RAISE EXCEPTION 'APURACAO_NAO_CONFIGURADA';
    END IF;
    v_fim := p_periodo_inicio + 6;

    -- 1.6.3 (dec-043): não fechar enquanto a produção do último dia ainda
    -- puder ser solicitada (D-1 até o corte do dia seguinte).
    IF NOT hub_adiantamento_repasse_pode_fechar(v_config, v_fim, now()) THEN
        RAISE EXCEPTION 'PERIODO_EM_ABERTO';
    END IF;

    SELECT jsonb_object_agg(s.status, s.qtd) INTO v_pendencias
    FROM (
        SELECT status, count(*) AS qtd
        FROM "AdiantamentoSolicitacao"
        WHERE id_empresa = ANY (v_escopo)
          AND data_producao BETWEEN p_periodo_inicio AND v_fim
          AND status IN ('AGUARDANDO_CORTE', 'AGUARDANDO_PRODUCAO', 'LIBERADA', 'EM_LOTE', 'EXPORTADA', 'FALHOU')
        GROUP BY status
    ) s;

    IF v_pendencias IS NOT NULL THEN
        RAISE EXCEPTION 'APURACAO_COM_PENDENCIAS' USING DETAIL = v_pendencias::text;
    END IF;

    BEGIN
        INSERT INTO "ApuracaoRepasse" (id_empresa, periodo_inicio, periodo_fim, data_repasse, configuracao_id, fechado_por)
        VALUES (6, p_periodo_inicio, v_fim, v_fim + v_config.apuracao_dias_ate_repasse, v_config.id, v_sub)
        RETURNING id INTO v_apuracao_id;
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'APURACAO_JA_FECHADA';
    END;

    WITH creditos AS (
        SELECT f.entregador_id, sum(f.valor) AS total
        FROM "FaturamentoLancamento" f
        WHERE f.id_empresa = ANY (v_escopo) AND f.tipo = 'Credito'
          AND f.descricao = ANY (COALESCE(v_config.categorias_extrato, ARRAY[]::text[]))
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
    pagas AS (
        -- 13.7: alinhado a hub_adiantamento_repasse (0067:1841) e
        -- hub_adiantamento_repasse_motorista (0071:99,107) — mesma janela,
        -- mesmo critério de status.
        SELECT s.entregador_id, sum(s.valor_bruto) AS total, jsonb_agg(s.id) AS ids
        FROM "AdiantamentoSolicitacao" s
        WHERE s.id_empresa = ANY (v_escopo) AND s.status IN ('PAGA', 'EXPORTADA')
          AND s.data_producao BETWEEN p_periodo_inicio AND v_fim
        GROUP BY s.entregador_id
    ),
    linhas AS (
        SELECT
            e.id AS entregador_id,
            COALESCE(c.total, 0) AS creditos,
            CASE WHEN v_config.desconto_adiantamentos THEN COALESCE(p.total, 0) ELSE 0 END AS adiantamentos,
            CASE WHEN v_config.desconto_debitos THEN COALESCE(d.total, 0) ELSE 0 END AS debitos,
            COALESCE(p.ids, '[]'::jsonb) AS solicitacoes_pagas
        FROM "Entregador" e
        LEFT JOIN creditos c ON c.entregador_id = e.id
        LEFT JOIN debitos_cte d ON d.entregador_id = e.id
        LEFT JOIN pagas p ON p.entregador_id = e.id
        WHERE e.id_empresa = ANY (v_escopo)
          AND (c.entregador_id IS NOT NULL OR d.entregador_id IS NOT NULL OR p.entregador_id IS NOT NULL)
    )
    INSERT INTO "ApuracaoRepasseItem" (apuracao_id, id_empresa, entregador_id, creditos, adiantamentos, debitos, remanescente, detalhe)
    SELECT v_apuracao_id, 6, l.entregador_id, l.creditos, l.adiantamentos, l.debitos,
           (l.creditos - l.adiantamentos - l.debitos),
           jsonb_build_object('solicitacoesPagas', l.solicitacoes_pagas)
    FROM linhas l;

    SELECT count(*), COALESCE(sum(i.remanescente), 0) INTO v_motoristas, v_total
    FROM "ApuracaoRepasseItem" i WHERE i.apuracao_id = v_apuracao_id;

    SELECT count(*) INTO v_nao_pagos
    FROM "AdiantamentoSolicitacao"
    WHERE id_empresa = ANY (v_escopo) AND data_producao BETWEEN p_periodo_inicio AND v_fim
      AND status NOT IN ('PAGA', 'CANCELADA');

    RETURN QUERY SELECT v_apuracao_id, v_motoristas, v_total::numeric, v_nao_pagos;
END;
$$;
