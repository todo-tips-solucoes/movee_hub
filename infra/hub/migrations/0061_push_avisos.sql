-- 0061 — Web Push (VAPID) para o app motorista: avisos da equipe + entrega.
--
-- Fundamenta a feature "Notificações push no app do motorista"
-- (docs/specs/envioMassa_homologacao/{data-model,plan,research}.md,
-- contracts/{motorista-push,hub-avisos}.md). Cria as 5 tabelas descritas em
-- data-model.md, habilita RLS (FR-028) e as 11 funções SECURITY DEFINER que
-- concentram toda escrita/leitura sensível — mitigações dos achados
-- owasp-security S1 (funções sem auth), S2 (teto de inscrições), S4 (filtro
-- de grupo em toda_base), S10 (claim motorista_cnpj malformada).
--
-- Convenções herdadas (data-model.md cabeçalho; 0006/0018/0041/0047/0048/0051):
--   tabelas em "PascalCase", colunas em snake_case; CREATE TABLE IF NOT
--   EXISTS; DROP POLICY IF EXISTS + CREATE POLICY; CREATE OR REPLACE
--   FUNCTION … SECURITY DEFINER SET search_path = public, pg_temp; REVOKE
--   ALL … FROM PUBLIC antes do GRANT EXECUTE … TO authenticated (precedente
--   0041:69); nenhuma coluna guarda segredo — a chave privada VAPID fica
--   fora do banco (gen-vapid.sh, /var/lib/hub_secrets).
--
-- A chave privada VAPID NUNCA é gravada aqui — só o histórico público de
-- `PushChaveVapid.chave_publica` (research.md Decision 2/3).
--
-- ⚠️ Ainda NÃO validado ponta-a-ponta em ambiente vivo (aplicação + testes de
-- integração S1/S2/S4/S10 = tasks 1.2.8–1.2.12) na sessão em que este
-- arquivo foi escrito — ver evidência em tasks.md 1.2.*.

-- ─────────────────────────────────────────────────────────────────────────
-- Helpers de claim (padrão 0006/0018 — hub_jwt_claims() já existe em 0006)
-- ─────────────────────────────────────────────────────────────────────────

-- hub_jwt_push_worker() — claim booleana do processo interno (boot/worker/
-- expurgo). COALESCE(...,false): claim ausente/nula nega por padrão.
CREATE OR REPLACE FUNCTION hub_jwt_push_worker()
RETURNS boolean
LANGUAGE sql STABLE
AS $$
    SELECT COALESCE((hub_jwt_claims() ->> 'hub_push_worker')::boolean, false);
$$;

-- hub_jwt_motorista_cnpj() — recusa claim nula, vazia ou fora de 14 dígitos
-- (mitigação S10): a query WHERE não bate e a função escalar retorna NULL,
-- o que nunca casa em `cnpj_prestador = hub_jwt_motorista_cnpj()` — nega por
-- construção, sem caso especial (mesmo espírito do comentário de 0006).
CREATE OR REPLACE FUNCTION hub_jwt_motorista_cnpj()
RETURNS text
LANGUAGE sql STABLE
AS $$
    SELECT hub_jwt_claims() ->> 'motorista_cnpj'
    WHERE (hub_jwt_claims() ->> 'motorista_cnpj') ~ '^[0-9]{14}$';
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- Tabelas (data-model.md — campos, constraints e índices)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "Aviso" (
    id                   serial PRIMARY KEY,
    id_empresa           int NOT NULL,
    titulo               text NOT NULL,
    corpo                text NOT NULL,
    modo_destinatarios   text NOT NULL,
    destinatarios_ids    int[] NOT NULL DEFAULT '{}',
    status               text NOT NULL DEFAULT 'na_fila',
    chave_idempotencia   uuid NOT NULL,
    criado_por           int NOT NULL REFERENCES "Usuario"(id),
    criado_em            timestamptz NOT NULL DEFAULT now(),
    iniciado_em          timestamptz NULL,
    concluido_em         timestamptz NULL,
    CONSTRAINT aviso_titulo_chk CHECK (char_length(titulo) BETWEEN 1 AND 60),
    CONSTRAINT aviso_corpo_chk CHECK (char_length(corpo) BETWEEN 1 AND 180),
    CONSTRAINT aviso_modo_chk CHECK (modo_destinatarios IN ('toda_base', 'individual', 'empresa')),
    CONSTRAINT aviso_destinatarios_vazio_chk
        CHECK ((destinatarios_ids = '{}'::int[]) = (modo_destinatarios = 'toda_base')),
    CONSTRAINT aviso_status_chk CHECK (status IN ('na_fila', 'em_andamento', 'concluido')),
    CONSTRAINT aviso_criado_por_chave_uniq UNIQUE (criado_por, chave_idempotencia)
);

CREATE INDEX IF NOT EXISTS idx_aviso_empresa_criado ON "Aviso" (id_empresa, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_aviso_pendente ON "Aviso" (status) WHERE status <> 'concluido';
CREATE INDEX IF NOT EXISTS idx_aviso_criado_em ON "Aviso" (criado_em);

CREATE TABLE IF NOT EXISTS "AvisoEntrega" (
    id             bigserial PRIMARY KEY,
    aviso_id       int NOT NULL REFERENCES "Aviso"(id) ON DELETE CASCADE,
    inscricao_id   int NULL,
    cnpj_prestador text NOT NULL,
    status         text NOT NULL DEFAULT 'pendente',
    motivo         text NULL,
    tentativas     smallint NOT NULL DEFAULT 0,
    lease_ate      timestamptz NULL,
    lease_token    uuid NULL,
    criado_em      timestamptz NOT NULL DEFAULT now(),
    atualizado_em  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT avisoentrega_status_chk
        CHECK (status IN ('pendente', 'processando', 'aceito', 'falha', 'morta')),
    CONSTRAINT avisoentrega_motivo_chk CHECK (
        motivo IS NULL OR motivo IN (
            'transitoria_esgotada', 'rejeitada', 'interrompida',
            'inscricao_indisponivel', 'chave_substituida', 'envio_bloqueado'
        )
    ),
    CONSTRAINT avisoentrega_motivo_so_com_falha_chk
        CHECK (motivo IS NULL OR status = 'falha'),
    CONSTRAINT avisoentrega_aviso_inscricao_uniq UNIQUE (aviso_id, inscricao_id)
);

CREATE INDEX IF NOT EXISTS idx_avisoentrega_aviso_status ON "AvisoEntrega" (aviso_id, status);
CREATE INDEX IF NOT EXISTS idx_avisoentrega_cnpj_aviso ON "AvisoEntrega" (cnpj_prestador, aviso_id);

CREATE TABLE IF NOT EXISTS "PushInscricao" (
    id             serial PRIMARY KEY,
    cnpj_prestador text NOT NULL,
    endpoint       text NOT NULL,
    endpoint_hash  text NOT NULL UNIQUE,
    p256dh         text NOT NULL,
    auth           text NOT NULL,
    key_id         text NOT NULL,
    plataforma     text NOT NULL,
    dispositivo_id uuid NOT NULL,
    criado_em      timestamptz NOT NULL DEFAULT now(),
    atualizado_em  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pushinscricao_endpoint_len_chk CHECK (char_length(endpoint) <= 2000),
    CONSTRAINT pushinscricao_plataforma_chk CHECK (plataforma IN ('android', 'ios', 'desktop_outros'))
);

CREATE INDEX IF NOT EXISTS idx_pushinscricao_cnpj ON "PushInscricao" (cnpj_prestador);
CREATE INDEX IF NOT EXISTS idx_pushinscricao_key ON "PushInscricao" (key_id);

CREATE TABLE IF NOT EXISTS "PushEstadoAtivacao" (
    dispositivo_id uuid PRIMARY KEY,
    cnpj_prestador text NOT NULL,
    estado         text NOT NULL,
    plataforma     text NOT NULL,
    atualizado_em  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pushestadoativacao_estado_chk CHECK (
        estado IN ('ativas', 'bloqueadas', 'ios_sem_instalacao', 'sem_suporte', 'nao_ativadas')
    ),
    CONSTRAINT pushestadoativacao_plataforma_chk CHECK (plataforma IN ('android', 'ios', 'desktop_outros'))
);

CREATE INDEX IF NOT EXISTS idx_pushestado_cnpj ON "PushEstadoAtivacao" (cnpj_prestador);

CREATE TABLE IF NOT EXISTS "PushChaveVapid" (
    key_id         text PRIMARY KEY,
    chave_publica  text NOT NULL,
    gerado_por     text NULL,
    ativada_em     timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- RLS (FR-028) — nega por padrão; AvisoEntrega/PushInscricao/
-- PushEstadoAtivacao ficam SEM política (RLS habilitada + 0 políticas =
-- nega tudo a `authenticated`; só as funções SECURITY DEFINER, rodando como
-- dono da tabela, conseguem tocá-las — mesmo raciocínio de 0006).
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "Aviso" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AvisoEntrega" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PushInscricao" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PushEstadoAtivacao" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PushChaveVapid" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS aviso_select_por_escopo ON "Aviso";
CREATE POLICY aviso_select_por_escopo ON "Aviso"
    FOR SELECT
    USING (id_empresa = ANY (hub_jwt_escopo_ids()));

DROP POLICY IF EXISTS aviso_select_worker ON "Aviso";
CREATE POLICY aviso_select_worker ON "Aviso"
    FOR SELECT
    USING (hub_jwt_push_worker());

DROP POLICY IF EXISTS pushchave_select_worker ON "PushChaveVapid";
CREATE POLICY pushchave_select_worker ON "PushChaveVapid"
    FOR SELECT
    USING (hub_jwt_push_worker());

DROP POLICY IF EXISTS pushchave_insert_worker ON "PushChaveVapid";
CREATE POLICY pushchave_insert_worker ON "PushChaveVapid"
    FOR INSERT
    WITH CHECK (hub_jwt_push_worker());

-- Escrita em Aviso é exclusiva das funções definer (hub_aviso_criar,
-- hub_push_reivindicar) — só SELECT vai para `authenticated`.
GRANT SELECT ON "Aviso" TO authenticated;
GRANT SELECT, INSERT ON "PushChaveVapid" TO authenticated;
-- AvisoEntrega/PushInscricao/PushEstadoAtivacao: nenhum GRANT direto —
-- só as funções SECURITY DEFINER (dono da tabela) leem/escrevem.

-- ─────────────────────────────────────────────────────────────────────────
-- Funções de negócio (as 11 de data-model.md §Funções), todas
-- SECURITY DEFINER / search_path fixo / REVOKE PUBLIC + GRANT authenticated
-- ─────────────────────────────────────────────────────────────────────────

-- 1. hub_push_inscricao_registrar — claim motorista_cnpj; upsert por
-- endpoint_hash + upsert do estado 'ativas'; teto de 10 inscrições ativas
-- por CNPJ, removendo a mais antiga por atualizado_em ao exceder (S2).
CREATE OR REPLACE FUNCTION hub_push_inscricao_registrar(
    p_endpoint       text,
    p_endpoint_hash  text,
    p_p256dh         text,
    p_auth           text,
    p_key_id         text,
    p_plataforma     text,
    p_dispositivo_id uuid
)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_cnpj text := hub_jwt_motorista_cnpj();
    v_id   int;
BEGIN
    IF v_cnpj IS NULL THEN
        RAISE EXCEPTION 'CLAIM_MOTORISTA_CNPJ_AUSENTE';
    END IF;

    INSERT INTO "PushInscricao"
        (cnpj_prestador, endpoint, endpoint_hash, p256dh, auth, key_id, plataforma, dispositivo_id)
    VALUES
        (v_cnpj, p_endpoint, p_endpoint_hash, p_p256dh, p_auth, p_key_id, p_plataforma, p_dispositivo_id)
    ON CONFLICT (endpoint_hash) DO UPDATE
        SET cnpj_prestador = EXCLUDED.cnpj_prestador,
            endpoint        = EXCLUDED.endpoint,
            p256dh          = EXCLUDED.p256dh,
            auth            = EXCLUDED.auth,
            key_id          = EXCLUDED.key_id,
            plataforma      = EXCLUDED.plataforma,
            dispositivo_id  = EXCLUDED.dispositivo_id,
            atualizado_em   = now()
    RETURNING id INTO v_id;

    INSERT INTO "PushEstadoAtivacao" (dispositivo_id, cnpj_prestador, estado, plataforma)
    VALUES (p_dispositivo_id, v_cnpj, 'ativas', p_plataforma)
    ON CONFLICT (dispositivo_id) DO UPDATE
        SET cnpj_prestador = EXCLUDED.cnpj_prestador,
            estado         = 'ativas',
            plataforma     = EXCLUDED.plataforma,
            atualizado_em  = now();

    -- Teto de 10 (dec-043/block-004): apaga as excedentes mais antigas.
    DELETE FROM "PushInscricao" p
    WHERE p.cnpj_prestador = v_cnpj
      AND p.id IN (
          SELECT ranked.id FROM (
              SELECT id, atualizado_em,
                     row_number() OVER (ORDER BY atualizado_em ASC) AS rn,
                     count(*) OVER () AS total
              FROM "PushInscricao" WHERE cnpj_prestador = v_cnpj
          ) ranked
          WHERE ranked.total > 10 AND ranked.rn <= (ranked.total - 10)
      );

    RETURN v_id;
END;
$$;

-- 2. hub_push_inscricao_revogar — apaga inscrição e estado do aparelho, só
-- se forem do claim; idempotente (DELETE sem match não é erro).
CREATE OR REPLACE FUNCTION hub_push_inscricao_revogar(
    p_endpoint_hash  text,
    p_dispositivo_id uuid
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_cnpj text := hub_jwt_motorista_cnpj();
BEGIN
    IF v_cnpj IS NULL THEN
        RAISE EXCEPTION 'CLAIM_MOTORISTA_CNPJ_AUSENTE';
    END IF;

    DELETE FROM "PushInscricao"
    WHERE endpoint_hash = p_endpoint_hash AND cnpj_prestador = v_cnpj;

    DELETE FROM "PushEstadoAtivacao"
    WHERE dispositivo_id = p_dispositivo_id AND cnpj_prestador = v_cnpj;
END;
$$;

-- 3. hub_push_estado_reportar — upsert por dispositivo_id.
CREATE OR REPLACE FUNCTION hub_push_estado_reportar(
    p_dispositivo_id uuid,
    p_estado         text,
    p_plataforma     text
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_cnpj text := hub_jwt_motorista_cnpj();
BEGIN
    IF v_cnpj IS NULL THEN
        RAISE EXCEPTION 'CLAIM_MOTORISTA_CNPJ_AUSENTE';
    END IF;

    INSERT INTO "PushEstadoAtivacao" (dispositivo_id, cnpj_prestador, estado, plataforma)
    VALUES (p_dispositivo_id, v_cnpj, p_estado, p_plataforma)
    ON CONFLICT (dispositivo_id) DO UPDATE
        SET cnpj_prestador = EXCLUDED.cnpj_prestador,
            estado         = EXCLUDED.estado,
            plataforma     = EXCLUDED.plataforma,
            atualizado_em  = now();
END;
$$;

-- 4. hub_aviso_para_motorista — só se existir AvisoEntrega do aviso com
-- cnpj_prestador = claim; senão 0 linhas (nunca exceção — motorista não
-- sabe se o id existe para outra pessoa).
CREATE OR REPLACE FUNCTION hub_aviso_para_motorista(p_aviso_id int)
RETURNS TABLE (id int, titulo text, corpo text, criado_em timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
          SELECT 1 FROM "AvisoEntrega" ae
          WHERE ae.aviso_id = a.id AND ae.cnpj_prestador = v_cnpj
      );
END;
$$;

-- 5. hub_aviso_alcance — quem o disparo alcançaria agora. Reusada por
-- hub_aviso_criar (mesma lógica, sem duplicar — chamada função-a-função sob
-- o mesmo dono, que ignora o REVOKE FROM PUBLIC aplicado ao final do arquivo).
CREATE OR REPLACE FUNCTION hub_aviso_alcance(
    p_modo        text,
    p_ids         int[],
    p_key_id      text,
    p_fonte_conta text
)
RETURNS TABLE (cnpj_prestador text, inscricao_id int)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
    SELECT pi.cnpj_prestador, pi.id
    FROM "PushInscricao" pi
    WHERE pi.key_id = p_key_id
      AND (
            (p_fonte_conta = 'conta_motorista' AND EXISTS (
                SELECT 1 FROM "ContaMotorista" cm
                WHERE cm.cnpj_prestador = pi.cnpj_prestador AND cm.ativo
            ))
         OR (p_fonte_conta = 'legado' AND EXISTS (
                SELECT 1 FROM "Motorista" m
                WHERE m.cnpj_prestador = pi.cnpj_prestador AND m.ativo
            ))
          )
      AND (
            -- toda_base: exclui conta cujos vínculos Entregador estão TODOS
            -- fora do grupo Movee; conta sem nenhum vínculo continua alcançada.
            (p_modo = 'toda_base' AND NOT EXISTS (
                SELECT 1 FROM "Entregador" e
                JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
                WHERE cm.cnpj_prestador = pi.cnpj_prestador
                GROUP BY cm.cnpj_prestador
                HAVING NOT bool_or(e.id_empresa = ANY (v_escopo))
            ))
         OR (p_modo = 'individual' AND EXISTS (
                SELECT 1 FROM "Entregador" e
                JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
                WHERE cm.cnpj_prestador = pi.cnpj_prestador AND e.id = ANY (p_ids)
            ))
         OR (p_modo = 'empresa' AND EXISTS (
                SELECT 1 FROM "Entregador" e
                JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
                WHERE cm.cnpj_prestador = pi.cnpj_prestador AND e.id_empresa = ANY (p_ids)
            ))
          );
END;
$$;

-- 6. hub_aviso_criar — idempotente por (sub, chave); INSERT Aviso +
-- AvisoEntrega a partir de hub_aviso_alcance; 0 visados => exceção
-- SEM_INSCRICOES_ATIVAS e nada é gravado (o RAISE reverte a função inteira).
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
DECLARE
    v_sub      int := NULLIF(hub_jwt_claims() ->> 'sub', '')::int;
    v_empresa  int := NULLIF(hub_jwt_claims() ->> 'empresa_ativa', '')::int;
    v_aviso_id int;
    v_visados  int;
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

    INSERT INTO "Aviso" (id_empresa, titulo, corpo, modo_destinatarios, destinatarios_ids, chave_idempotencia, criado_por)
    VALUES (v_empresa, p_titulo, p_corpo, p_modo, COALESCE(p_ids, '{}'::int[]), p_chave_idempotencia, v_sub)
    RETURNING id INTO v_aviso_id;

    INSERT INTO "AvisoEntrega" (aviso_id, inscricao_id, cnpj_prestador)
    SELECT v_aviso_id, alc.inscricao_id, alc.cnpj_prestador
    FROM hub_aviso_alcance(p_modo, p_ids, p_key_id, p_fonte_conta) alc;

    GET DIAGNOSTICS v_visados = ROW_COUNT;

    IF v_visados = 0 THEN
        RAISE EXCEPTION 'SEM_INSCRICOES_ATIVAS';
    END IF;

    RETURN QUERY SELECT v_aviso_id, v_visados, false;
END;
$$;

-- 7. hub_aviso_resumo — contagens por aviso, só dentro do escopo.
CREATE OR REPLACE FUNCTION hub_aviso_resumo(p_aviso_ids int[])
RETURNS TABLE (
    aviso_id    int,
    visados     bigint,
    pendentes   bigint,
    processando bigint,
    aceitos     bigint,
    falhas      bigint,
    mortas      bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT (6 = ANY (hub_jwt_escopo_ids())) THEN
        RAISE EXCEPTION 'FORA_DO_GRUPO_MOVEE';
    END IF;

    RETURN QUERY
    SELECT a.id,
           count(ae.*),
           count(*) FILTER (WHERE ae.status = 'pendente'),
           count(*) FILTER (WHERE ae.status = 'processando'),
           count(*) FILTER (WHERE ae.status = 'aceito'),
           count(*) FILTER (WHERE ae.status = 'falha'),
           count(*) FILTER (WHERE ae.status = 'morta')
    FROM "Aviso" a
    JOIN "AvisoEntrega" ae ON ae.aviso_id = a.id
    WHERE a.id = ANY (p_aviso_ids)
      AND a.id_empresa = ANY (hub_jwt_escopo_ids())
    GROUP BY a.id;
END;
$$;

-- 8. hub_push_cobertura — ativos por plataforma, impedidos por estado,
-- não-ativadas (a app é exclusiva do grupo Movee, então PushEstadoAtivacao
-- já só contém contas do grupo por construção — CLAUDE.md §Regras de domínio).
CREATE OR REPLACE FUNCTION hub_push_cobertura()
RETURNS TABLE (
    ativos_android               bigint,
    ativos_ios                   bigint,
    ativos_desktop_outros        bigint,
    impedidos_bloqueadas         bigint,
    impedidos_ios_sem_instalacao bigint,
    impedidos_sem_suporte        bigint,
    nao_ativadas                 bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT (6 = ANY (hub_jwt_escopo_ids())) THEN
        RAISE EXCEPTION 'FORA_DO_GRUPO_MOVEE';
    END IF;

    RETURN QUERY
    SELECT
        count(*) FILTER (WHERE pea.estado = 'ativas' AND pea.plataforma = 'android'),
        count(*) FILTER (WHERE pea.estado = 'ativas' AND pea.plataforma = 'ios'),
        count(*) FILTER (WHERE pea.estado = 'ativas' AND pea.plataforma = 'desktop_outros'),
        count(*) FILTER (WHERE pea.estado = 'bloqueadas'),
        count(*) FILTER (WHERE pea.estado = 'ios_sem_instalacao'),
        count(*) FILTER (WHERE pea.estado = 'sem_suporte'),
        count(*) FILTER (WHERE pea.estado = 'nao_ativadas')
    FROM "PushEstadoAtivacao" pea;
END;
$$;

-- 9. hub_push_reivindicar — sequência de 5 passos de data-model.md, numa
-- transação (a chamada RPC inteira já é a transação).
CREATE OR REPLACE FUNCTION hub_push_reivindicar(
    p_aviso_id       int,
    p_limite         int,
    p_lease_segundos int,
    p_lease_token    uuid,
    p_key_id         text
)
RETURNS TABLE (entrega_id bigint, endpoint text, p256dh text, auth text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT hub_jwt_push_worker() THEN
        RAISE EXCEPTION 'CLAIM_HUB_PUSH_WORKER_AUSENTE';
    END IF;

    -- 1. na_fila -> em_andamento
    UPDATE "Aviso"
    SET status = 'em_andamento', iniciado_em = COALESCE(iniciado_em, now())
    WHERE id = p_aviso_id AND status = 'na_fila';

    -- 2. em voo com lease vencido -> falha/interrompida (nunca reenviada)
    UPDATE "AvisoEntrega"
    SET status = 'falha', motivo = 'interrompida', atualizado_em = now()
    WHERE aviso_id = p_aviso_id AND status = 'processando' AND lease_ate < now();

    -- 3a. inscrição apagada ou transferida
    UPDATE "AvisoEntrega" ae
    SET status = 'falha', motivo = 'inscricao_indisponivel', atualizado_em = now()
    WHERE ae.aviso_id = p_aviso_id AND ae.status = 'pendente'
      AND (
            ae.inscricao_id IS NULL
         OR NOT EXISTS (
                SELECT 1 FROM "PushInscricao" pi
                WHERE pi.id = ae.inscricao_id AND pi.cnpj_prestador = ae.cnpj_prestador
            )
          );

    -- 3b. chave substituída
    UPDATE "AvisoEntrega" ae
    SET status = 'falha', motivo = 'chave_substituida', atualizado_em = now()
    WHERE ae.aviso_id = p_aviso_id AND ae.status = 'pendente'
      AND EXISTS (
            SELECT 1 FROM "PushInscricao" pi
            WHERE pi.id = ae.inscricao_id AND pi.key_id <> p_key_id
          );

    -- 4. reivindica até p_limite pendentes, FOR UPDATE SKIP LOCKED
    RETURN QUERY
    WITH candidatas AS (
        SELECT ae.id
        FROM "AvisoEntrega" ae
        WHERE ae.aviso_id = p_aviso_id AND ae.status = 'pendente'
        ORDER BY ae.id
        FOR UPDATE SKIP LOCKED
        LIMIT p_limite
    ),
    reivindicadas AS (
        UPDATE "AvisoEntrega" ae
        SET status = 'processando',
            lease_ate = now() + make_interval(secs => p_lease_segundos),
            lease_token = p_lease_token,
            atualizado_em = now()
        FROM candidatas c
        WHERE ae.id = c.id
        RETURNING ae.id, ae.inscricao_id
    )
    SELECT r.id, pi.endpoint, pi.p256dh, pi.auth
    FROM reivindicadas r
    JOIN "PushInscricao" pi ON pi.id = r.inscricao_id;

    -- 5. sem pendente/processando restante -> concluído
    UPDATE "Aviso"
    SET status = 'concluido', concluido_em = now()
    WHERE id = p_aviso_id AND status = 'em_andamento'
      AND NOT EXISTS (
            SELECT 1 FROM "AvisoEntrega"
            WHERE aviso_id = p_aviso_id AND status IN ('pendente', 'processando')
          );
END;
$$;

-- 10. hub_push_registrar_resultado — só aplica se ainda 'processando' com o
-- MESMO lease_token (evita gravar resultado de um lease já expirado/perdido).
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
BEGIN
    IF NOT hub_jwt_push_worker() THEN
        RAISE EXCEPTION 'CLAIM_HUB_PUSH_WORKER_AUSENTE';
    END IF;

    UPDATE "AvisoEntrega"
    SET status = p_status, motivo = p_motivo, tentativas = p_tentativas, atualizado_em = now()
    WHERE id = p_entrega_id AND status = 'processando' AND lease_token = p_lease_token
    RETURNING inscricao_id INTO v_inscricao_id;

    IF FOUND THEN
        v_aplicado := true;
        IF p_status = 'morta' AND v_inscricao_id IS NOT NULL THEN
            DELETE FROM "PushInscricao" WHERE id = v_inscricao_id;
        END IF;
    END IF;

    RETURN v_aplicado;
END;
$$;

-- 11. hub_push_expurgo — apaga Aviso/AvisoEntrega com mais de 90 dias
-- (FR-030); retorna contagens.
CREATE OR REPLACE FUNCTION hub_push_expurgo()
RETURNS TABLE (avisos_removidos int, entregas_removidas int)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_avisos   int;
    v_entregas int;
BEGIN
    IF NOT hub_jwt_push_worker() THEN
        RAISE EXCEPTION 'CLAIM_HUB_PUSH_WORKER_AUSENTE';
    END IF;

    WITH alvo AS (
        SELECT id FROM "Aviso" WHERE criado_em < now() - interval '90 days'
    ),
    del_entregas AS (
        DELETE FROM "AvisoEntrega" WHERE aviso_id IN (SELECT id FROM alvo)
        RETURNING 1
    ),
    del_avisos AS (
        DELETE FROM "Aviso" WHERE id IN (SELECT id FROM alvo)
        RETURNING 1
    )
    SELECT (SELECT count(*) FROM del_avisos)::int, (SELECT count(*) FROM del_entregas)::int
    INTO v_avisos, v_entregas;

    RETURN QUERY SELECT v_avisos, v_entregas;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- Fail-closed (mitigação S1, precedente 0041:69): nenhum papel de aplicação
-- executa por padrão — só `authenticated` explicitamente.
-- ─────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION hub_push_inscricao_registrar(text, text, text, text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_push_inscricao_registrar(text, text, text, text, text, text, uuid) TO authenticated;

REVOKE ALL ON FUNCTION hub_push_inscricao_revogar(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_push_inscricao_revogar(text, uuid) TO authenticated;

REVOKE ALL ON FUNCTION hub_push_estado_reportar(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_push_estado_reportar(uuid, text, text) TO authenticated;

REVOKE ALL ON FUNCTION hub_aviso_para_motorista(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_aviso_para_motorista(int) TO authenticated;

REVOKE ALL ON FUNCTION hub_aviso_alcance(text, int[], text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_aviso_alcance(text, int[], text, text) TO authenticated;

REVOKE ALL ON FUNCTION hub_aviso_criar(text, text, text, int[], uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_aviso_criar(text, text, text, int[], uuid, text, text) TO authenticated;

REVOKE ALL ON FUNCTION hub_aviso_resumo(int[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_aviso_resumo(int[]) TO authenticated;

REVOKE ALL ON FUNCTION hub_push_cobertura() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_push_cobertura() TO authenticated;

REVOKE ALL ON FUNCTION hub_push_reivindicar(int, int, int, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_push_reivindicar(int, int, int, uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION hub_push_registrar_resultado(bigint, uuid, text, text, smallint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_push_registrar_resultado(bigint, uuid, text, text, smallint) TO authenticated;

REVOKE ALL ON FUNCTION hub_push_expurgo() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_push_expurgo() TO authenticated;
