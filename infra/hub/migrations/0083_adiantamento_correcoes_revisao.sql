-- 0083 — correções da revisão do PR #182 (adiantamento pelo app). Quatro
-- funções, cada uma com um defeito medido no código; nenhuma migration
-- anterior é editada (0066–0082 já aplicadas).
--
--  (1) hub_adiantamento_lote_confirmar (0067:1761-1762) — CRÍTICA/dinheiro:
--      o UPDATE que marca FALHOU usava só `id = ANY(v_falha_ids)`, com
--      `v_falha_ids` vindo CRU de `p_falhas` (corpo da requisição), sem
--      nenhum vínculo com `p_lote_id`. A função é SECURITY DEFINER, então
--      RLS não protege: um id de outro lote — inclusive de outra empresa —
--      era marcado FALHOU. Consequência: adiantamento JÁ PAGO pela
--      Transfeera vira FALHOU, deixa de ser descontado do repasse
--      (0067:1841 e 0082:113 só somam PAGA/EXPORTADA — a empresa paga o
--      adiantamento E o repasse cheio) e volta a ser elegível a
--      `hub_adiantamento_reprocessar` -> segundo pagamento.
--      Correção: escopar o UPDATE ao lote E recusar explicitamente
--      (SOLICITACAO_FORA_DO_LOTE) qualquer id de `p_falhas` que não seja
--      item de `p_lote_id` — ignorar em silêncio é justamente o modo de
--      falha que deixou isso passar.
--
--  (2) hub_adiantamento_repasse_motorista (0071:66) — data sem fuso: a
--      janela semanal saía de `current_date`, que é a data na TimeZone da
--      SESSÃO (o Postgres/PostgREST rodam em UTC), não a de São Paulo. Aos
--      domingos, das 21h à meia-noite BRT, já é segunda em UTC: a janela
--      pulava para a semana nova 3 h cedo e o motorista via a semana
--      zerada, toda semana. Correção: `(now() AT TIME ZONE
--      v_config.timezone)::date`, mesmo padrão de hub_adiantamento_janela
--      (0067:133-137) e hub_adiantamento_corte_passou (0067:2039).
--      (A versão de 0067:1006 tinha a mesma raiz, mas foi DROPada por 0071
--      — a única viva é esta.)
--
--  (3) hub_adiantamento_categorias (0067:1271) — mesma raiz: `current_date
--      - 90` na TimeZone da sessão.
--
--  (4) hub_adiantamento_repasse (0067:1790) — número de decisão errado: a
--      função só devolvia `count(*) OVER ()`, então o backend somava os
--      totais das linhas da PÁGINA (20 por padrão) e exibia junto da
--      contagem do período inteiro ("Total (137 motorista(s)) · R$ X" com X
--      = soma de 20 linhas) — na tela onde se decide fechar a apuração.
--      Correção: os totais saem da própria RPC por janela `sum(...) OVER ()`
--      sobre `filtradas` (mesmo espírito do `count(*) OVER ()` que já
--      existia), calculados ANTES de OFFSET/LIMIT. O RETURNS TABLE muda ->
--      DROP + CREATE + GRANTs restaurados (padrão de 0074/0075).

-- ═══════════════════════════════════════════════════════════════════════
-- (1) hub_adiantamento_lote_confirmar — falhas escopadas ao lote
-- ═══════════════════════════════════════════════════════════════════════
-- Assinatura e RETURNS TABLE inalterados -> CREATE OR REPLACE basta.
CREATE OR REPLACE FUNCTION hub_adiantamento_lote_confirmar(p_lote_id bigint, p_falhas jsonb DEFAULT '[]')
RETURNS TABLE (id bigint, status text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_lote        "AdiantamentoLote";
    v_sub         int := NULLIF(hub_jwt_claims() ->> 'sub', '')::int;
    v_falha_ids   bigint[];
    v_pagas_ids   bigint[];
    v_falhas_count int;
    v_status_final text;
    v_solid       bigint;
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.pagamento_confirmar') THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;

    SELECT * INTO v_lote FROM "AdiantamentoLote" WHERE id = p_lote_id AND id_empresa = ANY (hub_jwt_escopo_ids()) FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NAO_ENCONTRADA'; END IF;
    IF v_lote.status <> 'EXPORTADO' THEN RAISE EXCEPTION 'TRANSICAO_INVALIDA'; END IF;

    SELECT array_agg((f ->> 'id')::bigint) INTO v_falha_ids FROM jsonb_array_elements(COALESCE(p_falhas, '[]'::jsonb)) f;

    -- Recusa EXPLÍCITA (nunca silenciosa): todo id de `p_falhas` tem que ser
    -- item DESTE lote. Sem isso o UPDATE de status abaixo alcançava
    -- solicitação de outro lote/outra empresa (SECURITY DEFINER, RLS não
    -- protege) e marcava FALHOU um adiantamento já pago.
    IF EXISTS (
        SELECT 1 FROM unnest(COALESCE(v_falha_ids, ARRAY[]::bigint[])) fid
        WHERE NOT EXISTS (
            SELECT 1 FROM "AdiantamentoLoteItem" li
            WHERE li.lote_id = p_lote_id AND li.solicitacao_id = fid
        )
    ) THEN
        RAISE EXCEPTION 'SOLICITACAO_FORA_DO_LOTE';
    END IF;

    UPDATE "AdiantamentoLoteItem" li
    SET situacao = 'falhou', situacao_motivo = f ->> 'motivo', situacao_em = now(), situacao_por = v_sub, origem_situacao = 'manual'
    FROM jsonb_array_elements(COALESCE(p_falhas, '[]'::jsonb)) f
    WHERE li.lote_id = p_lote_id AND li.solicitacao_id = (f ->> 'id')::bigint AND li.situacao = 'incluido';

    UPDATE "AdiantamentoLoteItem"
    SET situacao = 'pago', situacao_em = now(), situacao_por = v_sub, origem_situacao = 'manual'
    WHERE lote_id = p_lote_id AND situacao = 'incluido';

    -- Defesa em profundidade: mesmo com a recusa acima, o UPDATE é escopado
    -- ao lote (o de 0067 não era escopado por nada).
    UPDATE "AdiantamentoSolicitacao" s SET status = 'FALHOU'
    WHERE s.id = ANY (COALESCE(v_falha_ids, ARRAY[]::bigint[])) AND s.status = 'EXPORTADA'
      AND EXISTS (
          SELECT 1 FROM "AdiantamentoLoteItem" li
          WHERE li.lote_id = p_lote_id AND li.solicitacao_id = s.id
      );

    SELECT array_agg(li.solicitacao_id) INTO v_pagas_ids FROM "AdiantamentoLoteItem" li
    WHERE li.lote_id = p_lote_id AND li.situacao = 'pago';
    UPDATE "AdiantamentoSolicitacao" SET status = 'PAGA'
    WHERE id = ANY (COALESCE(v_pagas_ids, ARRAY[]::bigint[])) AND status = 'EXPORTADA';

    SELECT count(*) INTO v_falhas_count FROM "AdiantamentoLoteItem" WHERE lote_id = p_lote_id AND situacao = 'falhou';
    v_status_final := CASE WHEN v_falhas_count > 0 THEN 'CONCLUIDO_COM_FALHAS' ELSE 'CONCLUIDO' END;

    UPDATE "AdiantamentoLote" SET status = v_status_final, concluido_em = now() WHERE id = p_lote_id;

    -- 5.2 (FASE 5): "pagamento realizado" e "pagamento falhou" são eventos
    -- distintos por solicitação (FR-013) — não um único 'lote_confirmado'
    -- agregado, que misturaria as duas mensagens.
    FOREACH v_solid IN ARRAY COALESCE(v_falha_ids, ARRAY[]::bigint[]) LOOP
        PERFORM hub_adiantamento_notificar(v_solid, 'lote_falhou');
    END LOOP;
    FOREACH v_solid IN ARRAY COALESCE(v_pagas_ids, ARRAY[]::bigint[]) LOOP
        PERFORM hub_adiantamento_notificar(v_solid, 'lote_pago');
    END LOOP;

    RETURN QUERY SELECT p_lote_id, v_status_final;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- (2) hub_adiantamento_repasse_motorista — janela na TZ da configuração
-- ═══════════════════════════════════════════════════════════════════════
-- Corpo idêntico ao de 0071, exceto a linha de `v_inicio`. Assinatura e
-- RETURNS TABLE inalterados -> CREATE OR REPLACE basta (GRANT de 0071 vale).
CREATE OR REPLACE FUNCTION hub_adiantamento_repasse_motorista()
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
    v_hoje        date;
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

    -- "Hoje" é o dia em São Paulo (v_config.timezone), nunca `current_date`
    -- (data na TimeZone da sessão — UTC em produção): domingo 21h BRT já é
    -- segunda em UTC e a janela virava 3 h antes da hora, zerando a semana
    -- do motorista das 21h à meia-noite. Mesmo padrão de
    -- hub_adiantamento_janela (0067:133) e hub_adiantamento_corte_passou.
    v_hoje := (now() AT TIME ZONE v_config.timezone)::date;
    v_inicio := v_hoje - ((extract(dow FROM v_hoje)::int - v_config.apuracao_dia_inicio + 7) % 7);
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

-- ═══════════════════════════════════════════════════════════════════════
-- (3) hub_adiantamento_categorias — os 90 dias contados em São Paulo
-- ═══════════════════════════════════════════════════════════════════════
-- Sem config à mão aqui (é por empresa e a listagem é multi-escopo); o
-- módulo inteiro é pinado a America/Sao_Paulo pelo CHECK
-- `adiantamentoconfiguracao_timezone_chk` (0066:76), então o literal é a
-- mesma TZ que `v_config.timezone` teria.
CREATE OR REPLACE FUNCTION hub_adiantamento_categorias(p_fonte text DEFAULT NULL)
RETURNS TABLE (descricao text, lancamentos bigint, sem_motorista_identificado boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT f.descricao, count(*), bool_or(f.entregador_id IS NULL)
    FROM "FaturamentoLancamento" f
    WHERE f.id_empresa = ANY (hub_jwt_escopo_ids())
      AND f.tipo = 'Credito'
      AND f.data_referencia >= ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 90)
    GROUP BY f.descricao
    ORDER BY f.descricao;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- (4) hub_adiantamento_repasse — totais do PERÍODO, não da página
-- ═══════════════════════════════════════════════════════════════════════
-- RETURNS TABLE muda (4 colunas novas) -> CREATE OR REPLACE não serve;
-- DROP + CREATE, com os GRANTs de 0067:2272-2273 restaurados no fim (o DROP
-- leva os GRANTs junto).
DROP FUNCTION IF EXISTS hub_adiantamento_repasse(date, text, boolean, int, int);

CREATE FUNCTION hub_adiantamento_repasse(
    p_periodo_inicio date, p_busca text DEFAULT NULL, p_somente_negativos boolean DEFAULT false,
    p_offset int DEFAULT 0, p_limite int DEFAULT 20
)
RETURNS TABLE (
    entregador_id int, nome text, creditos numeric, adiantamentos numeric, debitos numeric,
    remanescente numeric, em_processamento boolean, total bigint,
    total_creditos numeric, total_adiantamentos numeric, total_debitos numeric, total_remanescente numeric
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
    adiant AS (
        SELECT s.entregador_id,
               sum(s.valor_bruto) FILTER (WHERE s.status = 'PAGA')      AS pagos,
               sum(s.valor_bruto) FILTER (WHERE s.status = 'EXPORTADA') AS processando
        FROM "AdiantamentoSolicitacao" s
        WHERE s.id_empresa = ANY (v_escopo) AND s.data_producao BETWEEN p_periodo_inicio AND v_fim
          AND s.status IN ('PAGA', 'EXPORTADA')
        GROUP BY s.entregador_id
    ),
    linhas AS (
        SELECT
            e.id AS entregador_id, e.nome,
            COALESCE(c.total, 0) AS creditos,
            CASE WHEN v_config.desconto_adiantamentos THEN COALESCE(a.pagos, 0) ELSE 0 END AS adiantamentos,
            CASE WHEN v_config.desconto_debitos THEN COALESCE(d.total, 0) ELSE 0 END AS debitos,
            COALESCE(a.processando, 0) > 0 AS em_processamento
        FROM "Entregador" e
        LEFT JOIN creditos c ON c.entregador_id = e.id
        LEFT JOIN debitos_cte d ON d.entregador_id = e.id
        LEFT JOIN adiant a ON a.entregador_id = e.id
        WHERE e.id_empresa = ANY (v_escopo)
          AND (c.entregador_id IS NOT NULL OR d.entregador_id IS NOT NULL OR a.pagos IS NOT NULL OR a.processando IS NOT NULL)
          AND (p_busca IS NULL OR hub_normaliza_nome(e.nome) LIKE '%' || hub_normaliza_nome(p_busca) || '%')
    ),
    calc AS (
        SELECT *, (creditos - adiantamentos - debitos) AS remanescente FROM linhas
    ),
    filtradas AS (
        SELECT * FROM calc WHERE (NOT p_somente_negativos OR remanescente < 0)
    )
    -- As janelas `OVER ()` (contagem E totais) são avaliadas sobre TODAS as
    -- linhas de `filtradas`, antes de OFFSET/LIMIT — é o que faz os totais
    -- serem do período e não da página. Somar no Node as linhas paginadas
    -- dava "Total (137 motorista(s)) · R$ <soma de 20>" na tela de fechar
    -- apuração.
    SELECT f.entregador_id, f.nome, f.creditos, f.adiantamentos, f.debitos, f.remanescente,
           f.em_processamento, count(*) OVER (),
           sum(f.creditos) OVER (), sum(f.adiantamentos) OVER (),
           sum(f.debitos) OVER (), sum(f.remanescente) OVER ()
    FROM filtradas f
    ORDER BY f.nome
    OFFSET p_offset LIMIT p_limite;
END;
$$;

REVOKE ALL ON FUNCTION hub_adiantamento_repasse(date, text, boolean, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_repasse(date, text, boolean, int, int) TO authenticated;
