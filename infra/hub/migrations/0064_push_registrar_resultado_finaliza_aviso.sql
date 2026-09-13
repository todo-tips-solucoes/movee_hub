-- 0064 — hub_push_registrar_resultado passa a finalizar o Aviso (achado
-- E2E de browser, tasks.md 9.4.1/execute-task onda-023).
--
-- Bug: `hub_push_reivindicar` (0061) só marca `Aviso.status='concluido'`
-- dentro de si mesma, ao INÍCIO de uma nova reivindicação, checando se não
-- sobrou nenhuma "AvisoEntrega" pendente/processando da rodada ANTERIOR
-- (step 5 do comentário original). Isso nunca dispara quando o total de
-- entregas de um aviso é MENOR que LOTE_LIMITE=50 (o caso comum — qualquer
-- aviso individual/empresa, ou toda_base de uma base pequena): o worker
-- (lib/hub-push-worker.js#processarAvisoInterno) reivindica UMA vez, resolve
-- o lote inteiro via `hub_push_registrar_resultado`, vê
-- `linhas.length < LOTE_LIMITE` e RETORNA sem nunca chamar
-- `hub_push_reivindicar` de novo — a checagem de finalização, que só existe
-- dentro de `hub_push_reivindicar`, nunca roda. `Aviso.status` fica
-- 'em_andamento' PARA SEMPRE mesmo com todas as entregas já resolvidas
-- (reproduzido ao vivo: 1 entrega 'aceito', Aviso preso em 'em_andamento').
--
-- Passou despercebido em toda a suíte de testes existente porque:
--   - unit tests de hub-push-worker mockam hubPostgrestRequest por completo
--     (nunca exercitam a função SQL);
--   - hub-avisos-integration.sh (tasks.md 9.2) verifica status/motivo de
--     CADA AvisoEntrega e a exclusão da PushInscricao morta, mas nunca
--     afirma `Aviso.status='concluido'` — o campo que a UI do hub
--     (app/hub/dashboard/avisos/[id]/page.tsx, tasks.md 7.4) usa para
--     PARAR o polling.
--
-- Fix (mínimo, na função que resolve efetivamente a ÚLTIMA entrega): mover a
-- MESMA checagem de finalização (idêntica ao step 5 de hub_push_reivindicar,
-- linha por linha) para DENTRO de hub_push_registrar_resultado, rodando
-- sempre que uma entrega for de fato atualizada (`v_aplicado=true`). A
-- checagem de hub_push_reivindicar permanece intacta (defesa em
-- profundidade para o caso de múltiplos lotes) — não removida, só deixa de
-- ser o ÚNICO lugar que finaliza.
--
-- EXPAND-ONLY / IDEMPOTENTE: CREATE OR REPLACE FUNCTION (rodar 2x é no-op).
-- Não edita 0061 (regra da série: nunca editar migration já aplicada).
CREATE OR REPLACE FUNCTION hub_push_registrar_resultado(
    p_entrega_id  bigint,
    p_lease_token uuid,
    p_status      text,
    p_motivo      text,
    p_tentativas  smallint
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_aplicado     boolean := false;
    v_inscricao_id int;
    v_aviso_id     int;
BEGIN
    IF NOT hub_jwt_push_worker() THEN
        RAISE EXCEPTION 'CLAIM_HUB_PUSH_WORKER_AUSENTE';
    END IF;

    UPDATE "AvisoEntrega"
    SET status = p_status, motivo = p_motivo, tentativas = p_tentativas, atualizado_em = now()
    WHERE id = p_entrega_id AND status = 'processando' AND lease_token = p_lease_token
    RETURNING inscricao_id, aviso_id INTO v_inscricao_id, v_aviso_id;

    IF FOUND THEN
        v_aplicado := true;
        IF p_status = 'morta' AND v_inscricao_id IS NOT NULL THEN
            DELETE FROM "PushInscricao" WHERE id = v_inscricao_id;
        END IF;

        -- Mesma checagem de hub_push_reivindicar (0061, step 5) — roda AQUI
        -- também porque esta função é quem resolve a ÚLTIMA entrega quando o
        -- aviso inteiro coube num único lote (< LOTE_LIMITE), caso em que
        -- `hub_push_reivindicar` nunca é chamada de novo.
        UPDATE "Aviso"
        SET status = 'concluido', concluido_em = now()
        WHERE id = v_aviso_id AND status = 'em_andamento'
          AND NOT EXISTS (
                SELECT 1 FROM "AvisoEntrega"
                WHERE aviso_id = v_aviso_id AND status IN ('pendente', 'processando')
              );
    END IF;

    RETURN v_aplicado;
END;
$$;
