-- 0068 — Central de notificações do motorista (FASE 5, feature
-- "Adiantamento pelo App, Dados Bancários e Exportação Transfeera").
--
-- docs/specs/adiantamento-motorista/{data-model,plan,contracts/sql-rpc}.md;
-- tasks.md 5.1/5.2; PLANO.md §19 (D-15).
--
-- Cobre:
--   5.1.1 — tabela "NotificacaoMotorista" (histórico, retenção de 90 dias
--           via o mesmo expurgo de Aviso — FR-052)
--   5.1.2 — colunas "Aviso".origem/categoria (0061:55-75)
--   5.1.3 — hub_aviso_criar grava histórico para TODO o público, não só
--           quem tem push (D-15); SEM_DESTINATARIOS substitui
--           SEM_INSCRICOES_ATIVAS quando o público total é vazio
--   5.1.3 — hub_aviso_para_motorista passa a autorizar por
--           "NotificacaoMotorista" (em vez de só "AvisoEntrega")
--   5.2   — hub_adiantamento_notificar (STUB desde 0067) ganha corpo real:
--           cria Aviso(origem='sistema') + NotificacaoMotorista +
--           AvisoEntrega (só para quem tem push) para cada evento do
--           motorista/conta bancária/lote — FR-013, FR-042, FR-044
--   5.4   — RPCs hub_notificacao_listar/_nao_lidas/_marcar_lida/
--           _marcar_todas (central de notificações do app)
--
-- Convenções herdadas de 0061/0066/0067/0069 (ver cabeçalho de cada):
-- "PascalCase" nas tabelas, snake_case nas colunas; CREATE TABLE/INDEX IF
-- NOT EXISTS; DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT (idempotência,
-- migrate.sh 2x); CREATE OR REPLACE FUNCTION … SECURITY DEFINER SET
-- search_path = public, pg_temp; REVOKE ALL … FROM PUBLIC antes do GRANT
-- EXECUTE … TO authenticated; funções internas (sem GRANT) documentadas
-- como tal em contracts/sql-rpc.md.

-- ─────────────────────────────────────────────────────────────────────────
-- 5.1.2 — "Aviso".origem/categoria (0061:55-75)
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "Aviso" ADD COLUMN IF NOT EXISTS origem text NOT NULL DEFAULT 'hub';
ALTER TABLE "Aviso" ADD COLUMN IF NOT EXISTS categoria text NOT NULL DEFAULT 'aviso';
ALTER TABLE "Aviso" ALTER COLUMN criado_por DROP NOT NULL;

ALTER TABLE "Aviso" DROP CONSTRAINT IF EXISTS aviso_origem_chk;
ALTER TABLE "Aviso" ADD CONSTRAINT aviso_origem_chk CHECK (origem IN ('hub', 'sistema'));

ALTER TABLE "Aviso" DROP CONSTRAINT IF EXISTS aviso_categoria_chk;
ALTER TABLE "Aviso" ADD CONSTRAINT aviso_categoria_chk
    CHECK (categoria IN ('adiantamento', 'pagamento', 'conta_bancaria', 'sistema', 'aviso'));

ALTER TABLE "Aviso" DROP CONSTRAINT IF EXISTS aviso_criado_por_origem_chk;
ALTER TABLE "Aviso" ADD CONSTRAINT aviso_criado_por_origem_chk
    CHECK (origem = 'sistema' OR criado_por IS NOT NULL);

-- ─────────────────────────────────────────────────────────────────────────
-- 5.1.1 — "NotificacaoMotorista" (data-model.md §NotificacaoMotorista)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "NotificacaoMotorista" (
    id             bigserial PRIMARY KEY,
    cnpj_prestador text NOT NULL,
    categoria      text NOT NULL,
    titulo         text NOT NULL,
    corpo          text NOT NULL,
    link           text NULL,
    aviso_id       int NOT NULL REFERENCES "Aviso"(id) ON DELETE CASCADE,
    criada_em      timestamptz NOT NULL DEFAULT now(),
    lida_em        timestamptz NULL,
    CONSTRAINT notificacaomotorista_cnpj_chk CHECK (cnpj_prestador ~ '^[0-9]{14}$'),
    CONSTRAINT notificacaomotorista_categoria_chk
        CHECK (categoria IN ('adiantamento', 'pagamento', 'conta_bancaria', 'sistema', 'aviso')),
    CONSTRAINT notificacaomotorista_titulo_chk CHECK (char_length(titulo) BETWEEN 1 AND 60),
    CONSTRAINT notificacaomotorista_corpo_chk CHECK (char_length(corpo) BETWEEN 1 AND 180),
    -- allowlist de link (defesa em profundidade — 5.4.4 valida de novo no
    -- servidor antes de gravar; aqui é a última barreira, no banco)
    CONSTRAINT notificacaomotorista_link_chk CHECK (
        link IS NULL
        OR link IN ('/adiantamento', '/conta-bancaria', '/repasse')
        OR link ~ '^/adiantamento/[0-9]+$'
        OR link ~ '^/avisos/[0-9]+$'
    ),
    CONSTRAINT notificacaomotorista_aviso_cnpj_uniq UNIQUE (aviso_id, cnpj_prestador)
);

CREATE INDEX IF NOT EXISTS idx_notificacaomotorista_cnpj_criada
    ON "NotificacaoMotorista" (cnpj_prestador, criada_em DESC);
CREATE INDEX IF NOT EXISTS idx_notificacaomotorista_naolida
    ON "NotificacaoMotorista" (cnpj_prestador) WHERE lida_em IS NULL;

-- RLS ligado sem policy de leitura direta (padrão de PushInscricao/0061):
-- RLS habilitada + 0 políticas nega tudo a `authenticated`; só as funções
-- SECURITY DEFINER, rodando como dono da tabela, conseguem tocá-la.
ALTER TABLE "NotificacaoMotorista" ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────
-- 5.1.3 — hub_aviso_publico: função irmã de hub_aviso_alcance, público
-- TOTAL do histórico (sem exigir PushInscricao). Mesmo filtro por modo/ids/
-- escopo do grupo Movee de hub_aviso_alcance — só a fonte muda (ContaMotorista/
-- Motorista em vez de PushInscricao).
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION hub_aviso_publico(
    p_modo        text,
    p_ids         int[],
    p_fonte_conta text
)
RETURNS TABLE (cnpj_prestador text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_escopo int[] := hub_jwt_escopo_ids();
BEGIN
    IF NOT (6 = ANY (v_escopo)) THEN
        RAISE EXCEPTION 'FORA_DO_GRUPO_MOVEE';
    END IF;

    IF p_modo = 'empresa' AND NOT (p_ids <@ v_escopo) THEN
        RAISE EXCEPTION 'DESTINATARIOS_FORA_DO_ESCOPO';
    END IF;

    IF p_modo = 'individual' AND EXISTS (
        SELECT 1 FROM "Entregador" e
        WHERE e.id = ANY (p_ids) AND NOT (e.id_empresa = ANY (v_escopo))
    ) THEN
        RAISE EXCEPTION 'DESTINATARIOS_FORA_DO_ESCOPO';
    END IF;

    RETURN QUERY
    SELECT DISTINCT base.cnpj_prestador
    FROM (
        SELECT cm.cnpj_prestador
        FROM "ContaMotorista" cm
        WHERE p_fonte_conta = 'conta_motorista' AND cm.ativo
        UNION ALL
        SELECT m.cnpj_prestador
        FROM "Motorista" m
        WHERE p_fonte_conta = 'legado' AND m.ativo
    ) base
    WHERE
        (p_modo = 'toda_base' AND NOT EXISTS (
            SELECT 1 FROM "Entregador" e
            JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
            WHERE cm.cnpj_prestador = base.cnpj_prestador
            GROUP BY cm.cnpj_prestador
            HAVING NOT bool_or(e.id_empresa = ANY (v_escopo))
        ))
     OR (p_modo = 'individual' AND EXISTS (
            SELECT 1 FROM "Entregador" e
            JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
            WHERE cm.cnpj_prestador = base.cnpj_prestador AND e.id = ANY (p_ids)
        ))
     OR (p_modo = 'empresa' AND EXISTS (
            SELECT 1 FROM "Entregador" e
            JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
            WHERE cm.cnpj_prestador = base.cnpj_prestador AND e.id_empresa = ANY (p_ids)
        ));
END;
$$;

-- Chamada diretamente pelo Node (GET /avisos/alcance, 5.3.1 — "motoristas =
-- público total") além de por hub_aviso_criar — precisa de GRANT.
REVOKE ALL ON FUNCTION hub_aviso_publico(text, int[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_aviso_publico(text, int[], text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 5.1.3 — hub_aviso_criar: grava "NotificacaoMotorista" para o público
-- TOTAL (hub_aviso_publico); "AvisoEntrega" continua só para quem tem push
-- (hub_aviso_alcance, inalterada). SEM_DESTINATARIOS substitui
-- SEM_INSCRICOES_ATIVAS: recusa só quando o público total é vazio, não mais
-- quando ninguém tem push habilitado. Aviso sem nenhuma AvisoEntrega nasce
-- direto 'concluido' (nada para o push-worker processar). Assinatura e
-- retorno (aviso_id, visados, reutilizado) NÃO mudam — GRANT/REVOKE de
-- 0061:702-703 continuam valendo (mesma assinatura).
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION hub_aviso_criar(
    p_titulo             text,
    p_corpo              text,
    p_modo               text,
    p_ids                int[],
    p_chave_idempotencia uuid,
    p_key_id             text,
    p_fonte_conta        text
)
RETURNS TABLE (aviso_id int, visados int, reutilizado boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_sub      int := NULLIF(hub_jwt_claims() ->> 'sub', '')::int;
    v_empresa  int := NULLIF(hub_jwt_claims() ->> 'empresa_ativa', '')::int;
    v_aviso_id int;
    v_visados  int;
    v_publico  int;
BEGIN
    IF v_sub IS NULL OR NOT (6 = ANY (hub_jwt_escopo_ids())) THEN
        RAISE EXCEPTION 'FORA_DO_GRUPO_MOVEE';
    END IF;

    SELECT a.id INTO v_aviso_id
    FROM "Aviso" a
    WHERE a.criado_por = v_sub AND a.chave_idempotencia = p_chave_idempotencia;

    IF v_aviso_id IS NOT NULL THEN
        SELECT count(*) INTO v_visados FROM "AvisoEntrega" WHERE "AvisoEntrega".aviso_id = v_aviso_id;
        RETURN QUERY SELECT v_aviso_id, v_visados, true;
        RETURN;
    END IF;

    -- D-15: público total decide se o disparo é possível — independe de push.
    SELECT count(*) INTO v_publico FROM hub_aviso_publico(p_modo, p_ids, p_fonte_conta);
    IF v_publico = 0 THEN
        RAISE EXCEPTION 'SEM_DESTINATARIOS';
    END IF;

    INSERT INTO "Aviso" (id_empresa, titulo, corpo, modo_destinatarios, destinatarios_ids, chave_idempotencia, criado_por, origem)
    VALUES (v_empresa, p_titulo, p_corpo, p_modo, COALESCE(p_ids, '{}'::int[]), p_chave_idempotencia, v_sub, 'hub')
    RETURNING id INTO v_aviso_id;

    INSERT INTO "NotificacaoMotorista" (cnpj_prestador, categoria, titulo, corpo, link, aviso_id)
    SELECT DISTINCT pub.cnpj_prestador, 'aviso', p_titulo, p_corpo, '/avisos/' || v_aviso_id::text, v_aviso_id
    FROM hub_aviso_publico(p_modo, p_ids, p_fonte_conta) pub
    ON CONFLICT (aviso_id, cnpj_prestador) DO NOTHING;

    INSERT INTO "AvisoEntrega" (aviso_id, inscricao_id, cnpj_prestador)
    SELECT v_aviso_id, alc.inscricao_id, alc.cnpj_prestador
    FROM hub_aviso_alcance(p_modo, p_ids, p_key_id, p_fonte_conta) alc;

    GET DIAGNOSTICS v_visados = ROW_COUNT;

    IF v_visados = 0 THEN
        UPDATE "Aviso" SET status = 'concluido', concluido_em = now() WHERE id = v_aviso_id;
    END IF;

    RETURN QUERY SELECT v_aviso_id, v_visados, false;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 5.1.3 — hub_aviso_para_motorista: autoriza pela linha de
-- "NotificacaoMotorista" (histórico), não mais só por "AvisoEntrega" (push).
-- Assinatura/GRANT inalterados (0061:313-334).
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION hub_aviso_para_motorista(p_aviso_id int)
RETURNS TABLE (id int, titulo text, corpo text, criado_em timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_cnpj text := hub_jwt_motorista_cnpj();
BEGIN
    IF v_cnpj IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT a.id, a.titulo, a.corpo, a.criado_em
    FROM "Aviso" a
    WHERE a.id = p_aviso_id
      AND EXISTS (
          SELECT 1 FROM "NotificacaoMotorista" nm
          WHERE nm.aviso_id = a.id AND nm.cnpj_prestador = v_cnpj
      );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 5.2 — hub_adiantamento_notificar: substitui o STUB no-op de 0067 (CREATE
-- OR REPLACE não bastaria — a assinatura ganha um 3º parâmetro opcional
-- para os eventos de conta bancária, que não têm solicitação; por isso o
-- DROP da versão de 2 argumentos antes de recriar).
--
-- Dois jeitos de identificar o destinatário:
--   (a) p_solicitacao_id preenchido: eventos da solicitação de adiantamento
--       (liberada/inelegível/rejeitada/pagamento). cnpj vem do snapshot
--       "AdiantamentoSolicitacao".cnpj_prestador.
--   (b) p_solicitacao_id NULL + p_entregador_id preenchido: eventos de
--       conta bancária (não têm solicitação). cnpj vem de
--       Entregador → ContaMotorista (mesmo join de hub_aviso_alcance).
--
-- Eventos de LOTE (antes notificados uma vez com p_solicitacao_id=NULL,
-- perdendo o destinatário) passaram a ser chamados PELO CHAMADOR uma vez
-- por solicitação afetada (0067: hub_adiantamento_lote_download/_confirmar,
-- correção desta onda) — 'lote_exportado' (pagamento em processamento) e
-- 'lote_pago'/'lote_falhou' (pagamento realizado/falhou, FR-013, que exige
-- os dois como eventos distintos).
--
-- 'criada' é no-op deliberado (FR-013 não lista criação como evento
-- notificável; a timeline já grava via "AdiantamentoEvento" no chamador).
-- ─────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS hub_adiantamento_notificar(bigint, text);

CREATE FUNCTION hub_adiantamento_notificar(
    p_solicitacao_id bigint,
    p_evento         text,
    p_entregador_id  int DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_sol          "AdiantamentoSolicitacao";
    v_cnpj         text;
    v_id_empresa   int;
    v_entregador   int;
    v_categoria    text;
    v_titulo       text;
    v_corpo        text;
    v_link         text;
    v_aviso_id     int;
    v_entregas     int;
BEGIN
    IF p_evento = 'criada' THEN
        RETURN;
    END IF;

    IF p_solicitacao_id IS NOT NULL THEN
        SELECT * INTO v_sol FROM "AdiantamentoSolicitacao" WHERE id = p_solicitacao_id;
        IF NOT FOUND THEN RETURN; END IF;

        v_cnpj := v_sol.cnpj_prestador;
        v_id_empresa := v_sol.id_empresa;
        v_entregador := v_sol.entregador_id;
        v_link := '/adiantamento/' || v_sol.id::text;

        CASE p_evento
            WHEN 'liberada' THEN
                v_categoria := 'adiantamento';
                v_titulo := 'Adiantamento liberado';
                v_corpo := 'Seu adiantamento referente à produção de '
                    || to_char(v_sol.data_producao, 'DD/MM/YYYY') || ' foi liberado.';
            WHEN 'inelegivel', 'encerrada' THEN
                v_categoria := 'adiantamento';
                v_titulo := 'Adiantamento inelegível';
                v_corpo := 'Sua solicitação não pôde ser liberada' || COALESCE(': ' || v_sol.motivo_status, '.');
            WHEN 'rejeitada' THEN
                v_categoria := 'adiantamento';
                v_titulo := 'Solicitação rejeitada';
                v_corpo := 'Sua solicitação de adiantamento foi rejeitada' || COALESCE(': ' || v_sol.motivo_status, '.');
            WHEN 'encerrada_sem_pagamento' THEN
                v_categoria := 'pagamento';
                v_titulo := 'Pagamento não realizado';
                v_corpo := 'Seu adiantamento não será pago' || COALESCE(': ' || v_sol.motivo_status, '.');
            WHEN 'lote_exportado' THEN
                v_categoria := 'pagamento';
                v_titulo := 'Pagamento em processamento';
                v_corpo := 'Seu adiantamento entrou em processamento de pagamento.';
            WHEN 'lote_pago' THEN
                v_categoria := 'pagamento';
                v_titulo := 'Pagamento realizado';
                v_corpo := 'Seu adiantamento foi pago.';
            WHEN 'lote_falhou' THEN
                v_categoria := 'pagamento';
                v_titulo := 'Pagamento falhou';
                v_corpo := 'O pagamento do seu adiantamento falhou. Em breve entraremos em contato.';
            ELSE
                RETURN;
        END CASE;
    ELSIF p_entregador_id IS NOT NULL THEN
        SELECT e.id_empresa, cm.cnpj_prestador INTO v_id_empresa, v_cnpj
        FROM "Entregador" e
        JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
        WHERE e.id = p_entregador_id;

        IF v_cnpj IS NULL THEN RETURN; END IF;
        v_entregador := p_entregador_id;
        v_link := '/conta-bancaria';

        CASE p_evento
            WHEN 'conta_aprovada' THEN
                v_categoria := 'conta_bancaria';
                v_titulo := 'Conta bancária aprovada';
                v_corpo := 'Sua conta bancária foi aprovada.';
            WHEN 'conta_rejeitada' THEN
                v_categoria := 'conta_bancaria';
                v_titulo := 'Conta bancária rejeitada';
                v_corpo := 'Sua conta bancária foi rejeitada. Envie uma nova solicitação.';
            ELSE
                RETURN;
        END CASE;
    ELSE
        RETURN;
    END IF;

    INSERT INTO "Aviso" (
        id_empresa, titulo, corpo, modo_destinatarios, destinatarios_ids,
        chave_idempotencia, criado_por, origem, categoria
    )
    VALUES (
        v_id_empresa, v_titulo, v_corpo, 'individual', ARRAY[v_entregador],
        gen_random_uuid(), NULL, 'sistema', v_categoria
    )
    RETURNING id INTO v_aviso_id;

    INSERT INTO "NotificacaoMotorista" (cnpj_prestador, categoria, titulo, corpo, link, aviso_id)
    VALUES (v_cnpj, v_categoria, v_titulo, v_corpo, v_link, v_aviso_id)
    ON CONFLICT (aviso_id, cnpj_prestador) DO NOTHING;

    INSERT INTO "AvisoEntrega" (aviso_id, inscricao_id, cnpj_prestador)
    SELECT v_aviso_id, pi.id, pi.cnpj_prestador
    FROM "PushInscricao" pi
    WHERE pi.cnpj_prestador = v_cnpj;

    GET DIAGNOSTICS v_entregas = ROW_COUNT;

    IF v_entregas = 0 THEN
        UPDATE "Aviso" SET status = 'concluido', concluido_em = now() WHERE id = v_aviso_id;
    END IF;
END;
$$;

-- Função interna (contracts/sql-rpc.md "Internas (sem GRANT a
-- authenticated)"): chamada só de dentro de outras SECURITY DEFINER desta
-- feature. A versão STUB de 0067 nunca tinha REVOKE explícito — falha
-- corrigida aqui: sem REVOKE, o default do Postgres é EXECUTE para PUBLIC,
-- o que deixaria qualquer JWT autenticado chamar rpc/hub_adiantamento_notificar
-- direto e forjar avisos/notificações para qualquer solicitação ou
-- entregador (a função não valida ator nenhum — ela SÓ decide o quê/pra
-- quem notificar, não SE pode notificar).
REVOKE ALL ON FUNCTION hub_adiantamento_notificar(bigint, text, int) FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────
-- 5.4 — Central de notificações do app do motorista (contracts/motorista-
-- api.md §Notificações; contracts/sql-rpc.md "App do motorista").
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION hub_notificacao_listar(
    p_pagina    int DEFAULT 1,
    p_categoria text DEFAULT NULL,
    p_nao_lidas boolean DEFAULT NULL
)
RETURNS TABLE (
    id        bigint,
    categoria text,
    titulo    text,
    corpo     text,
    link      text,
    criada_em timestamptz,
    lida      boolean,
    total     bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_cnpj   text := hub_jwt_motorista_cnpj();
    v_pagina int := GREATEST(COALESCE(p_pagina, 1), 1);
    v_tam    constant int := 20;
BEGIN
    IF v_cnpj IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT nm.id, nm.categoria, nm.titulo, nm.corpo, nm.link, nm.criada_em,
           (nm.lida_em IS NOT NULL) AS lida,
           count(*) OVER () AS total
    FROM "NotificacaoMotorista" nm
    WHERE nm.cnpj_prestador = v_cnpj
      AND (p_categoria IS NULL OR nm.categoria = p_categoria)
      AND (p_nao_lidas IS NOT TRUE OR nm.lida_em IS NULL)
    ORDER BY nm.criada_em DESC
    LIMIT v_tam OFFSET (v_pagina - 1) * v_tam;
END;
$$;

CREATE OR REPLACE FUNCTION hub_notificacao_nao_lidas()
RETURNS TABLE (total bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_cnpj text := hub_jwt_motorista_cnpj();
BEGIN
    IF v_cnpj IS NULL THEN
        RETURN QUERY SELECT 0::bigint;
        RETURN;
    END IF;

    RETURN QUERY
    SELECT count(*) FROM "NotificacaoMotorista" WHERE cnpj_prestador = v_cnpj AND lida_em IS NULL;
END;
$$;

-- Idempotente: marcar uma já lida de novo é sucesso silencioso. 404 (via
-- exceção NAO_ENCONTRADA) só quando o id não existe ou não é do CNPJ da
-- claim (contracts/motorista-api.md).
CREATE OR REPLACE FUNCTION hub_notificacao_marcar_lida(p_id bigint)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_cnpj text := hub_jwt_motorista_cnpj();
    v_rows int;
BEGIN
    IF v_cnpj IS NULL THEN RAISE EXCEPTION 'NAO_ENCONTRADA'; END IF;

    UPDATE "NotificacaoMotorista" SET lida_em = now()
    WHERE id = p_id AND cnpj_prestador = v_cnpj AND lida_em IS NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    IF v_rows = 0 AND NOT EXISTS (
        SELECT 1 FROM "NotificacaoMotorista" WHERE id = p_id AND cnpj_prestador = v_cnpj
    ) THEN
        RAISE EXCEPTION 'NAO_ENCONTRADA';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION hub_notificacao_marcar_todas()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_cnpj text := hub_jwt_motorista_cnpj();
BEGIN
    IF v_cnpj IS NULL THEN RETURN; END IF;

    UPDATE "NotificacaoMotorista" SET lida_em = now()
    WHERE cnpj_prestador = v_cnpj AND lida_em IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION hub_notificacao_listar(int, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_notificacao_listar(int, text, boolean) TO authenticated;

REVOKE ALL ON FUNCTION hub_notificacao_nao_lidas() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_notificacao_nao_lidas() TO authenticated;

REVOKE ALL ON FUNCTION hub_notificacao_marcar_lida(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_notificacao_marcar_lida(bigint) TO authenticated;

REVOKE ALL ON FUNCTION hub_notificacao_marcar_todas() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_notificacao_marcar_todas() TO authenticated;
