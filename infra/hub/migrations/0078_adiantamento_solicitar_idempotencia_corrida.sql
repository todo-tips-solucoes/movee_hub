-- 0078 — `hub_adiantamento_solicitar` distingue reenvio concorrente
-- legítimo (MESMA chaveIdempotencia) de solicitação duplicada de verdade
-- (feature "Adiantamento pelo App, Dados Bancários e Exportação Transfeera",
-- FASE 11 / converge-report.md, tasks.md 11.23, FR-050). Não edita
-- 0066/.../0077 (já aplicadas no hub-homolog persistente) — expand-only.
--
-- Base: a versão vigente é a de 0074 (DROP+CREATE que acrescentou
-- `id_empresa` ao RETURNS TABLE, 11.10) — RETURNS TABLE aqui é IDÊNTICO ao
-- de 0074 (mesmos nomes/tipos/ordem de OUT), então basta CREATE OR REPLACE.
--
-- Bug: "AdiantamentoSolicitacao" tem TRÊS índices únicos (0066:220-226) —
-- `uniq_adiantamentosolicitacao_conta_dia` (uma solicitação por conta/dia),
-- `uniq_adiantamentosolicitacao_entregador_producao` (idem por produção) e
-- `uniq_adiantamentosolicitacao_idempotencia` (a chave de idempotência de
-- verdade). O `EXCEPTION WHEN unique_violation` do INSERT trata os três
-- IGUAL — sempre `RAISE EXCEPTION 'ALREADY_REQUESTED'`, que
-- routes/motorista-adiantamento.js mapeia para 409 SOLICITACAO_INDISPONIVEL.
-- Dois cliques CONCORRENTES com a MESMA chaveIdempotencia (reenvio de rede,
-- duplo-tap) colidem em `uniq_adiantamentosolicitacao_idempotencia` — o
-- perdedor da corrida deveria receber o 201/200 idempotente de sempre
-- (`reutilizado:true`, igual ao SELECT de topo da função quando a chamada
-- não é concorrente), não um 409 de "solicitação duplicada do dia".
--
-- Fix (NÃO usa `GET STACKED DIAGNOSTICS CONSTRAINT_NAME`: comprovado por
-- teste manual que o Postgres reporta SEMPRE a constraint
-- `uniq_adiantamentosolicitacao_conta_dia` quando os valores colidem nela
-- E na de idempotência ao mesmo tempo — que é EXATAMENTE o caso de duas
-- chamadas concorrentes com a MESMA chave, já que ambas calculam a MESMA
-- data_solicitacao. O nome da constraint reportada não distingue as duas
-- causas.): não importa QUAL unique_violation disparou — refaz o SELECT de
-- topo (mesma condição: conta_motorista_id + chave_idempotencia) depois de
-- capturar a exceção. Se achar uma linha (o vencedor da corrida já
-- commitou uma linha com essa MESMA chave), é reenvio idempotente de
-- verdade -> `reutilizado:true`. Se não achar (a chave é OUTRA — violação
-- foi por já existir uma solicitação nesse dia/produção com chave
-- DIFERENTE), comportamento inalterado: `ALREADY_REQUESTED`.
CREATE OR REPLACE FUNCTION hub_adiantamento_solicitar(
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
    v_existente          RECORD;
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
        -- 11.23/FR-050: não confia em CONSTRAINT_NAME (ver nota acima) —
        -- refaz o SELECT de topo pela MESMA chave. Achou = o vencedor da
        -- corrida (MESMA chaveIdempotencia) já commitou -> reutilizado:true
        -- (o mesmo que teria acontecido se essa chamada chegasse um
        -- instante depois, fora de corrida). Não achou = a violação foi
        -- por outra solicitação (chave DIFERENTE) já ocupar o dia/produção
        -- -> ALREADY_REQUESTED, comportamento inalterado.
        SELECT s.id, s.status, s.id_empresa INTO v_existente
        FROM "AdiantamentoSolicitacao" s
        WHERE s.conta_motorista_id = v_conta_motorista_id AND s.chave_idempotencia = p_chave;
        IF FOUND THEN
            RETURN QUERY SELECT v_existente.id, v_existente.status, true, v_existente.id_empresa;
            RETURN;
        END IF;
        RAISE EXCEPTION 'ALREADY_REQUESTED';
    END;

    INSERT INTO "AdiantamentoEvento" (solicitacao_id, id_empresa, status_de, status_para, ator_tipo)
    VALUES (v_novo_id, v_entregador.id_empresa, NULL, 'AGUARDANDO_CORTE', 'motorista');

    PERFORM hub_adiantamento_notificar(v_novo_id, 'criada');

    RETURN QUERY SELECT v_novo_id, 'AGUARDANDO_CORTE'::text, false, v_entregador.id_empresa;
END;
$$;
