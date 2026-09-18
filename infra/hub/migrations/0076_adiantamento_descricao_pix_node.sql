-- 0076 — Move a renderização da descrição Pix da SQL para o Node (feature
-- "Adiantamento pelo App, Dados Bancários e Exportação Transfeera", FASE 11 /
-- converge-report.md, tasks.md 11.16, FR-055-descricao-pix). Não edita
-- 0066/.../0075 (já aplicadas no hub-homolog persistente) — expand-only.
--
-- Bug: `hub_adiantamento_lote_criar` interpolava `descricao_pix_modelo` com
-- dois `replace()` cegos — sem validar contra os placeholders permitidos
-- (`lib/adiantamento-transfeera-xlsx.js:29`, `PLACEHOLDERS_PERMITIDOS`) e sem
-- reconhecer o placeholder bare `{data_producao}` (só tratava
-- `{data_producao:DD.MM.AA}`, deixando-o literal no arquivo). Um `{...}`
-- desconhecido no modelo saía literal no arquivo enviado à Transfeera.
--
-- Fix: `hub_adiantamento_lote_criar` para de interpolar — grava o MODELO
-- BRUTO (ainda com os placeholders) em `col_descricao_pix`, truncado em 140
-- só por segurança do CHECK da coluna (ponytail: template > 140 chars antes
-- da substituição pode truncar um placeholder ao meio; risco pré-existente,
-- o `left()` de hoje já truncava o texto FINAL pelo mesmo motivo). O Node
-- (`routes/hub-adiantamentos.js`, `POST /lotes`) lê esse modelo bruto + o
-- `col_nome` do item + a `data_producao` da solicitação (embed PostgREST) e
-- chama `renderizarDescricaoPix` — que RECUSA (lança) qualquer placeholder
-- fora de `PLACEHOLDERS_PERMITIDOS`, cancelando o lote pelo caminho de erro
-- já existente (`FALHA_GERACAO_ARQUIVO`). `hub_adiantamento_lote_arquivo`
-- ganha o parâmetro `p_itens` para persistir a descrição já validada de
-- volta em `AdiantamentoLoteItem` (única rota de escrita nessa tabela —
-- RLS só concede SELECT a `authenticated`, GRANT em 0066:390) na MESMA
-- transação que anexa o arquivo — sem precisar de um novo grant de UPDATE.

-- ─────────────────────────────────────────────────────────────────────────
-- hub_adiantamento_lote_criar — para de renderizar; grava o modelo bruto.
-- Assinatura/retorno inalterados: CREATE OR REPLACE basta.
-- ─────────────────────────────────────────────────────────────────────────
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
        -- 11.16 (FR-055-descricao-pix): não interpola mais aqui — grava o
        -- modelo bruto (com os placeholders intactos). Quem renderiza e
        -- valida é o Node (`renderizarDescricaoPix`), logo depois, via
        -- `hub_adiantamento_lote_arquivo`.
        v_descricao := left(v_config.descricao_pix_modelo, 140);

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
-- hub_adiantamento_lote_arquivo — ganha `p_itens` para persistir a
-- descrição Pix já renderizada/validada pelo Node. Novo parâmetro muda a
-- assinatura: CREATE OR REPLACE não substitui (viraria overload) — precisa
-- DROP + CREATE, com os GRANTs restaurados (mesmo padrão de 0074/0075 para
-- funções que mudaram RETURNS TABLE/assinatura).
-- ─────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS hub_adiantamento_lote_arquivo(bigint, text, char, int, text);

CREATE FUNCTION hub_adiantamento_lote_arquivo(
    p_lote_id bigint, p_arquivo text, p_sha256 char(64), p_bytes int, p_nome text,
    p_itens jsonb DEFAULT '[]'::jsonb
)
RETURNS TABLE (id bigint, status text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_lote     "AdiantamentoLote";
    v_bytes    bytea;
    v_sha_calc text;
    v_item     jsonb;
BEGIN
    SELECT * INTO v_lote FROM "AdiantamentoLote" WHERE id = p_lote_id AND id_empresa = ANY (hub_jwt_escopo_ids()) FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NAO_ENCONTRADA'; END IF;
    IF v_lote.status <> 'GERANDO' THEN RAISE EXCEPTION 'TRANSICAO_INVALIDA'; END IF;

    v_bytes := decode(p_arquivo, 'base64');
    v_sha_calc := encode(sha256(v_bytes), 'hex');
    IF v_sha_calc <> lower(p_sha256) THEN
        RAISE EXCEPTION 'SHA256_DIVERGENTE';
    END IF;

    -- 11.16: descrições Pix já renderizadas/validadas pelo Node
    -- (renderizarDescricaoPix) — escopadas ao próprio lote (defesa em
    -- profundidade contra id de item de outro lote).
    IF p_itens IS NOT NULL AND jsonb_typeof(p_itens) = 'array' THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
        LOOP
            UPDATE "AdiantamentoLoteItem"
            SET col_descricao_pix = left(v_item ->> 'descricao', 140)
            WHERE id = (v_item ->> 'id')::bigint AND lote_id = p_lote_id;
        END LOOP;
    END IF;

    UPDATE "AdiantamentoLote"
    SET status = 'GERADO', arquivo = v_bytes, arquivo_sha256 = v_sha_calc,
        arquivo_bytes = p_bytes, arquivo_nome = p_nome, gerado_em = now()
    WHERE id = p_lote_id;

    RETURN QUERY SELECT p_lote_id, 'GERADO'::text;
END;
$$;

REVOKE ALL ON FUNCTION hub_adiantamento_lote_arquivo(bigint, text, char, int, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_lote_arquivo(bigint, text, char, int, text, jsonb) TO authenticated;
