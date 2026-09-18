-- 0080 — FASE 13 (converge, 13.3/FR-052): `hub_adiantamento_lote_download`
-- levantava o MESMO 'ARQUIVO_INDISPONIVEL' tanto para status inválido
-- (GERANDO/CANCELADO) quanto para arquivo expurgado pela retenção de 90
-- dias (`arquivo = NULL`, `arquivo_expurgado_em` carimbado por
-- 0067:2175-2177). O Node (routes/hub-adiantamentos.js) só sabia mapear
-- essa mensagem para 409, deixando o 410 documentado em
-- `contracts/hub-api.md:130` ("410 se bytes expurgados") inalcançável.
--
-- Mesmo padrão já usado em routes/hub-importacoes.js para
-- `arquivo_expurgado_em` (D3b/CHK021): checar a coluna ANTES do status e
-- levantar um código de erro distinto, para o Node responder 410 com
-- `motivo: 'expurgado_por_retencao'` em vez de 409 genérico.
--
-- Assinatura/retorno inalterados (mesma RETURNS TABLE de 0073) — GRANT/
-- REVOKE de 0067 permanecem válidos, sem necessidade de reafirmá-los aqui.

CREATE OR REPLACE FUNCTION hub_adiantamento_lote_download(p_lote_id bigint)
RETURNS TABLE (arquivo_base64 text, sha256 text, nome text, downloads int)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_lote  "AdiantamentoLote";
    v_ids   bigint[];
    v_solid bigint;
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.exportar') THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;

    SELECT * INTO v_lote FROM "AdiantamentoLote" WHERE id = p_lote_id AND id_empresa = ANY (hub_jwt_escopo_ids()) FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NAO_ENCONTRADA'; END IF;

    -- 13.3: expurgo por retenção é um caso distinto de "indisponível por
    -- status" — checar ANTES do status/arquivo genérico para poder
    -- devolver 410 (não 409) e o carimbo de quando expurgou.
    IF v_lote.arquivo_expurgado_em IS NOT NULL THEN
        RAISE EXCEPTION 'ARQUIVO_EXPURGADO' USING DETAIL = to_jsonb(v_lote.arquivo_expurgado_em)::text;
    END IF;

    IF v_lote.status NOT IN ('GERADO', 'EXPORTADO', 'CONCLUIDO', 'CONCLUIDO_COM_FALHAS') OR v_lote.arquivo IS NULL THEN
        RAISE EXCEPTION 'ARQUIVO_INDISPONIVEL';
    END IF;

    IF v_lote.status = 'GERADO' THEN
        UPDATE "AdiantamentoLote" SET status = 'EXPORTADO', primeiro_download_em = now(), downloads = downloads + 1
        WHERE id = p_lote_id;

        SELECT array_agg(li.solicitacao_id) INTO v_ids FROM "AdiantamentoLoteItem" li WHERE li.lote_id = p_lote_id;
        UPDATE "AdiantamentoSolicitacao" SET status = 'EXPORTADA' WHERE id = ANY (v_ids);
        FOREACH v_solid IN ARRAY COALESCE(v_ids, ARRAY[]::bigint[]) LOOP
            PERFORM hub_adiantamento_notificar(v_solid, 'lote_exportado');
        END LOOP;
    ELSE
        UPDATE "AdiantamentoLote" SET downloads = downloads + 1 WHERE id = p_lote_id;
    END IF;

    RETURN QUERY SELECT encode(v_lote.arquivo, 'base64'), v_lote.arquivo_sha256::text, v_lote.arquivo_nome, (v_lote.downloads + 1);
END;
$$;
