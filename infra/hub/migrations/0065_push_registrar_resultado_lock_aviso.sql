-- 0065 — hub_push_registrar_resultado passa a travar a linha do Aviso antes
-- de checar finalização (corrida entre 2 últimas entregas, execute-task
-- onda-024, hipótese do operador).
--
-- Bug: a checagem de finalização adicionada em 0064 (`UPDATE "Aviso" ...
-- WHERE ... AND NOT EXISTS (... status IN ('pendente','processando'))`) lê
-- "AvisoEntrega" sem travar a linha do "Aviso" correspondente. Em READ
-- COMMITTED, se as DUAS ÚLTIMAS entregas de um aviso forem resolvidas por
-- transações sobrepostas (`executarComPool` do worker roda com
-- CONCORRENCIA=10 — lib/hub-push-worker.js), cada transação enxerga a OUTRA
-- entrega ainda como 'processando' (valor committed anterior — leitura sem
-- FOR UPDATE não bloqueia e não vê o uncommitted da outra), então a condição
-- NOT EXISTS falha nas DUAS chamadas e nenhuma marca o Aviso como
-- 'concluido'. Com lote único (< LOTE_LIMITE) `hub_push_reivindicar` nunca
-- roda de novo para finalizar (mesmo cenário de 0064) — o Aviso fica preso
-- em 'em_andamento' para sempre mesmo com 100% das entregas resolvidas.
--
-- Reproduzido ao vivo (hub-test efêmero, transação A mantida aberta via
-- FIFO enquanto a transação B roda e comita, depois A comita): as 2
-- AvisoEntrega ficam 'aceito' (0 pendente/processando) e o Aviso permanece
-- 'em_andamento' — ver hub-avisos-integration.sh, bloco "(g) corrida na
-- finalização".
--
-- Fix (mínimo): `PERFORM ... FOR UPDATE` na linha do Aviso ANTES da
-- checagem NOT EXISTS, serializando as chamadas concorrentes para o MESMO
-- aviso_id — a segunda chamada só prossegue depois que a primeira
-- confirma/desfaz, e nesse ponto já enxerga a entrega da primeira como
-- resolvida (committed), então o NOT EXISTS corretamente encontra zero
-- pendente/processando e finaliza.
--
-- Ordem de travas vs. `hub_push_reivindicar` (0061, SKIP LOCKED) — sem
-- deadlock: `hub_push_reivindicar` só trava a linha do Aviso no seu ÚLTIMO
-- passo (step 5, condicional a `status='em_andamento'`), depois de já ter
-- travado/atualizado as linhas de "AvisoEntrega" nos passos 1-4. Esta
-- função também trava a AvisoEntrega resolvida (UPDATE já existente,
-- primeiro) antes de travar o Aviso (PERFORM FOR UPDATE, novo, segundo) —
-- MESMA ordem (entrega(s) antes de aviso) nas duas funções, então não há
-- ciclo: quem chegar depois apenas espera a linha do Aviso liberar, nunca
-- espera uma trava que o outro só pegaria depois de esperar a sua.
--
-- EXPAND-ONLY / IDEMPOTENTE: CREATE OR REPLACE FUNCTION (rodar 2x é no-op).
-- Não edita 0064 (regra da série: nunca editar migration já aplicada).
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

        -- Serializa contra qualquer outra chamada concorrente (deste worker
        -- ou de hub_push_reivindicar) para o MESMO aviso, antes de checar se
        -- já pode finalizar (0065 — fecha a corrida entre as 2 últimas
        -- entregas de um lote).
        PERFORM 1 FROM "Aviso" WHERE id = v_aviso_id FOR UPDATE;

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
