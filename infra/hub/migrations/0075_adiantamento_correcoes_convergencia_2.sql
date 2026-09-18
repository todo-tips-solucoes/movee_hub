-- 0075 — Segunda leva de correções de convergência (feature "Adiantamento
-- pelo App, Dados Bancários e Exportação Transfeera", FASE 11 / onda-039,
-- converge-report.md). Não edita 0066/0067/.../0074 (já aplicadas no
-- hub-homolog persistente) — expand-only.
--
-- Cobre:
--   11.1  — hub_adiantamento_disponibilidade passa a devolver `id_empresa`
--           (mudança de RETURNS TABLE — exige DROP + CREATE, mesmo padrão de
--           0074/11.10). O Node (routes/motorista-adiantamento.js) usa esse
--           campo para checar `mesmoGrupoQue(id_empresa, 6)` ANTES de chamar
--           `hub_adiantamento_solicitar` — defesa em profundidade: hoje a
--           elegibilidade de grupo depende inteiramente de o módulo
--           `adiantamentos` só estar ativado (ModuloEntidade) para empresas
--           do grupo Movee; ativa-lo por engano para outra empresa libera o
--           fluxo inteiro sem esse gate.
--   11.2  — hub_adiantamento_cancelar comparava o corte de HOJE
--           (`hub_adiantamento_janela(v_config, now())`) em vez do corte DO
--           DIA da solicitação — usa `hub_adiantamento_corte_passou` (mesma
--           função já usada pelo tick, 1.6.5) para as duas coincidirem.
--   11.5/11.6 — hub_adiantamento_lote_previa/hub_adiantamento_lote_criar
--           tratavam como apta qualquer solicitação com
--           `conta_bancaria_id IS NOT NULL`, mesmo que a conta referenciada
--           já tivesse sido SUBSTITUIDA/REJEITADA (11.6) — e não emitiam
--           nenhum sinal quando a conta aprovada do entregador mudou depois
--           da solicitação (11.5). Fix único: exigir que a conta do
--           snapshot ainda esteja com status='APROVADA'; motivo dedicado
--           `CONTA_ALTERADA` (mesmo nome já usado pelo comentário de
--           `hub_adiantamento_atualizar_conta`, a ação de resolução que já
--           existia sem gatilho).
--   11.11 — hub_adiantamento_configuracao_salvar comparava a versão
--           esperada contra `hub_adiantamento_config_vigente` (que filtra
--           `vigente_desde <= now()`), não contra a MAIOR versão gravada.
--           Uma versão agendada para o futuro ficava invisível ao
--           compare-and-swap. Agora compara contra `MAX(versao)` (com
--           `FOR UPDATE` para fechar a corrida) e traduz `unique_violation`
--           em `VERSAO_DESATUALIZADA` em vez de vazar como erro genérico.
--   11.22 — hub_adiantamento_lote_cancelar/hub_adiantamento_reprocessar
--           devolvem a solicitação a LIBERADA sem notificar o motorista
--           (FR-042 exige todo evento do sistema relacionado à solicitação).
--           Reusa o evento 'liberada' já existente em
--           hub_adiantamento_notificar (0068) — mesmo texto que o motorista
--           já recebe quando a solicitação é liberada pela primeira vez.

-- ─────────────────────────────────────────────────────────────────────────
-- 11.1 — hub_adiantamento_disponibilidade + id_empresa
-- ─────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS hub_adiantamento_disponibilidade();

CREATE FUNCTION hub_adiantamento_disponibilidade()
RETURNS TABLE (
    vinculado             boolean,
    modulo_ativo          boolean,
    configuracao_id       bigint,
    configuracao_completa boolean,
    dias_habilitados      smallint[],
    horario_abertura      time,
    horario_corte         time,
    percentual            numeric,
    taxa_fixa             numeric,
    previsao_pagamento_texto text,
    dia_habilitado        boolean,
    antes_abertura        boolean,
    apos_corte            boolean,
    data_solicitacao      date,
    data_producao         date,
    conta_aprovada        jsonb,
    conta_pendente        jsonb,
    solicitacao_do_dia    jsonb,
    motivo_indisponivel   text,
    configuracao_versao   int,
    estimate              jsonb,
    id_empresa            int
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
    v_janela             RECORD;
    v_completa           boolean;
    v_modulo_ativo       boolean;
    v_aprovada           "ContaBancariaMotorista";
    v_pendente           "ContaBancariaMotorista";
    v_sol                "AdiantamentoSolicitacao";
    v_prod               RECORD;
    v_bruto              numeric(12,2);
    v_liquido            numeric(12,2);
    v_elegivel           boolean;
    v_estimate           jsonb;
BEGIN
    IF v_cnpj IS NULL THEN
        RETURN QUERY SELECT false, false, NULL::bigint, false, NULL::smallint[], NULL::time, NULL::time,
            NULL::numeric, NULL::numeric, NULL::text, false, false, false, NULL::date, NULL::date,
            NULL::jsonb, NULL::jsonb, NULL::jsonb, 'NAO_AUTENTICADO'::text, NULL::int, NULL::jsonb, NULL::int;
        RETURN;
    END IF;

    SELECT cm.id INTO v_conta_motorista_id FROM "ContaMotorista" cm WHERE cm.cnpj_prestador = v_cnpj AND cm.ativo;
    IF v_conta_motorista_id IS NULL THEN
        RETURN QUERY SELECT false, false, NULL::bigint, false, NULL::smallint[], NULL::time, NULL::time,
            NULL::numeric, NULL::numeric, NULL::text, false, false, false, NULL::date, NULL::date,
            NULL::jsonb, NULL::jsonb, NULL::jsonb, 'NOT_LINKED'::text, NULL::int, NULL::jsonb, NULL::int;
        RETURN;
    END IF;

    SELECT e.* INTO v_entregador FROM "Entregador" e WHERE e.motorista_id = v_conta_motorista_id AND e.ativo LIMIT 1;
    IF NOT FOUND THEN
        RETURN QUERY SELECT false, false, NULL::bigint, false, NULL::smallint[], NULL::time, NULL::time,
            NULL::numeric, NULL::numeric, NULL::text, false, false, false, NULL::date, NULL::date,
            NULL::jsonb, NULL::jsonb, NULL::jsonb, 'NOT_LINKED'::text, NULL::int, NULL::jsonb, NULL::int;
        RETURN;
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM "ModuloEntidade" me JOIN "Modulo" m ON m.id = me.modulo_id
        WHERE me.empresa_id = v_entregador.id_empresa AND m.codigo = 'adiantamentos' AND me.ativo AND m.ativo
    ) INTO v_modulo_ativo;

    SELECT * INTO v_config FROM hub_adiantamento_config_vigente(v_entregador.id_empresa);
    IF v_config.id IS NULL THEN
        RETURN QUERY SELECT true, v_modulo_ativo, NULL::bigint, false, NULL::smallint[], NULL::time, NULL::time,
            NULL::numeric, NULL::numeric, NULL::text, false, false, false, NULL::date, NULL::date,
            NULL::jsonb, NULL::jsonb, NULL::jsonb, 'NOT_CONFIGURED'::text, NULL::int, NULL::jsonb, v_entregador.id_empresa;
        RETURN;
    END IF;

    v_completa := hub_adiantamento_config_completa(v_config);

    SELECT * INTO v_janela FROM hub_adiantamento_janela(v_config, now());

    SELECT * INTO v_aprovada FROM "ContaBancariaMotorista" WHERE entregador_id = v_entregador.id AND status = 'APROVADA';
    SELECT * INTO v_pendente FROM "ContaBancariaMotorista" WHERE entregador_id = v_entregador.id AND status = 'PENDENTE';
    SELECT * INTO v_sol FROM "AdiantamentoSolicitacao"
        WHERE entregador_id = v_entregador.id AND data_solicitacao = v_janela.data_solicitacao AND status <> 'CANCELADA';

    SELECT * INTO v_prod FROM hub_adiantamento_producao(v_entregador.id, v_janela.data_producao, v_config);
    v_bruto := NULL; v_liquido := NULL; v_elegivel := NULL;
    IF v_prod.disponivel THEN
        SELECT bl.bruto, bl.liquido INTO v_bruto, v_liquido FROM hub_adiantamento_bruto_liquido(v_prod.valor, v_config) bl;
        SELECT elegivel INTO v_elegivel FROM hub_adiantamento_elegibilidade(v_prod.valor, v_liquido);
    END IF;
    v_estimate := jsonb_build_object(
        'available', v_prod.disponivel,
        'production', CASE WHEN v_prod.disponivel THEN v_prod.valor ELSE NULL END,
        'gross', v_bruto,
        'fee', v_config.taxa_fixa,
        'net', CASE WHEN v_elegivel IS FALSE THEN NULL ELSE v_liquido END,
        'eligible', v_elegivel,
        'final', false
    );

    RETURN QUERY SELECT
        true, v_modulo_ativo, v_config.id, v_completa,
        v_config.dias_habilitados, v_config.horario_abertura, v_config.horario_corte,
        v_config.percentual, v_config.taxa_fixa, v_config.previsao_pagamento_texto,
        v_janela.dia_habilitado, v_janela.antes_abertura, v_janela.apos_corte,
        v_janela.data_solicitacao, v_janela.data_producao,
        CASE WHEN v_aprovada.id IS NULL THEN NULL ELSE hub_conta_bancaria_mascarar(v_aprovada) END,
        CASE WHEN v_pendente.id IS NULL THEN NULL ELSE hub_conta_bancaria_mascarar(v_pendente) END,
        CASE WHEN v_sol.id IS NULL THEN NULL ELSE (to_jsonb(v_sol) - 'aceite_texto_sha256') END,
        NULL::text,
        v_config.versao, v_estimate, v_entregador.id_empresa;
END;
$$;

REVOKE ALL ON FUNCTION hub_adiantamento_disponibilidade() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_disponibilidade() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 11.2 — hub_adiantamento_cancelar usa o corte DO DIA da solicitação
-- ─────────────────────────────────────────────────────────────────────────
-- A 0074 (11.10) já tinha mudado o RETURNS TABLE desta função para incluir
-- `id_empresa` (DROP+CREATE, motivo: auditoria do motorista) — CREATE OR
-- REPLACE FUNCTION não aceita mudar/manter um shape de colunas diferente do
-- que já está no catálogo sem repetir o DROP; mantém aqui a MESMA
-- assinatura de 3 colunas da 0074 (nunca reverte para 2).
DROP FUNCTION IF EXISTS hub_adiantamento_cancelar(bigint);
CREATE FUNCTION hub_adiantamento_cancelar(p_id bigint)
RETURNS TABLE (id bigint, status text, id_empresa int)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_cnpj   text := hub_jwt_motorista_cnpj();
    v_sol    "AdiantamentoSolicitacao";
    v_config "AdiantamentoConfiguracao";
BEGIN
    IF v_cnpj IS NULL THEN
        RAISE EXCEPTION 'NAO_AUTENTICADO';
    END IF;

    SELECT * INTO v_sol FROM "AdiantamentoSolicitacao" WHERE id = p_id AND cnpj_prestador = v_cnpj;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'NAO_ENCONTRADA';
    END IF;
    IF v_sol.status <> 'AGUARDANDO_CORTE' THEN
        RAISE EXCEPTION 'TRANSICAO_INVALIDA';
    END IF;

    SELECT * INTO v_config FROM "AdiantamentoConfiguracao" WHERE id = v_sol.configuracao_id;
    -- 11.2 (converge onda-039): corte do DIA DA SOLICITAÇÃO, não o de hoje —
    -- mesma função usada pelo tick (hub_adiantamento_processar/1.6.5), nunca
    -- `hub_adiantamento_janela(v_config, now())` (que sempre calcula a
    -- janela do dia corrente).
    IF hub_adiantamento_corte_passou(v_sol.data_solicitacao, v_config.horario_corte, v_config.timezone, now()) THEN
        RAISE EXCEPTION 'AFTER_CUTOFF';
    END IF;

    UPDATE "AdiantamentoSolicitacao" SET status = 'CANCELADA' WHERE id = p_id;

    RETURN QUERY SELECT p_id, 'CANCELADA'::text, v_sol.id_empresa;
END;
$$;

REVOKE ALL ON FUNCTION hub_adiantamento_cancelar(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_cancelar(bigint) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 11.5/11.6 — lote_previa/lote_criar exigem conta ainda APROVADA
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION hub_adiantamento_lote_previa(p_ids bigint[])
RETURNS TABLE (solicitacao_id bigint, apta boolean, motivo_pendencia text, valor_liquido numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
    RETURN QUERY
    SELECT
        s.id,
        (s.status = 'LIBERADA' AND s.valor_liquido > 0 AND s.conta_bancaria_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM "ContaBancariaMotorista" cb WHERE cb.id = s.conta_bancaria_id AND cb.status = 'APROVADA')
            AND NOT EXISTS (SELECT 1 FROM "AdiantamentoLoteItem" li WHERE li.solicitacao_id = s.id AND li.situacao IN ('incluido', 'pago'))),
        CASE
            WHEN EXISTS (SELECT 1 FROM "AdiantamentoLoteItem" li WHERE li.solicitacao_id = s.id AND li.situacao IN ('incluido', 'pago')) THEN 'JA_EM_LOTE'
            WHEN s.status <> 'LIBERADA' THEN 'STATUS_' || s.status
            WHEN s.valor_liquido IS NULL OR s.valor_liquido <= 0 THEN 'VALOR_INVALIDO'
            -- 11.5/11.6 (converge onda-039, FR-036): conta do snapshot ausente
            -- ou não mais APROVADA (SUBSTITUIDA/REJEITADA, ou trocada por
            -- outra depois da solicitação) — mesmo código já usado pelo
            -- comentário de hub_adiantamento_atualizar_conta, a ação de
            -- resolução (exige revisão explícita do financeiro).
            WHEN s.conta_bancaria_id IS NULL
                OR NOT EXISTS (SELECT 1 FROM "ContaBancariaMotorista" cb WHERE cb.id = s.conta_bancaria_id AND cb.status = 'APROVADA')
                THEN 'CONTA_ALTERADA'
            ELSE NULL
        END,
        s.valor_liquido
    FROM "AdiantamentoSolicitacao" s
    WHERE s.id = ANY (p_ids) AND s.id_empresa = ANY (hub_jwt_escopo_ids());
END;
$$;

CREATE OR REPLACE FUNCTION hub_adiantamento_lote_criar(
    p_ids bigint[], p_quantidade_esperada int, p_total_esperado numeric, p_chave uuid
)
RETURNS TABLE (id bigint, status text, quantidade int, valor_total numeric, reutilizado boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_sub          int := NULLIF(hub_jwt_claims() ->> 'sub', '')::int;
    v_empresa      int := NULLIF(hub_jwt_claims() ->> 'empresa_ativa', '')::int;
    v_existente    RECORD;
    v_ordenados    bigint[];
    v_conflitantes bigint[];
    v_qtd          int;
    v_total        numeric(14,2);
    v_lote_id      bigint;
    v_linha        int := 3;
    v_row          RECORD;
    v_config       "AdiantamentoConfiguracao";
    v_descricao    text;
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.lote_criar') THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;
    IF v_sub IS NULL THEN RAISE EXCEPTION 'NAO_AUTENTICADO'; END IF;
    IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RAISE EXCEPTION 'DADOS_INVALIDOS'; END IF;

    SELECT l.id, l.status, l.quantidade, l.valor_total INTO v_existente
    FROM "AdiantamentoLote" l WHERE l.criado_por = v_sub AND l.chave_idempotencia = p_chave;
    IF FOUND THEN
        RETURN QUERY SELECT v_existente.id, v_existente.status, v_existente.quantidade, v_existente.valor_total, true;
        RETURN;
    END IF;

    IF cardinality(p_ids) > 5000 THEN
        RAISE EXCEPTION 'LOTE_ACIMA_DO_LIMITE';
    END IF;

    SELECT array_agg(x ORDER BY x) INTO v_ordenados FROM unnest(p_ids) x;
    PERFORM 1 FROM "AdiantamentoSolicitacao" WHERE id = ANY (v_ordenados) ORDER BY id FOR UPDATE;

    SELECT array_agg(li.solicitacao_id) INTO v_conflitantes
    FROM "AdiantamentoLoteItem" li
    WHERE li.solicitacao_id = ANY (p_ids) AND li.situacao IN ('incluido', 'pago');
    IF v_conflitantes IS NOT NULL THEN
        RAISE EXCEPTION 'SOLICITACOES_EM_OUTRO_LOTE' USING DETAIL = array_to_json(v_conflitantes)::text;
    END IF;

    -- 11.5/11.6 (converge onda-039, FR-036): mesma exigência de conta ainda
    -- APROVADA da prévia — sem isso a contagem/soma aqui aceitava
    -- solicitação com conta SUBSTITUIDA/REJEITADA, e o item entrava no lote
    -- (e no arquivo Transfeera) com a conta velha.
    SELECT count(*), COALESCE(sum(s.valor_liquido), 0)
    INTO v_qtd, v_total
    FROM "AdiantamentoSolicitacao" s
    WHERE s.id = ANY (p_ids) AND s.id_empresa = ANY (hub_jwt_escopo_ids())
      AND s.status = 'LIBERADA' AND s.valor_liquido > 0 AND s.conta_bancaria_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM "ContaBancariaMotorista" cb WHERE cb.id = s.conta_bancaria_id AND cb.status = 'APROVADA');

    IF v_qtd IS DISTINCT FROM cardinality(p_ids)
       OR v_qtd IS DISTINCT FROM p_quantidade_esperada
       OR v_total IS DISTINCT FROM p_total_esperado::numeric(14,2) THEN
        RAISE EXCEPTION 'PREVIA_DESATUALIZADA';
    END IF;

    INSERT INTO "AdiantamentoLote" (id_empresa, status, criado_por, chave_idempotencia, quantidade, valor_total)
    VALUES (COALESCE(v_empresa, 6), 'GERANDO', v_sub, p_chave, v_qtd, v_total)
    RETURNING "AdiantamentoLote".id INTO v_lote_id;

    FOR v_row IN
        SELECT
            s.id                 AS solicitacao_id,
            s.id_empresa         AS solicitacao_id_empresa,
            s.data_producao      AS solicitacao_data_producao,
            s.configuracao_id    AS solicitacao_configuracao_id,
            s.valor_liquido      AS solicitacao_valor_liquido,
            cb.id                AS conta_id,
            cb.titular_nome      AS conta_titular_nome,
            cb.titular_documento AS conta_titular_documento,
            cb.banco_codigo      AS conta_banco_codigo,
            cb.agencia           AS conta_agencia,
            cb.conta             AS conta_numero,
            cb.conta_digito      AS conta_digito,
            cb.tipo_conta        AS conta_tipo_conta,
            cb.email_comprovante AS conta_email
        FROM "AdiantamentoSolicitacao" s
        JOIN "ContaBancariaMotorista" cb ON cb.id = s.conta_bancaria_id
        WHERE s.id = ANY (v_ordenados)
        ORDER BY s.id
    LOOP
        SELECT * INTO v_config FROM "AdiantamentoConfiguracao" WHERE id = v_row.solicitacao_configuracao_id;
        v_descricao := left(
            replace(
                replace(v_config.descricao_pix_modelo, '{data_producao:DD.MM.AA}', to_char(v_row.solicitacao_data_producao, 'DD.MM.YY')),
                '{nome}', v_row.conta_titular_nome
            ), 140
        );

        INSERT INTO "AdiantamentoLoteItem" (
            lote_id, solicitacao_id, id_empresa, linha, col_nome, col_documento, col_email,
            col_banco, col_agencia, col_conta, col_digito, col_tipo_conta, valor,
            col_id_integracao, col_descricao_pix, conta_bancaria_id, situacao
        ) VALUES (
            v_lote_id, v_row.solicitacao_id, v_row.solicitacao_id_empresa, v_linha,
            v_row.conta_titular_nome, hub_adiantamento_formatar_documento(v_row.conta_titular_documento),
            COALESCE(v_row.conta_email, ''), v_row.conta_banco_codigo, v_row.conta_agencia,
            v_row.conta_numero, v_row.conta_digito,
            CASE v_row.conta_tipo_conta WHEN 'CORRENTE' THEN 'Conta Corrente' ELSE 'Conta Poupança' END,
            v_row.solicitacao_valor_liquido, hub_adiantamento_integration_id(v_row.solicitacao_id), v_descricao,
            v_row.conta_id, 'incluido'
        );

        UPDATE "AdiantamentoSolicitacao" SET status = 'EM_LOTE' WHERE id = v_row.solicitacao_id;

        v_linha := v_linha + 1;
    END LOOP;

    RETURN QUERY SELECT v_lote_id, 'GERANDO'::text, v_qtd, v_total::numeric, false;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 11.11 — CAS de configuração compara contra a MAIOR versão, não a vigente
-- ─────────────────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────────────────
-- 11.22 — reversões notificam o motorista (reusa o evento 'liberada')
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION hub_adiantamento_lote_cancelar(p_lote_id bigint, p_motivo text, p_nao_enviado boolean DEFAULT false)
RETURNS TABLE (id bigint, status text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_lote "AdiantamentoLote";
    v_sub  int := NULLIF(hub_jwt_claims() ->> 'sub', '')::int;
    v_ids  bigint[];
    v_i    int;
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.reprocessar') THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;
    IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN RAISE EXCEPTION 'MOTIVO_OBRIGATORIO'; END IF;

    SELECT * INTO v_lote FROM "AdiantamentoLote" WHERE id = p_lote_id AND id_empresa = ANY (hub_jwt_escopo_ids()) FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NAO_ENCONTRADA'; END IF;

    IF v_lote.status IN ('GERANDO', 'GERADO') THEN
        NULL;
    ELSIF v_lote.status = 'EXPORTADO' THEN
        IF p_nao_enviado IS NOT TRUE THEN
            RAISE EXCEPTION 'CONFIRMACAO_NAO_ENVIADO_OBRIGATORIA';
        END IF;
    ELSE
        RAISE EXCEPTION 'TRANSICAO_INVALIDA';
    END IF;

    UPDATE "AdiantamentoLote"
    SET status = 'CANCELADO', cancelado_em = now(), cancelado_por = v_sub, cancelado_motivo = p_motivo,
        nao_enviado_declarado = p_nao_enviado
    WHERE id = p_lote_id;

    UPDATE "AdiantamentoLoteItem" SET situacao = 'cancelado' WHERE lote_id = p_lote_id AND situacao = 'incluido';

    SELECT array_agg(li.solicitacao_id) INTO v_ids FROM "AdiantamentoLoteItem" li
    WHERE li.lote_id = p_lote_id AND li.situacao = 'cancelado';
    UPDATE "AdiantamentoSolicitacao" SET status = 'LIBERADA' WHERE id = ANY (COALESCE(v_ids, ARRAY[]::bigint[])) AND status IN ('EM_LOTE', 'EXPORTADA');

    -- 11.22 (converge onda-039, FR-042): o motorista já foi avisado que o
    -- pagamento entrou em processamento (lote_exportado) — a reversão para
    -- LIBERADA é um evento do sistema tão relevante quanto a liberação
    -- original e não pode ficar silenciosa.
    IF v_ids IS NOT NULL THEN
        FOR v_i IN 1..array_length(v_ids, 1) LOOP
            PERFORM hub_adiantamento_notificar(v_ids[v_i], 'liberada');
        END LOOP;
    END IF;

    RETURN QUERY SELECT p_lote_id, 'CANCELADO'::text;
END;
$$;

CREATE OR REPLACE FUNCTION hub_adiantamento_reprocessar(p_id bigint, p_motivo text)
RETURNS TABLE (id bigint, status text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_sol "AdiantamentoSolicitacao";
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.reprocessar') THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;

    SELECT * INTO v_sol FROM "AdiantamentoSolicitacao" WHERE id = p_id AND id_empresa = ANY (hub_jwt_escopo_ids());
    IF NOT FOUND THEN RAISE EXCEPTION 'NAO_ENCONTRADA'; END IF;
    IF v_sol.status <> 'FALHOU' THEN RAISE EXCEPTION 'TRANSICAO_INVALIDA'; END IF;
    IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN RAISE EXCEPTION 'MOTIVO_OBRIGATORIO'; END IF;

    UPDATE "AdiantamentoSolicitacao" SET status = 'LIBERADA', motivo_status = NULL WHERE id = p_id;

    -- 11.22 (converge onda-039, FR-042): idem lote_cancelar — reprocessar
    -- também devolve a LIBERADA sem avisar o motorista.
    PERFORM hub_adiantamento_notificar(p_id, 'liberada');

    RETURN QUERY SELECT p_id, 'LIBERADA'::text;
END;
$$;
