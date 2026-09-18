-- 0073 — corrige `hub_adiantamento_lote_download`: `RETURN QUERY` devolvia
-- `"AdiantamentoLote".arquivo_sha256` (coluna `char(64)`, 0066:249) sem cast
-- para a coluna `sha256 text` declarada em `RETURNS TABLE` (0067) —
-- Postgres exige tipo EXATO em `RETURN QUERY`, `char(64)` não casa
-- implicitamente com `text` nesse contexto (diferente de comparação/
-- concatenação, onde o cast implícito existe).
--
-- Bug PRÉ-EXISTENTE desde a introdução da função em 0067, nunca exercitado
-- contra Postgres real: `tests/hub-adiantamentos-rotas-unit.test.js` mocka
-- `hubPostgrestRequest` (nunca chama a RPC de verdade) e
-- `infra/hub/testes/hub-adiantamentos-integration.sh` (driver psql desta
-- feature) nunca tinha uma chamada a `hub_adiantamento_lote_download` antes
-- da onda que descobriu isto (tasks.md FASE 9, 9.1.7 — o cenário de retorno
-- precisa levar um lote a `EXPORTADO`, que só acontece por aqui). Erro real
-- reproduzido nesta onda contra o stack `hub-test-<epoch>`:
--   ERROR:  structure of query does not match function result type
--   DETAIL:  Returned type character(64) does not match expected type text
--            in column 2.
--   CONTEXT: PL/pgSQL function hub_adiantamento_lote_download(bigint) line 32
-- Efeito em produção (se aplicado sem esta correção): TODA chamada a
-- `GET /lotes/:id/arquivo` (routes/hub-adiantamentos.js, tasks.md 4.4.10)
-- falharia com 500 — a rota de download do arquivo de pagamento nunca
-- funcionaria de verdade.
--
-- Correção: `::text` explícito na coluna devolvida. Mesma assinatura
-- (nomes/tipos de parâmetro e de retorno inalterados) — GRANT/REVOKE de
-- 0067 permanecem válidos, sem necessidade de reafirmá-los aqui.

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
    IF v_lote.status NOT IN ('GERADO', 'EXPORTADO', 'CONCLUIDO', 'CONCLUIDO_COM_FALHAS') OR v_lote.arquivo IS NULL THEN
        RAISE EXCEPTION 'ARQUIVO_INDISPONIVEL';
    END IF;

    IF v_lote.status = 'GERADO' THEN
        UPDATE "AdiantamentoLote" SET status = 'EXPORTADO', primeiro_download_em = now(), downloads = downloads + 1
        WHERE id = p_lote_id;

        SELECT array_agg(li.solicitacao_id) INTO v_ids FROM "AdiantamentoLoteItem" li WHERE li.lote_id = p_lote_id;
        UPDATE "AdiantamentoSolicitacao" SET status = 'EXPORTADA' WHERE id = ANY (v_ids);
        -- 5.2 (FASE 5): notifica CADA solicitação exportada — "lote_exportado"
        -- é um evento por-solicitação, não um NULL/fan-out inventado dentro
        -- de hub_adiantamento_notificar (assinatura permanece (id, evento)).
        FOREACH v_solid IN ARRAY COALESCE(v_ids, ARRAY[]::bigint[]) LOOP
            PERFORM hub_adiantamento_notificar(v_solid, 'lote_exportado');
        END LOOP;
    ELSE
        UPDATE "AdiantamentoLote" SET downloads = downloads + 1 WHERE id = p_lote_id;
    END IF;

    RETURN QUERY SELECT encode(v_lote.arquivo, 'base64'), v_lote.arquivo_sha256::text, v_lote.arquivo_nome, (v_lote.downloads + 1);
END;
$$;
