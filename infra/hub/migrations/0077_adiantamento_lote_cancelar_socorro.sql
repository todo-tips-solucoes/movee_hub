-- 0077 — hub_adiantamento_lote_cancelar aceita o AUTO-CANCELAMENTO de socorro
-- (feature "Adiantamento pelo App, Dados Bancários e Exportação Transfeera",
-- FASE 11 / converge-report.md, tasks.md 11.18, FR-029). Não edita
-- 0066/.../0076 (já aplicadas no hub-homolog persistente) — expand-only.
--
-- Bug: `POST /lotes` (routes/hub-adiantamentos.js), ao falhar em montar o
-- xlsx, tenta se socorrer chamando `hub_adiantamento_lote_cancelar` com a
-- MESMA sessão de quem criou o lote (permissão `adiantamentos.lote_criar`).
-- A função sempre exigiu `adiantamentos.reprocessar` — uma permissão
-- DIFERENTE e deliberadamente separada (contracts/hub-api.md) — então, para
-- qualquer ator que só tenha `lote_criar` (separação de funções legítima:
-- quem cria lote não necessariamente reprocessa falha), essa chamada de
-- socorro SEMPRE falhava com PERMISSAO_NEGADA. O catch só logava (`console.
-- error`) e devolvia 500 — lote preso em GERANDO e solicitações presas em
-- EM_LOTE até o próximo tick de `hub_adiantamento_lote_orfaos` (60s + até
-- 5min, lib/adiantamento-worker.js — a varredura de órfãos JÁ existe e JÁ
-- roda a cada tick; só não cobria este caso imediatamente).
--
-- Fix: quem tem `adiantamentos.lote_criar` pode cancelar o PRÓPRIO lote
-- (criado_por = ele) enquanto ainda está `GERANDO` — exatamente o socorro
-- que `POST /lotes` tenta fazer, sem abrir a permissão de cancelar/
-- reprocessar lotes de outros ou lotes já GERADO/EXPORTADO (essas
-- continuam exigindo `adiantamentos.reprocessar`, como sempre). A checagem
-- de permissão precisa do lote (status/criado_por) já carregado — o
-- lookup de `NAO_ENCONTRADA` move para antes da checagem de permissão
-- (mesmo padrão de isolamento por escopo de outras RPCs desta feature, que
-- já conflam "não existe" com "fora do seu escopo" na mesma mensagem).
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
    SELECT * INTO v_lote FROM "AdiantamentoLote" WHERE id = p_lote_id AND id_empresa = ANY (hub_jwt_escopo_ids()) FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NAO_ENCONTRADA'; END IF;

    -- 11.18/FR-029: além de quem tem `reprocessar`, o próprio criador pode
    -- cancelar o lote que ELE criou enquanto ainda está GERANDO (socorro de
    -- `POST /lotes` quando a montagem/validação do xlsx falha) — nunca
    -- lotes de terceiros nem lotes já GERADO/EXPORTADO por essa via.
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.reprocessar')
       AND NOT (
            v_lote.status = 'GERANDO' AND v_lote.criado_por = v_sub
            AND hub_adiantamento_tem_permissao('adiantamentos.lote_criar')
       )
    THEN
        RAISE EXCEPTION 'PERMISSAO_NEGADA';
    END IF;

    IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN RAISE EXCEPTION 'MOTIVO_OBRIGATORIO'; END IF;

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
