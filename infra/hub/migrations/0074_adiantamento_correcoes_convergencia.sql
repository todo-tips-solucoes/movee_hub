-- 0074 — Correções de convergência (feature "Adiantamento pelo App, Dados
-- Bancários e Exportação Transfeera", FASE 11 / onda-037-038, converge-report.md).
-- Não edita 0066/0067/0068/0069/0070/0071/0072/0073 (já aplicadas no
-- hub-homolog persistente) — cria a próxima migration, expand-only.
--
-- Causa-raiz transversal (cabeçalho tasks.md FASE 11): a máscara de PII
-- estava aplicada na camada de PERSISTÊNCIA (`hub_adiantamento_lote_criar`),
-- não na de APRESENTAÇÃO. Isso produzia dois defeitos opostos com a mesma
-- origem: o arquivo de pagamento levava documento REDIGIDO (`*********09`,
-- inutilizável pela Transfeera — contrato exige máscara de FORMATAÇÃO) e o
-- nome do banco onde o contrato exige o código de 3 dígitos; ao mesmo tempo
-- a listagem de itens de lote (`routes/hub-adiantamentos.js`) vazava número
-- de conta CRU sob o campo `contaMascarada` (a conta é gravada sem máscara
-- na tabela — correto para o pagamento — mas a rota nunca mascarava ao
-- exibir). Esta migration move a formatação/máscara para o lugar certo:
--
--   (a) 11.14 — `col_documento` passa a levar o documento FORMATADO
--       (`999.999.999-99` / `99.999.999/9999-99`, contracts/transfeera-
--       xlsx.md coluna B), nunca redigido. Nova função
--       `hub_adiantamento_formatar_documento`.
--   (b) 11.15 — `col_banco` passa a levar `banco_codigo` (3 dígitos,
--       contracts/transfeera-xlsx.md coluna D) em vez de `banco_nome`.
--   (c) 11.7 (metade SQL) — sem mudança de mascaramento aqui: `col_conta`/
--       `col_digito` PRECISAM continuar crus (são o dado real que a
--       Transfeera usa para pagar); a máscara na LISTAGEM é responsabilidade
--       da apresentação e foi corrigida em `routes/hub-adiantamentos.js`
--       (ver commit desta onda) — não há nada a mudar em
--       `hub_adiantamento_lote_criar` quanto a `col_conta`/`col_digito`.
--
-- 11.10 — trilha de auditoria do motorista (FR-047): a policy de INSERT em
-- "Auditoria" (0069) já libera `adiantamento.solicitado`,
-- `adiantamento.cancelado`, `conta_bancaria.solicitada` para
-- `id_empresa = hub_jwt_motorista_id_empresa()`, mas o Node
-- (`routes/motorista-adiantamento.js`) nunca tinha como saber esse
-- `id_empresa` — nenhuma das 3 RPCs o devolvia. Adiciona `id_empresa` ao
-- `RETURNS TABLE` de `hub_adiantamento_solicitar`, `hub_adiantamento_cancelar`
-- e `hub_conta_bancaria_solicitar` (mudança de tipo de retorno: exige
-- DROP + CREATE, não CREATE OR REPLACE). Nenhum outro chamador depende
-- dessas 3 RPCs (grep confirmado: só `routes/motorista-adiantamento.js`).

-- (a)+(b) hub_adiantamento_formatar_documento — formatação (não redação) de
-- CPF (11 dígitos) / CNPJ (14 dígitos); qualquer outro tamanho passa como
-- veio (defesa: nunca lança, o dado já foi validado na entrada por
-- lib/adiantamento-conta.js).
CREATE OR REPLACE FUNCTION hub_adiantamento_formatar_documento(p_documento text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
    SELECT CASE
        WHEN p_documento IS NULL THEN NULL
        WHEN char_length(p_documento) = 11 THEN
            substring(p_documento FROM 1 FOR 3) || '.' || substring(p_documento FROM 4 FOR 3) || '.' ||
            substring(p_documento FROM 7 FOR 3) || '-' || substring(p_documento FROM 10 FOR 2)
        WHEN char_length(p_documento) = 14 THEN
            substring(p_documento FROM 1 FOR 2) || '.' || substring(p_documento FROM 3 FOR 3) || '.' ||
            substring(p_documento FROM 6 FOR 3) || '/' || substring(p_documento FROM 9 FOR 4) || '-' ||
            substring(p_documento FROM 13 FOR 2)
        ELSE p_documento
    END;
$$;

-- hub_adiantamento_lote_criar — mesmo corpo de 0067, só troca as duas
-- colunas do arquivo de pagamento (col_documento/col_banco). RETURNS TABLE
-- inalterado -> CREATE OR REPLACE é suficiente.
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

    SELECT count(*), COALESCE(sum(s.valor_liquido), 0)
    INTO v_qtd, v_total
    FROM "AdiantamentoSolicitacao" s
    WHERE s.id = ANY (p_ids) AND s.id_empresa = ANY (hub_jwt_escopo_ids())
      AND s.status = 'LIBERADA' AND s.valor_liquido > 0 AND s.conta_bancaria_id IS NOT NULL;

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

-- 11.10 — hub_adiantamento_solicitar/cancelar/hub_conta_bancaria_solicitar
-- passam a devolver `id_empresa`, para o Node conseguir gravar a Auditoria
-- (mesmo id_empresa que a policy 0069 exige via hub_jwt_motorista_id_empresa()).
-- Mudança de tipo de retorno -> DROP + CREATE (CREATE OR REPLACE recusa).
DROP FUNCTION IF EXISTS hub_adiantamento_solicitar(bigint, text, uuid);
CREATE FUNCTION hub_adiantamento_solicitar(
    p_configuracao_id bigint,
    p_aceite_sha256   text,
    p_chave           uuid
)
RETURNS TABLE (id bigint, status text, reutilizado boolean, id_empresa int)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_cnpj               text := hub_jwt_motorista_cnpj();
    v_conta_motorista_id int;
    v_entregador         RECORD;
    v_vigente            "AdiantamentoConfiguracao";
    v_janela             RECORD;
    v_existente           RECORD;
    v_novo_id            bigint;
BEGIN
    IF v_cnpj IS NULL THEN
        RAISE EXCEPTION 'NAO_AUTENTICADO';
    END IF;

    SELECT cm.id INTO v_conta_motorista_id FROM "ContaMotorista" cm WHERE cm.cnpj_prestador = v_cnpj AND cm.ativo;
    IF v_conta_motorista_id IS NULL THEN
        RAISE EXCEPTION 'NOT_LINKED';
    END IF;

    SELECT s.id, s.status, s.id_empresa INTO v_existente
    FROM "AdiantamentoSolicitacao" s
    WHERE s.conta_motorista_id = v_conta_motorista_id AND s.chave_idempotencia = p_chave;
    IF FOUND THEN
        RETURN QUERY SELECT v_existente.id, v_existente.status, true, v_existente.id_empresa;
        RETURN;
    END IF;

    SELECT e.* INTO v_entregador FROM "Entregador" e WHERE e.motorista_id = v_conta_motorista_id AND e.ativo LIMIT 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'NOT_LINKED';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM "ModuloEntidade" me JOIN "Modulo" m ON m.id = me.modulo_id
        WHERE me.empresa_id = v_entregador.id_empresa AND m.codigo = 'adiantamentos' AND me.ativo AND m.ativo
    ) THEN
        RAISE EXCEPTION 'MODULO_DESABILITADO';
    END IF;

    SELECT * INTO v_vigente FROM hub_adiantamento_config_vigente(v_entregador.id_empresa);
    IF v_vigente.id IS NULL OR v_vigente.id IS DISTINCT FROM p_configuracao_id THEN
        RAISE EXCEPTION 'VERSAO_DESATUALIZADA';
    END IF;

    -- FR-025/dec-053: bloqueia novas solicitações enquanto a config vigente
    -- não estiver completa (fonte/categorias da produção + apuração
    -- semanal, Q-B2/Q-B3) — antes só _disponibilidade calculava isso
    -- (informativo); _solicitar não impedia a criação.
    IF NOT hub_adiantamento_config_completa(v_vigente) THEN
        RAISE EXCEPTION 'NOT_CONFIGURED';
    END IF;

    SELECT * INTO v_janela FROM hub_adiantamento_janela(v_vigente, now());
    IF NOT v_janela.dia_habilitado THEN
        RAISE EXCEPTION 'DAY_NOT_ALLOWED';
    ELSIF v_janela.antes_abertura THEN
        RAISE EXCEPTION 'BEFORE_OPENING';
    ELSIF v_janela.apos_corte THEN
        RAISE EXCEPTION 'AFTER_CUTOFF';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM "ContaBancariaMotorista" WHERE entregador_id = v_entregador.id AND status = 'APROVADA') THEN
        IF EXISTS (SELECT 1 FROM "ContaBancariaMotorista" WHERE entregador_id = v_entregador.id AND status = 'PENDENTE') THEN
            RAISE EXCEPTION 'BANK_ACCOUNT_PENDING';
        ELSE
            RAISE EXCEPTION 'NO_BANK_ACCOUNT';
        END IF;
    END IF;

    IF p_aceite_sha256 IS NULL OR char_length(p_aceite_sha256) <> 64 THEN
        RAISE EXCEPTION 'ACEITE_INVALIDO';
    END IF;

    BEGIN
        INSERT INTO "AdiantamentoSolicitacao" (
            id_empresa, conta_motorista_id, cnpj_prestador, entregador_id, configuracao_id,
            data_solicitacao, data_producao, aceite_texto_sha256, status, chave_idempotencia
        ) VALUES (
            v_entregador.id_empresa, v_conta_motorista_id, v_cnpj, v_entregador.id, v_vigente.id,
            v_janela.data_solicitacao, v_janela.data_producao, p_aceite_sha256, 'AGUARDANDO_CORTE', p_chave
        ) RETURNING "AdiantamentoSolicitacao".id INTO v_novo_id;
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'ALREADY_REQUESTED';
    END;

    INSERT INTO "AdiantamentoEvento" (solicitacao_id, id_empresa, status_de, status_para, ator_tipo)
    VALUES (v_novo_id, v_entregador.id_empresa, NULL, 'AGUARDANDO_CORTE', 'motorista');

    PERFORM hub_adiantamento_notificar(v_novo_id, 'criada');

    RETURN QUERY SELECT v_novo_id, 'AGUARDANDO_CORTE'::text, false, v_entregador.id_empresa;
END;
$$;

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
    v_janela RECORD;
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
    SELECT * INTO v_janela FROM hub_adiantamento_janela(v_config, now());
    IF v_janela.apos_corte THEN
        RAISE EXCEPTION 'AFTER_CUTOFF';
    END IF;

    UPDATE "AdiantamentoSolicitacao" SET status = 'CANCELADA' WHERE id = p_id;

    RETURN QUERY SELECT p_id, 'CANCELADA'::text, v_sol.id_empresa;
END;
$$;

DROP FUNCTION IF EXISTS hub_conta_bancaria_solicitar(jsonb);
CREATE FUNCTION hub_conta_bancaria_solicitar(p_dados jsonb)
RETURNS TABLE (id bigint, status text, id_empresa int)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_cnpj        text := hub_jwt_motorista_cnpj();
    v_entregador  RECORD;
    v_alertas     jsonb := '[]'::jsonb;
    v_novo_id     bigint;
    v_titular_tipo text;
BEGIN
    IF v_cnpj IS NULL THEN
        RAISE EXCEPTION 'NAO_AUTENTICADO';
    END IF;

    SELECT e.*, cm.nome AS conta_nome INTO v_entregador
    FROM "Entregador" e JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
    WHERE cm.cnpj_prestador = v_cnpj AND cm.ativo AND e.ativo;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'NOT_LINKED';
    END IF;

    v_titular_tipo := CASE WHEN char_length(p_dados ->> 'titularDocumento') = 14 THEN 'PJ' ELSE 'PF' END;

    IF hub_normaliza_nome(p_dados ->> 'titularNome') <> hub_normaliza_nome(v_entregador.conta_nome) THEN
        v_alertas := v_alertas || jsonb_build_array('TITULAR_DIFERENTE');
    END IF;

    UPDATE "ContaBancariaMotorista" SET status = 'CANCELADA'
    WHERE entregador_id = v_entregador.id AND status = 'PENDENTE';

    INSERT INTO "ContaBancariaMotorista" (
        id_empresa, entregador_id, origem, status, titular_nome, titular_documento, titular_tipo,
        banco_codigo, banco_nome, agencia, conta, conta_digito, tipo_conta,
        chave_pix_tipo, chave_pix, email_comprovante, alertas
    ) VALUES (
        v_entregador.id_empresa, v_entregador.id, 'APP', 'PENDENTE',
        btrim(p_dados ->> 'titularNome'), p_dados ->> 'titularDocumento', v_titular_tipo,
        p_dados ->> 'bancoCodigo', p_dados ->> 'bancoNome', p_dados ->> 'agencia',
        p_dados ->> 'conta', p_dados ->> 'contaDigito', p_dados ->> 'tipoConta',
        NULLIF(p_dados ->> 'chavePixTipo', ''), NULLIF(p_dados ->> 'chavePix', ''),
        NULLIF(p_dados ->> 'emailComprovante', ''), v_alertas
    ) RETURNING "ContaBancariaMotorista".id INTO v_novo_id;

    RETURN QUERY SELECT v_novo_id, 'PENDENTE'::text, v_entregador.id_empresa;
END;
$$;

-- DROP FUNCTION apaga os GRANTs junto com a função antiga, e o Postgres
-- concede EXECUTE a PUBLIC por padrão em toda CREATE FUNCTION nova — sem
-- este bloco as 3 funções recriadas acima ficariam mais permissivas do que
-- estavam em 0067 (fail-closed, mesmo padrão do rodapé de 0067).
REVOKE ALL ON FUNCTION hub_adiantamento_solicitar(bigint, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_solicitar(bigint, text, uuid) TO authenticated;

REVOKE ALL ON FUNCTION hub_adiantamento_cancelar(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_cancelar(bigint) TO authenticated;

REVOKE ALL ON FUNCTION hub_conta_bancaria_solicitar(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_conta_bancaria_solicitar(jsonb) TO authenticated;
