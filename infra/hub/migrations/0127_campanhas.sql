-- 0127 — Campanhas do motorista: ranking gamificado por indicadores de performance.
--
-- Plano: docs/plans/campanhas-motorista/PLANO.md · contratos: CONTRATOS.md (§0–§6, §8).
--
-- POR QUE: o hub não tinha nenhuma superfície em que o motorista visse o próprio desempenho.
-- Uma campanha é uma regra (período, praças, turnos, modais, pesos, cortes, prêmios por faixa)
-- aplicada sobre `mv_performance_dia` — os 4 indicadores JÁ existem por turno (0051), a campanha
-- NÃO recalcula indicador, só os pondera. O ranking é MATERIALIZADO a cada importação (3×/dia).
--
-- O QUE MUDA (tudo aditivo, idempotente; sem DROP de objeto existente):
--   1. Tabelas "Campanha", "CampanhaPremio", "CampanhaRanking", "CampanhaVencedor" (RLS por id_empresa).
--   2. GATILHO DE IMUTABILIDADE: campanha lançada recusa UPDATE de coluna de regra e DELETE
--      (CAMPANHA_IMUTAVEL); aceita só cancelamento, fechamento, dados_ate e marcas de aviso.
--      A imutabilidade mora no BANCO, não na tela. "CampanhaPremio" fica inteira congelada e
--      "CampanhaVencedor" só aceita mudança nos campos de entrega/exportação.
--   3. Funções: hub_hoje_sp, hub_nome_abreviado, hub_campanha_situacao e as RPCs do CONTRATOS §6.
--   4. hub_notificacao_enfileirar(): corpo de envio de aviso EXTRAÍDO de hub_adiantamento_notificar
--      (0068), que passa a usá-la (CREATE OR REPLACE, comportamento idêntico). As campanhas usam
--      a mesma função — um único caminho para Aviso + NotificacaoMotorista + AvisoEntrega.
--   5. "NotificacaoMotorista".link aceita '/campanhas/<id>' (ADD CONSTRAINT novo; a allowlist da 0068
--      recusaria o link do aviso de campanha).
--   6. Módulo `campanhas` + permissões campanhas.consultar|gerir|entregar para admin_entidade,
--      financeiro e financeiro_aprovador (os dois últimos IDÊNTICOS de propósito, 0115/CLAUDE.md).
--   7. Tipo PREMIO_CAMPANHA (+1) em "LancamentoExternoTipo": prêmio em dinheiro entra pelo
--      Lançamento externo (importação de planilha), sem caminho de dinheiro novo.
--
-- ⚠️ "Praça" no hub = `PerformanceTurno.subpraca` (é o que /performance/areas lista e o que a
--    Performance filtra, 0051). O CONTRATOS §2 diz `praca`; vale o PLANO §1 (subpraca + o índice
--    idx_performance_empresa_subpraca_data). Praça/turno/modal são comparados como upper(btrim(x)).
-- ⚠️ GRANT por COLUNA engana `has_table_privilege` (lição da 0052): em "CampanhaPremio" a coluna
--    `foto` (bytea) fica FORA do SELECT de `authenticated`; só as RPCs a leem. Conferir com
--    has_column_privilege, nunca com has_table_privilege.
-- ⚠️ O módulo NÃO é habilitado para nenhuma entidade aqui ("ModuloEntidade"): ativar por empresa é
--    decisão operacional. Sem a linha, hub_adiantamento_tem_permissao() nega (fail-closed).
-- ⚠️ posicao_anterior = posição do recálculo anterior QUE TINHA OUTRO dados_ate. Recalcular com o mesmo
--    dados_ate (2ª/3ª importação do dia) PRESERVA a posicao_anterior de cada linha (a linha nova nasce NULL).
--
-- ROLLBACK (só se nenhuma campanha foi lançada): DROP das 4 tabelas e das funções hub_campanha*/
-- hub_motorista_campanha*/hub_nome_abreviado/hub_hoje_sp; recriar hub_adiantamento_notificar com
-- o corpo da 0068 e dropar hub_notificacao_enfileirar. Os INSERTs de Modulo/Permissao/Tipo ficam.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. Funções utilitárias
-- ═══════════════════════════════════════════════════════════════════════

-- Hoje em São Paulo — UMA função (CONTRATOS §0). Nunca current_date.
CREATE OR REPLACE FUNCTION hub_hoje_sp()
RETURNS date
LANGUAGE sql STABLE
AS $$ SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date; $$;

-- "Juliana Pereira Lima" -> "Juliana L."; 1 token -> só ele; vazio/NULL -> "Motorista".
CREATE OR REPLACE FUNCTION hub_nome_abreviado(p_nome text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
    SELECT CASE
        WHEN t.n = 0 THEN 'Motorista'
        WHEN t.n = 1 THEN t.a[1]
        ELSE t.a[1] || ' ' || upper(left(t.a[t.n], 1)) || '.'
    END
    FROM (
        SELECT a, COALESCE(cardinality(a), 0) AS n
        FROM (SELECT regexp_split_to_array(NULLIF(btrim(p_nome), ''), '\s+') AS a) s
    ) t;
$$;

-- Lista de praças/turnos/modais: NULL (todos) ou 1..50 itens, cada 1..120, já canônicos.
CREATE OR REPLACE FUNCTION hub_campanha_lista_ok(p text[])
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
    SELECT p IS NULL OR (
        cardinality(p) BETWEEN 1 AND 50
        AND NOT EXISTS (
            SELECT 1 FROM unnest(p) x
            WHERE x IS NULL OR char_length(x) NOT BETWEEN 1 AND 120 OR x <> upper(btrim(x))
        )
    );
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. Tabelas
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "Campanha" (
    id                   serial PRIMARY KEY,
    id_empresa           int NOT NULL,
    nome                 text NOT NULL,
    descricao            text NOT NULL DEFAULT '',
    data_inicio          date NOT NULL,
    data_fim             date NOT NULL,
    pracas               text[] NULL,
    turnos               text[] NULL,
    modais               text[] NULL,
    min_turnos           smallint NOT NULL,
    peso_aceitacao       smallint NOT NULL DEFAULT 0,
    peso_conclusao       smallint NOT NULL DEFAULT 0,
    peso_tempo           smallint NOT NULL DEFAULT 0,
    peso_pedidos         smallint NOT NULL DEFAULT 0,
    corte_aceitacao      numeric(5,4) NULL,
    corte_conclusao      numeric(5,4) NULL,
    corte_tempo          numeric(5,4) NULL,
    corte_pedidos        int NULL,
    avisar               boolean NOT NULL DEFAULT true,
    criada_por           int NOT NULL REFERENCES "Usuario"(id),
    criada_em            timestamptz NOT NULL DEFAULT now(),
    lancada_por          int NULL REFERENCES "Usuario"(id),
    lancada_em           timestamptz NULL,
    cancelada_por        int NULL REFERENCES "Usuario"(id),
    cancelada_em         timestamptz NULL,
    motivo_cancelamento  text NULL,
    fechada_em           timestamptz NULL,
    dados_ate            date NULL,
    aviso_inicio_em      timestamptz NULL,
    aviso_fim_em         timestamptz NULL,
    CONSTRAINT campanha_nome_chk CHECK (char_length(nome) BETWEEN 3 AND 120),
    CONSTRAINT campanha_descricao_chk CHECK (char_length(descricao) <= 1000),
    -- duração ≤ 92 dias, contando início e fim
    CONSTRAINT campanha_datas_chk CHECK (data_fim >= data_inicio AND data_fim - data_inicio <= 91),
    CONSTRAINT campanha_pracas_chk CHECK (hub_campanha_lista_ok(pracas)),
    CONSTRAINT campanha_turnos_chk CHECK (hub_campanha_lista_ok(turnos)),
    CONSTRAINT campanha_modais_chk CHECK (hub_campanha_lista_ok(modais)),
    CONSTRAINT campanha_min_turnos_chk CHECK (min_turnos BETWEEN 1 AND 200),
    CONSTRAINT campanha_pesos_chk CHECK (
        peso_aceitacao BETWEEN 0 AND 100 AND peso_conclusao BETWEEN 0 AND 100
        AND peso_tempo BETWEEN 0 AND 100 AND peso_pedidos BETWEEN 0 AND 100
        AND peso_aceitacao + peso_conclusao + peso_tempo + peso_pedidos = 100
    ),
    CONSTRAINT campanha_cortes_chk CHECK (
        (corte_aceitacao IS NULL OR (corte_aceitacao BETWEEN 0 AND 1 AND peso_aceitacao > 0))
        AND (corte_conclusao IS NULL OR (corte_conclusao BETWEEN 0 AND 1 AND peso_conclusao > 0))
        AND (corte_tempo IS NULL OR (corte_tempo BETWEEN 0 AND 1 AND peso_tempo > 0))
        AND (corte_pedidos IS NULL OR (corte_pedidos BETWEEN 1 AND 100000 AND peso_pedidos > 0))
    ),
    CONSTRAINT campanha_ciclo_chk CHECK (
        (cancelada_em IS NULL OR lancada_em IS NOT NULL)
        AND (fechada_em IS NULL OR lancada_em IS NOT NULL)
        AND ((cancelada_em IS NULL) = (motivo_cancelamento IS NULL))
        AND (motivo_cancelamento IS NULL OR char_length(motivo_cancelamento) BETWEEN 5 AND 500)
    )
);

-- Campanhas ativas da entidade: teto (A11), recálculo e aviso varrem só isto.
CREATE INDEX IF NOT EXISTS idx_campanha_ativas
    ON "Campanha" (id_empresa)
    WHERE lancada_em IS NOT NULL AND cancelada_em IS NULL AND fechada_em IS NULL;
CREATE INDEX IF NOT EXISTS idx_campanha_empresa_inicio ON "Campanha" (id_empresa, data_inicio DESC);

CREATE TABLE IF NOT EXISTS "CampanhaPremio" (
    id              serial PRIMARY KEY,
    campanha_id     int NOT NULL REFERENCES "Campanha"(id) ON DELETE CASCADE,
    id_empresa      int NOT NULL,
    posicao_de      smallint NOT NULL,
    posicao_ate     smallint NOT NULL,
    tipo            text NOT NULL,
    descricao       text NOT NULL,
    valor_centavos  int NULL,
    foto            bytea NULL,
    foto_mime       text NULL,
    CONSTRAINT campanhapremio_faixa_chk CHECK (posicao_de >= 1 AND posicao_de <= posicao_ate AND posicao_ate <= 500),
    CONSTRAINT campanhapremio_tipo_chk CHECK (tipo IN ('objeto', 'dinheiro')),
    CONSTRAINT campanhapremio_descricao_chk CHECK (char_length(descricao) BETWEEN 1 AND 200),
    -- 500000 = TETO_CENTAVOS do Lançamento externo (lib/lancamento-externo.js); objeto: só estimativa.
    CONSTRAINT campanhapremio_valor_chk CHECK (
        (tipo = 'dinheiro' AND valor_centavos BETWEEN 1 AND 500000)
        OR (tipo = 'objeto' AND (valor_centavos IS NULL OR valor_centavos >= 0))
    ),
    CONSTRAINT campanhapremio_foto_chk CHECK (
        (foto IS NULL AND foto_mime IS NULL)
        OR (foto IS NOT NULL AND foto_mime IN ('image/jpeg', 'image/png', 'image/webp') AND octet_length(foto) <= 512000)
    )
);
CREATE INDEX IF NOT EXISTS idx_campanhapremio_campanha ON "CampanhaPremio" (campanha_id);

CREATE TABLE IF NOT EXISTS "CampanhaRanking" (
    campanha_id          int NOT NULL REFERENCES "Campanha"(id) ON DELETE CASCADE,
    entregador_id        int NOT NULL REFERENCES "Entregador"(id),
    id_empresa           int NOT NULL,
    turnos               int NOT NULL,
    ofertadas            bigint NOT NULL,
    aceitas              bigint NOT NULL,
    completadas          bigint NOT NULL,
    pedidos              bigint NULL,
    online_epoch         double precision NULL,
    periodo_epoch        double precision NULL,
    -- leituras (fração 0..1), guardadas para que a fórmula exista só no recálculo
    aceitacao            numeric(9,6) NULL,
    conclusao            numeric(9,6) NULL,
    tempo                numeric(9,6) NULL,
    nota                 numeric(6,2) NULL,
    nota_hipotetica      numeric(6,2) NULL,
    posicao              int NULL,
    posicao_anterior     int NULL,
    posicao_hipotetica   int NULL,
    situacao             text NOT NULL,
    motivo_corte         text[] NOT NULL DEFAULT '{}',
    modal                text NULL,
    atualizado_em        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (campanha_id, entregador_id),
    CONSTRAINT campanharanking_situacao_chk
        CHECK (situacao IN ('classificado', 'abaixo_corte', 'sem_minimo', 'sem_modal'))
);
CREATE INDEX IF NOT EXISTS idx_campanharanking_situacao_posicao
    ON "CampanhaRanking" (campanha_id, situacao, posicao);

CREATE TABLE IF NOT EXISTS "CampanhaVencedor" (
    campanha_id    int NOT NULL REFERENCES "Campanha"(id),
    posicao        int NOT NULL,
    id_empresa     int NOT NULL,
    entregador_id  int NOT NULL REFERENCES "Entregador"(id),
    premio_id      int NOT NULL REFERENCES "CampanhaPremio"(id),
    entregue_em    timestamptz NULL,
    entregue_por   int NULL REFERENCES "Usuario"(id),
    observacao     text NULL,
    exportado_em   timestamptz NULL,
    criado_em      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (campanha_id, posicao),
    CONSTRAINT campanhavencedor_obs_chk CHECK (observacao IS NULL OR char_length(observacao) <= 500)
);

-- ═══════════════════════════════════════════════════════════════════════
-- 3. Gatilhos de imutabilidade (o BANCO decide; a tela é só a segunda trava)
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION hub_campanha_imutavel_trg()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    -- única coisa que pode mudar depois de lançada; coluna nova nasce IMUTÁVEL por padrão
    v_livres text[] := ARRAY['cancelada_por', 'cancelada_em', 'motivo_cancelamento', 'fechada_em',
                             'dados_ate', 'aviso_inicio_em', 'aviso_fim_em'];
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.lancada_em IS NOT NULL THEN
            RAISE EXCEPTION 'CAMPANHA_IMUTAVEL' USING ERRCODE = '55000';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.lancada_em IS NULL THEN
        RETURN NEW;   -- rascunho: livre
    END IF;

    -- cancelada/fechada não voltam atrás
    IF (OLD.cancelada_em IS NOT NULL AND NEW.cancelada_em IS DISTINCT FROM OLD.cancelada_em)
       OR (OLD.fechada_em IS NOT NULL AND NEW.fechada_em IS DISTINCT FROM OLD.fechada_em) THEN
        RAISE EXCEPTION 'CAMPANHA_IMUTAVEL' USING ERRCODE = '55000';
    END IF;

    IF (to_jsonb(NEW) - v_livres) IS DISTINCT FROM (to_jsonb(OLD) - v_livres) THEN
        RAISE EXCEPTION 'CAMPANHA_IMUTAVEL' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_campanha_imutavel ON "Campanha";
CREATE TRIGGER trg_campanha_imutavel
    BEFORE UPDATE OR DELETE ON "Campanha"
    FOR EACH ROW EXECUTE FUNCTION hub_campanha_imutavel_trg();

-- Prêmio: com a campanha lançada, NADA muda (nem INSERT, UPDATE, DELETE ou foto).
CREATE OR REPLACE FUNCTION hub_campanha_premio_imutavel_trg()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_campanha int := CASE WHEN TG_OP = 'DELETE' THEN OLD.campanha_id ELSE NEW.campanha_id END;
BEGIN
    IF EXISTS (SELECT 1 FROM "Campanha" c WHERE c.id = v_campanha AND c.lancada_em IS NOT NULL) THEN
        RAISE EXCEPTION 'CAMPANHA_IMUTAVEL' USING ERRCODE = '55000';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS trg_campanhapremio_imutavel ON "CampanhaPremio";
CREATE TRIGGER trg_campanhapremio_imutavel
    BEFORE INSERT OR UPDATE OR DELETE ON "CampanhaPremio"
    FOR EACH ROW EXECUTE FUNCTION hub_campanha_premio_imutavel_trg();

-- Vencedor: gravado UMA vez no fechamento; só entrega/exportação mudam; nunca apaga.
CREATE OR REPLACE FUNCTION hub_campanha_vencedor_trg()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_livres text[] := ARRAY['entregue_em', 'entregue_por', 'observacao', 'exportado_em'];
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'CAMPANHA_IMUTAVEL' USING ERRCODE = '55000';
    END IF;
    IF (to_jsonb(NEW) - v_livres) IS DISTINCT FROM (to_jsonb(OLD) - v_livres) THEN
        RAISE EXCEPTION 'CAMPANHA_IMUTAVEL' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_campanhavencedor_imutavel ON "CampanhaVencedor";
CREATE TRIGGER trg_campanhavencedor_imutavel
    BEFORE UPDATE OR DELETE ON "CampanhaVencedor"
    FOR EACH ROW EXECUTE FUNCTION hub_campanha_vencedor_trg();

-- ═══════════════════════════════════════════════════════════════════════
-- 4. RLS por id_empresa + GRANT mínimo
-- ═══════════════════════════════════════════════════════════════════════
-- Escrita: SÓ pelas RPCs SECURITY DEFINER (nenhum INSERT/UPDATE/DELETE para `authenticated`).
-- Leitura direta: dentro do escopo do token. Motorista (claim sem `escopo`) não lê nada direto.

ALTER TABLE "Campanha"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CampanhaPremio"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CampanhaRanking"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CampanhaVencedor" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS campanha_select_por_escopo ON "Campanha";
CREATE POLICY campanha_select_por_escopo ON "Campanha"
    FOR SELECT USING (id_empresa = ANY (hub_jwt_escopo_ids()));
DROP POLICY IF EXISTS campanhapremio_select_por_escopo ON "CampanhaPremio";
CREATE POLICY campanhapremio_select_por_escopo ON "CampanhaPremio"
    FOR SELECT USING (id_empresa = ANY (hub_jwt_escopo_ids()));
DROP POLICY IF EXISTS campanharanking_select_por_escopo ON "CampanhaRanking";
CREATE POLICY campanharanking_select_por_escopo ON "CampanhaRanking"
    FOR SELECT USING (id_empresa = ANY (hub_jwt_escopo_ids()));
DROP POLICY IF EXISTS campanhavencedor_select_por_escopo ON "CampanhaVencedor";
CREATE POLICY campanhavencedor_select_por_escopo ON "CampanhaVencedor"
    FOR SELECT USING (id_empresa = ANY (hub_jwt_escopo_ids()));

REVOKE ALL ON "Campanha", "CampanhaPremio", "CampanhaRanking", "CampanhaVencedor" FROM PUBLIC;
REVOKE ALL ON "Campanha", "CampanhaPremio", "CampanhaRanking", "CampanhaVencedor" FROM authenticated;
GRANT SELECT ON "Campanha", "CampanhaRanking", "CampanhaVencedor" TO authenticated;
-- GRANT por coluna: `foto` (bytea, até 500 KB) fica de fora — só as RPCs a servem.
GRANT SELECT (id, campanha_id, id_empresa, posicao_de, posicao_ate, tipo, descricao, valor_centavos, foto_mime)
    ON "CampanhaPremio" TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 5. Notificação: hub_notificacao_enfileirar (extraída da 0068) + allowlist do link
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE "NotificacaoMotorista" DROP CONSTRAINT IF EXISTS notificacaomotorista_link_chk;
ALTER TABLE "NotificacaoMotorista" ADD CONSTRAINT notificacaomotorista_link_chk CHECK (
    link IS NULL
    OR link IN ('/adiantamento', '/conta-bancaria', '/repasse')
    OR link ~ '^/adiantamento/[0-9]+$'
    OR link ~ '^/avisos/[0-9]+$'
    OR link ~ '^/campanhas/[0-9]+$'
);

-- Cria Aviso(origem='sistema', na_fila) + NotificacaoMotorista para cada CNPJ + AvisoEntrega para quem
-- tem push (a varredura de 60 s entrega). Interna (sem GRANT): decide o QUÊ e PARA QUEM, não SE pode.
CREATE OR REPLACE FUNCTION hub_notificacao_enfileirar(
    p_id_empresa int,
    p_modo       text,
    p_ids        int[],
    p_cnpjs      text[],
    p_categoria  text,
    p_titulo     text,
    p_corpo      text,
    p_link       text
)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_aviso_id int;
    v_entregas int;
BEGIN
    INSERT INTO "Aviso" (
        id_empresa, titulo, corpo, modo_destinatarios, destinatarios_ids,
        chave_idempotencia, criado_por, origem, categoria
    )
    VALUES (
        p_id_empresa, p_titulo, p_corpo, p_modo, p_ids,
        gen_random_uuid(), NULL, 'sistema', p_categoria
    )
    RETURNING id INTO v_aviso_id;

    INSERT INTO "NotificacaoMotorista" (cnpj_prestador, categoria, titulo, corpo, link, aviso_id)
    SELECT DISTINCT x.cnpj, p_categoria, p_titulo, p_corpo, p_link, v_aviso_id
    FROM unnest(p_cnpjs) AS x(cnpj)
    ON CONFLICT (aviso_id, cnpj_prestador) DO NOTHING;

    INSERT INTO "AvisoEntrega" (aviso_id, inscricao_id, cnpj_prestador)
    SELECT v_aviso_id, pi.id, pi.cnpj_prestador
    FROM "PushInscricao" pi
    WHERE pi.cnpj_prestador = ANY (p_cnpjs);

    GET DIAGNOSTICS v_entregas = ROW_COUNT;

    IF v_entregas = 0 THEN
        UPDATE "Aviso" SET status = 'concluido', concluido_em = now() WHERE id = v_aviso_id;
    END IF;

    RETURN v_aviso_id;
END;
$$;

REVOKE ALL ON FUNCTION hub_notificacao_enfileirar(int, text, int[], text[], text, text, text, text) FROM PUBLIC;

-- hub_adiantamento_notificar: IDÊNTICA à 0068 (mesmos eventos, textos, destinatário), exceto o bloco
-- final de gravação, que agora é a chamada a hub_notificacao_enfileirar. Privilégios preservados
-- (CREATE OR REPLACE da mesma assinatura não os altera; REVOKE FROM PUBLIC repetido por segurança).
CREATE OR REPLACE FUNCTION hub_adiantamento_notificar(
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

    PERFORM hub_notificacao_enfileirar(
        v_id_empresa, 'individual', ARRAY[v_entregador], ARRAY[v_cnpj],
        v_categoria, v_titulo, v_corpo, v_link
    );
END;
$$;

REVOKE ALL ON FUNCTION hub_adiantamento_notificar(bigint, text, int) FROM PUBLIC;

-- ═══════════════════════════════════════════════════════════════════════
-- 6. RBAC: módulo, permissões, papéis; tipo de lançamento externo
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO "Modulo" (codigo, nome, ordem) VALUES ('campanhas', 'Campanhas', 45)
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO "Permissao" (codigo, modulo_id)
SELECT perm.codigo, m.id
FROM "Modulo" m, (VALUES ('campanhas.consultar'), ('campanhas.gerir'), ('campanhas.entregar')) AS perm(codigo)
WHERE m.codigo = 'campanhas'
ON CONFLICT (codigo) DO NOTHING;

-- ⚠️ financeiro e financeiro_aprovador IDÊNTICOS (0115): editar a matriz de um exige espelhar no outro.
INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT p.id, perm.id
FROM "Papel" p
CROSS JOIN "Permissao" perm
WHERE p.nome IN ('admin_entidade', 'financeiro', 'financeiro_aprovador')
  AND perm.codigo IN ('campanhas.consultar', 'campanhas.gerir', 'campanhas.entregar')
ON CONFLICT DO NOTHING;

INSERT INTO "LancamentoExternoTipo" (codigo, sinal, descricao) VALUES
    ('PREMIO_CAMPANHA', 1, 'Prêmio em dinheiro de campanha do motorista: soma ao repasse da semana')
ON CONFLICT (codigo) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════
-- 7. Helpers internos (sem GRANT)
-- ═══════════════════════════════════════════════════════════════════════

-- Escopo (a empresa ∈ escopo E é a empresa ativa) + permissão. Fail-closed.
CREATE OR REPLACE FUNCTION hub_campanha_autoriza(p_id_empresa int, p_perm text)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_id_empresa IS NULL
       OR NOT (p_id_empresa = ANY (hub_jwt_escopo_ids()))
       OR p_id_empresa IS DISTINCT FROM NULLIF(hub_jwt_claims() ->> 'empresa_ativa', '')::int THEN
        RAISE EXCEPTION 'FORA_DE_ESCOPO' USING ERRCODE = '42501';
    END IF;
    IF NOT hub_adiantamento_tem_permissao(p_perm) THEN
        RAISE EXCEPTION 'PERMISSAO_NEGADA' USING ERRCODE = '42501';
    END IF;
END;
$$;

-- Carrega a campanha (404 para id inexistente OU fora do escopo — não vaza existência) e autoriza.
CREATE OR REPLACE FUNCTION hub_campanha_carregar(p_id int, p_perm text, p_travar boolean DEFAULT false)
RETURNS "Campanha"
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    c "Campanha";
BEGIN
    IF p_travar THEN
        SELECT * INTO c FROM "Campanha" WHERE id = p_id FOR UPDATE;
    ELSE
        SELECT * INTO c FROM "Campanha" WHERE id = p_id;
    END IF;
    IF NOT FOUND OR NOT (c.id_empresa = ANY (hub_jwt_escopo_ids())) THEN
        RAISE EXCEPTION 'CAMPANHA_NAO_ENCONTRADA' USING ERRCODE = 'P0002';
    END IF;
    PERFORM hub_campanha_autoriza(c.id_empresa, p_perm);
    RETURN c;
END;
$$;

CREATE OR REPLACE FUNCTION hub_campanha_situacao(c "Campanha")
RETURNS text
LANGUAGE sql STABLE
AS $$
    SELECT CASE
        WHEN c.cancelada_em IS NOT NULL THEN 'cancelada'
        WHEN c.lancada_em IS NULL THEN 'rascunho'
        WHEN c.fechada_em IS NOT NULL THEN 'encerrada'
        WHEN hub_hoje_sp() < c.data_inicio THEN 'agendada'
        WHEN hub_hoje_sp() <= c.data_fim THEN 'em_andamento'
        ELSE 'apurando'
    END;
$$;

-- Lista JSON -> text[] canônico (NULL = todos). Qualquer defeito -> VALIDACAO com o campo.
CREATE OR REPLACE FUNCTION hub_campanha_lista_json(p jsonb, p_campo text)
RETURNS text[]
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
    v text[];
BEGIN
    IF p IS NULL OR jsonb_typeof(p) = 'null' THEN RETURN NULL; END IF;
    IF jsonb_typeof(p) <> 'array' OR EXISTS (SELECT 1 FROM jsonb_array_elements(p) e WHERE jsonb_typeof(e) <> 'string') THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = p_campo;
    END IF;
    SELECT array_agg(DISTINCT upper(btrim(x)) ORDER BY upper(btrim(x))) INTO v FROM jsonb_array_elements_text(p) x;
    IF v IS NULL OR NOT hub_campanha_lista_ok(v) THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = p_campo;
    END IF;
    RETURN v;
END;
$$;

-- Número de um campo JSON: NULL se ausente/null e não obrigatório; tipo/faixa/inteiro violados -> VALIDACAO.
CREATE OR REPLACE FUNCTION hub_campanha_num(
    p jsonb, p_campo text, p_min numeric, p_max numeric, p_inteiro boolean, p_obrigatorio boolean
)
RETURNS numeric
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
    v numeric;
BEGIN
    IF p IS NULL OR jsonb_typeof(p) = 'null' THEN
        IF p_obrigatorio THEN RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = p_campo; END IF;
        RETURN NULL;
    END IF;
    IF jsonb_typeof(p) <> 'number' THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = p_campo;
    END IF;
    v := (p #>> '{}')::numeric;
    IF v < p_min OR v > p_max OR (p_inteiro AND v <> trunc(v)) THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = p_campo;
    END IF;
    RETURN v;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 8. RPCs do hub — formulário
-- ═══════════════════════════════════════════════════════════════════════

-- Prêmios do formulário (jsonb camelCase) como linhas. Cast inválido levanta erro de tipo — quem chama
-- (hub_campanha_salvar) converte em VALIDACAO.
CREATE OR REPLACE FUNCTION hub_campanha_premios_in(p jsonb)
RETURNS TABLE (id int, de int, ate int, tipo text, descricao text, valor int, n bigint)
LANGUAGE sql IMMUTABLE
AS $$
    SELECT x.id, x."posicaoDe", x."posicaoAte", x.tipo, btrim(x.descricao), x."valorCentavos", x.n
    FROM ROWS FROM (jsonb_to_recordset(p) AS (id int, "posicaoDe" int, "posicaoAte" int, tipo text, descricao text, "valorCentavos" int))
         WITH ORDINALITY AS x(id, "posicaoDe", "posicaoAte", tipo, descricao, "valorCentavos", n);
$$;

CREATE OR REPLACE FUNCTION hub_campanha_salvar(p_id_empresa int, p_id int, p_dados jsonb)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_sub        int := NULLIF(hub_jwt_claims() ->> 'sub', '')::int;
    c            "Campanha";
    v_id         int;
    v_nome       text := btrim(p_dados ->> 'nome');
    v_desc       text := COALESCE(btrim(p_dados ->> 'descricao'), '');
    v_ini        date;
    v_fim        date;
    v_pracas     text[];
    v_turnos     text[];
    v_modais     text[];
    v_min        int;
    v_pa         int; v_pc int; v_pt int; v_pp int;
    v_ca         numeric(5,4); v_cc numeric(5,4); v_ct numeric(5,4);
    v_cp         int;
    v_avisar     boolean;
    v_premios    jsonb := p_dados -> 'premios';
BEGIN
    PERFORM hub_campanha_autoriza(p_id_empresa, 'campanhas.gerir');

    IF p_id IS NOT NULL THEN
        c := hub_campanha_carregar(p_id, 'campanhas.gerir', true);
        IF c.id_empresa <> p_id_empresa THEN
            RAISE EXCEPTION 'CAMPANHA_NAO_ENCONTRADA' USING ERRCODE = 'P0002';
        END IF;
        IF c.lancada_em IS NOT NULL THEN
            RAISE EXCEPTION 'CAMPANHA_IMUTAVEL' USING ERRCODE = '55000';
        END IF;
    END IF;

    IF v_nome IS NULL OR char_length(v_nome) NOT BETWEEN 3 AND 120 THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'nome';
    END IF;
    IF char_length(v_desc) > 1000 THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'descricao';
    END IF;

    BEGIN
        v_ini := (p_dados ->> 'dataInicio')::date;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'dataInicio';
    END;
    BEGIN
        v_fim := (p_dados ->> 'dataFim')::date;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'dataFim';
    END;
    IF v_ini IS NULL THEN RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'dataInicio'; END IF;
    IF v_fim IS NULL OR v_fim < v_ini OR v_fim - v_ini > 91 THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'dataFim';
    END IF;

    v_pracas := hub_campanha_lista_json(p_dados -> 'pracas', 'pracas');
    v_turnos := hub_campanha_lista_json(p_dados -> 'turnos', 'turnos');
    v_modais := hub_campanha_lista_json(p_dados -> 'modais', 'modais');

    v_min := hub_campanha_num(p_dados -> 'minTurnos', 'minTurnos', 1, 200, true, true);

    -- pesos: ausente = 0; fora de 0..100 ou soma ≠ 100 -> PESOS_INVALIDOS
    v_pa := COALESCE(hub_campanha_num(p_dados #> '{pesos,aceitacao}', 'pesos.aceitacao', -1000, 1000, true, false), 0);
    v_pc := COALESCE(hub_campanha_num(p_dados #> '{pesos,conclusao}', 'pesos.conclusao', -1000, 1000, true, false), 0);
    v_pt := COALESCE(hub_campanha_num(p_dados #> '{pesos,tempo}',     'pesos.tempo',     -1000, 1000, true, false), 0);
    v_pp := COALESCE(hub_campanha_num(p_dados #> '{pesos,pedidos}',   'pesos.pedidos',   -1000, 1000, true, false), 0);
    IF LEAST(v_pa, v_pc, v_pt, v_pp) < 0 OR GREATEST(v_pa, v_pc, v_pt, v_pp) > 100 OR v_pa + v_pc + v_pt + v_pp <> 100 THEN
        RAISE EXCEPTION 'PESOS_INVALIDOS' USING ERRCODE = '22023';
    END IF;

    v_ca := round(hub_campanha_num(p_dados #> '{cortes,aceitacao}', 'cortes.aceitacao', 0, 1, false, false), 4);
    v_cc := round(hub_campanha_num(p_dados #> '{cortes,conclusao}', 'cortes.conclusao', 0, 1, false, false), 4);
    v_ct := round(hub_campanha_num(p_dados #> '{cortes,tempo}',     'cortes.tempo',     0, 1, false, false), 4);
    v_cp := hub_campanha_num(p_dados #> '{cortes,pedidos}', 'cortes.pedidos', 1, 100000, true, false);
    IF (v_ca IS NOT NULL AND v_pa = 0) OR (v_cc IS NOT NULL AND v_pc = 0)
       OR (v_ct IS NOT NULL AND v_pt = 0) OR (v_cp IS NOT NULL AND v_pp = 0) THEN
        RAISE EXCEPTION 'CORTE_SEM_PESO' USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(p_dados -> 'avisar') = 'boolean' THEN v_avisar := (p_dados ->> 'avisar')::boolean;
    ELSIF p_dados -> 'avisar' IS NULL THEN v_avisar := true;
    ELSE RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'avisar';
    END IF;

    -- prêmios: 1..20 faixas
    IF v_premios IS NULL OR jsonb_typeof(v_premios) <> 'array' OR jsonb_array_length(v_premios) NOT BETWEEN 1 AND 20 THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'premios';
    END IF;
    BEGIN
        PERFORM 1 FROM hub_campanha_premios_in(v_premios);
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'premios';
    END;
    IF EXISTS (
        SELECT 1 FROM hub_campanha_premios_in(v_premios)
        WHERE de IS NULL OR ate IS NULL OR de < 1 OR de > ate OR ate > 500
           OR tipo IS NULL OR tipo NOT IN ('objeto', 'dinheiro')
           OR descricao IS NULL OR char_length(descricao) NOT BETWEEN 1 AND 200
           OR (tipo = 'dinheiro' AND (valor IS NULL OR valor NOT BETWEEN 1 AND 500000))
           OR (tipo = 'objeto' AND valor IS NOT NULL AND valor < 0)
    ) THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'premios';
    END IF;
    IF EXISTS (
        SELECT 1 FROM hub_campanha_premios_in(v_premios) a JOIN hub_campanha_premios_in(v_premios) b
          ON a.n < b.n AND a.de <= b.ate AND b.de <= a.ate
    ) THEN
        RAISE EXCEPTION 'FAIXAS_SOBREPOSTAS' USING ERRCODE = '22023';
    END IF;

    IF p_id IS NULL THEN
        INSERT INTO "Campanha" (
            id_empresa, nome, descricao, data_inicio, data_fim, pracas, turnos, modais, min_turnos,
            peso_aceitacao, peso_conclusao, peso_tempo, peso_pedidos,
            corte_aceitacao, corte_conclusao, corte_tempo, corte_pedidos, avisar, criada_por)
        VALUES (
            p_id_empresa, v_nome, v_desc, v_ini, v_fim, v_pracas, v_turnos, v_modais, v_min,
            v_pa, v_pc, v_pt, v_pp, v_ca, v_cc, v_ct, v_cp, v_avisar, v_sub)
        RETURNING id INTO v_id;
    ELSE
        v_id := p_id;
        UPDATE "Campanha" SET
            nome = v_nome, descricao = v_desc, data_inicio = v_ini, data_fim = v_fim,
            pracas = v_pracas, turnos = v_turnos, modais = v_modais, min_turnos = v_min,
            peso_aceitacao = v_pa, peso_conclusao = v_pc, peso_tempo = v_pt, peso_pedidos = v_pp,
            corte_aceitacao = v_ca, corte_conclusao = v_cc, corte_tempo = v_ct, corte_pedidos = v_cp,
            avisar = v_avisar
        WHERE id = v_id;
    END IF;

    -- Prêmios: o que veio com `id` desta campanha é ATUALIZADO (a foto sobrevive); o resto é criado;
    -- o que ficou de fora é apagado. Rascunho apenas (o gatilho recusa qualquer escrita após lançar).
    DELETE FROM "CampanhaPremio" pr
    WHERE pr.campanha_id = v_id AND pr.id NOT IN (SELECT i.id FROM hub_campanha_premios_in(v_premios) i WHERE i.id IS NOT NULL);
    UPDATE "CampanhaPremio" pr SET posicao_de = i.de, posicao_ate = i.ate, tipo = i.tipo,
           descricao = i.descricao, valor_centavos = i.valor
    FROM hub_campanha_premios_in(v_premios) i
    WHERE pr.campanha_id = v_id AND pr.id = i.id;
    INSERT INTO "CampanhaPremio" (campanha_id, id_empresa, posicao_de, posicao_ate, tipo, descricao, valor_centavos)
    SELECT v_id, p_id_empresa, i.de, i.ate, i.tipo, i.descricao, i.valor
    FROM hub_campanha_premios_in(v_premios) i
    WHERE i.id IS NULL OR NOT EXISTS (SELECT 1 FROM "CampanhaPremio" pr WHERE pr.id = i.id AND pr.campanha_id = v_id);

    RETURN v_id;
END;
$$;

-- Opções do formulário + cobertura de pedidos + alcance (CONTRATOS §6).
CREATE OR REPLACE FUNCTION hub_campanha_opcoes(p_id_empresa int, p_pracas text[], p_turnos text[], p_modais text[])
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_hoje    date := hub_hoje_sp();
    v_d30     date := hub_hoje_sp() - 29;
    v_d60     date := hub_hoje_sp() - 59;
    v_pracas  text[] := (SELECT array_agg(DISTINCT upper(btrim(x))) FROM unnest(p_pracas) x);
    v_turnos  text[] := (SELECT array_agg(DISTINCT upper(btrim(x))) FROM unnest(p_turnos) x);
    v_modais  text[] := (SELECT array_agg(DISTINCT upper(btrim(x))) FROM unnest(p_modais) x);
    j_pracas  jsonb;
    j_turnos  jsonb;
    j_modais  jsonb;
    v_cob     numeric;
    v_rodaram int;
    v_sem     int;
BEGIN
    PERFORM hub_campanha_autoriza(p_id_empresa, 'campanhas.gerir');

    -- Distintos por varredura de índice "solta" (CTE recursiva: 1 sonda por valor distinto, não por linha) sobre
    -- os índices que já existem: (id_empresa, subpraca, ...) em "PerformanceTurno" e (id_empresa, periodo, ...)
    -- na MV; a janela de 60 dias é uma sonda EXISTS por valor. Medido sob 900k turnos: ~2 s -> ~0,1 s.
    SELECT COALESCE(jsonb_agg(s.x ORDER BY s.x), '[]'::jsonb) INTO j_pracas
    FROM (
        SELECT DISTINCT upper(btrim(r.v)) AS x
        FROM (
            WITH RECURSIVE r AS (
                (SELECT pt.subpraca AS v FROM "PerformanceTurno" pt
                 WHERE pt.id_empresa = p_id_empresa AND pt.subpraca IS NOT NULL ORDER BY pt.subpraca LIMIT 1)
                UNION ALL
                SELECT (SELECT pt.subpraca FROM "PerformanceTurno" pt
                        WHERE pt.id_empresa = p_id_empresa AND pt.subpraca > r.v ORDER BY pt.subpraca LIMIT 1)
                FROM r WHERE r.v IS NOT NULL
            )
            SELECT r.v FROM r WHERE r.v IS NOT NULL
        ) r
        WHERE NULLIF(btrim(r.v), '') IS NOT NULL
          AND EXISTS (SELECT 1 FROM "PerformanceTurno" pt
                      WHERE pt.id_empresa = p_id_empresa AND pt.subpraca = r.v AND pt.data_periodo >= v_d60)
    ) s;

    SELECT COALESCE(jsonb_agg(s.x ORDER BY s.x), '[]'::jsonb) INTO j_turnos
    FROM (
        SELECT DISTINCT upper(btrim(r.v)) AS x
        FROM (
            WITH RECURSIVE r AS (
                (SELECT mv.periodo AS v FROM mv_performance_dia mv
                 WHERE mv.id_empresa = p_id_empresa ORDER BY mv.periodo LIMIT 1)
                UNION ALL
                SELECT (SELECT mv.periodo FROM mv_performance_dia mv
                        WHERE mv.id_empresa = p_id_empresa AND mv.periodo > r.v ORDER BY mv.periodo LIMIT 1)
                FROM r WHERE r.v IS NOT NULL
            )
            SELECT r.v FROM r WHERE r.v IS NOT NULL
        ) r
        WHERE NULLIF(btrim(r.v), '') IS NOT NULL
          AND EXISTS (SELECT 1 FROM mv_performance_dia mv
                      WHERE mv.id_empresa = p_id_empresa AND mv.periodo = r.v AND mv.data_periodo >= v_d60)
    ) s;

    -- modais: entregadores da empresa com turno nos últimos 60 dias (uma sonda por entregador)
    SELECT COALESCE(jsonb_agg(s.x ORDER BY s.x), '[]'::jsonb) INTO j_modais
    FROM (SELECT DISTINCT NULLIF(upper(btrim(e.dados_entrego_json -> 'informacoesEntrega' ->> 'modal')), '') AS x
          FROM "Entregador" e
          WHERE e.id_empresa = p_id_empresa
            AND EXISTS (SELECT 1 FROM mv_performance_dia mv
                        WHERE mv.id_empresa = p_id_empresa AND mv.entregador_id = e.id AND mv.data_periodo >= v_d60)) s
    WHERE s.x IS NOT NULL;

    -- Público dos últimos 30 dias (mesmo recorte do recálculo; praça por semi-join, nunca EXISTS correlacionado).
    -- Agrega POR ENTREGADOR antes de juntar (2k linhas no join em vez de 180k).
    WITH t AS (
        SELECT mv.entregador_id, count(*) AS n, count(mv.pedidos_concluidos) AS np
        FROM mv_performance_dia mv
        WHERE mv.id_empresa = p_id_empresa AND mv.data_periodo BETWEEN v_d30 AND v_hoje
          AND (v_turnos IS NULL OR upper(btrim(mv.periodo)) = ANY (v_turnos))
          AND (v_pracas IS NULL OR (mv.entregador_id, mv.data_periodo, mv.periodo) IN (
                  SELECT pt.entregador_id, pt.data_periodo, pt.periodo FROM "PerformanceTurno" pt
                  WHERE pt.id_empresa = p_id_empresa AND pt.data_periodo BETWEEN v_d30 AND v_hoje
                    AND upper(btrim(pt.subpraca)) = ANY (v_pracas)))
        GROUP BY mv.entregador_id
    ),
    m AS (
        SELECT t.*, NULLIF(upper(btrim(e.dados_entrego_json -> 'informacoesEntrega' ->> 'modal')), '') AS modal
        FROM t JOIN "Entregador" e ON e.id = t.entregador_id
    )
    SELECT
        (sum(np) FILTER (WHERE v_modais IS NULL OR modal = ANY (v_modais)))::numeric
            / NULLIF(sum(n) FILTER (WHERE v_modais IS NULL OR modal = ANY (v_modais)), 0),
        count(*),
        count(*) FILTER (WHERE modal IS NULL)
    INTO v_cob, v_rodaram, v_sem
    FROM m;

    RETURN jsonb_build_object(
        'pracas', j_pracas, 'turnos', j_turnos, 'modais', j_modais,
        'cobertura_pedidos', round(v_cob, 4),
        'alcance', jsonb_build_object('rodaram', COALESCE(v_rodaram, 0), 'sem_modal', COALESCE(v_sem, 0))
    );
END;
$$;

CREATE OR REPLACE FUNCTION hub_campanha_lancar(p_id int)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    c        "Campanha";
    v_sub    int := NULLIF(hub_jwt_claims() ->> 'sub', '')::int;
    v_op     jsonb;
    v_ativas int;
BEGIN
    c := hub_campanha_carregar(p_id, 'campanhas.gerir', true);
    IF hub_campanha_situacao(c) <> 'rascunho' THEN
        RAISE EXCEPTION 'CAMPANHA_SITUACAO_INVALIDA' USING ERRCODE = '55000';
    END IF;
    IF c.data_inicio < hub_hoje_sp() THEN
        RAISE EXCEPTION 'INICIO_NO_PASSADO' USING ERRCODE = '22023';
    END IF;

    -- prêmios: 1..20, sem sobreposição (revalida; o rascunho só passa pela RPC de salvar, mas é barato)
    IF NOT EXISTS (SELECT 1 FROM "CampanhaPremio" WHERE campanha_id = c.id) THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'premios';
    END IF;
    IF EXISTS (SELECT 1 FROM "CampanhaPremio" a JOIN "CampanhaPremio" b
                 ON a.campanha_id = b.campanha_id AND a.id < b.id AND a.posicao_de <= b.posicao_ate AND b.posicao_de <= a.posicao_ate
               WHERE a.campanha_id = c.id) THEN
        RAISE EXCEPTION 'FAIXAS_SOBREPOSTAS' USING ERRCODE = '22023';
    END IF;

    v_op := hub_campanha_opcoes(c.id_empresa, c.pracas, c.turnos, c.modais);
    IF (c.pracas IS NOT NULL AND EXISTS (
            SELECT 1 FROM unnest(c.pracas) x WHERE NOT (v_op -> 'pracas') ? x))
       OR (c.turnos IS NOT NULL AND EXISTS (
            SELECT 1 FROM unnest(c.turnos) x WHERE NOT (v_op -> 'turnos') ? x))
       OR (c.modais IS NOT NULL AND EXISTS (
            SELECT 1 FROM unnest(c.modais) x WHERE NOT (v_op -> 'modais') ? x)) THEN
        RAISE EXCEPTION 'OPCAO_DESCONHECIDA' USING ERRCODE = '22023';
    END IF;

    IF c.peso_pedidos > 0 AND COALESCE((v_op ->> 'cobertura_pedidos')::numeric, 0) < 0.95 THEN
        RAISE EXCEPTION 'PEDIDOS_SEM_COBERTURA' USING ERRCODE = '22023';
    END IF;

    -- teto A11 (serializado por entidade para duas chamadas simultâneas não furarem o teto)
    PERFORM pg_advisory_xact_lock(c.id_empresa, hashtext('hub_campanha_teto'));
    SELECT count(*) INTO v_ativas FROM "Campanha"
    WHERE id_empresa = c.id_empresa AND lancada_em IS NOT NULL AND cancelada_em IS NULL AND fechada_em IS NULL;
    IF v_ativas >= 10 THEN
        RAISE EXCEPTION 'TETO_CAMPANHAS_ATIVAS' USING ERRCODE = '55000';
    END IF;

    UPDATE "Campanha" SET lancada_em = now(), lancada_por = v_sub WHERE id = c.id;
END;
$$;

CREATE OR REPLACE FUNCTION hub_campanha_cancelar(p_id int, p_motivo text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    c        "Campanha";
    v_motivo text := btrim(p_motivo);
BEGIN
    c := hub_campanha_carregar(p_id, 'campanhas.gerir', true);
    IF v_motivo IS NULL OR char_length(v_motivo) NOT BETWEEN 5 AND 500 THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'motivo';
    END IF;
    IF hub_campanha_situacao(c) NOT IN ('agendada', 'em_andamento', 'apurando') THEN
        RAISE EXCEPTION 'CAMPANHA_SITUACAO_INVALIDA' USING ERRCODE = '55000';
    END IF;
    UPDATE "Campanha" SET cancelada_em = now(), cancelada_por = NULLIF(hub_jwt_claims() ->> 'sub', '')::int,
           motivo_cancelamento = v_motivo
    WHERE id = c.id;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 9. Cálculo (um caminho) e fechamento
-- ═══════════════════════════════════════════════════════════════════════

-- Interna (sem checagem de usuário): chamada pelo recálculo manual, pelas ativas e pelo fechamento.
CREATE OR REPLACE FUNCTION hub_campanha_recalcular_interno(p_id int)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_c     "Campanha";
    v_hoje  date := hub_hoje_sp();
    v_ate   date;
    v_t0    timestamptz := clock_timestamp();
    v_cont  jsonb;
    v_max   date;
    v_mesmo boolean;
BEGIN
    SELECT * INTO v_c FROM "Campanha" WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CAMPANHA_NAO_ENCONTRADA' USING ERRCODE = 'P0002'; END IF;
    v_ate := LEAST(v_c.data_fim, v_hoje);
    -- Último dia de dado da empresa (até data_fim). O robô importa 3x/dia com o MESMO dia: se `dados_ate`
    -- não andou, `posicao_anterior` é PRESERVADA (senão "subiu N posições desde ontem" zera na 2ª importação).
    SELECT max(mv.data_periodo) INTO v_max FROM mv_performance_dia mv
    WHERE mv.id_empresa = v_c.id_empresa AND mv.data_periodo <= v_c.data_fim;
    v_mesmo := v_c.dados_ate IS NOT NULL AND v_max IS NOT DISTINCT FROM v_c.dados_ate;

    WITH base AS (
        SELECT mv.entregador_id,
               count(*)::int                              AS turnos,
               sum(mv.corridas_ofertadas)::bigint         AS ofertadas,
               sum(mv.corridas_aceitas)::bigint           AS aceitas,
               sum(mv.corridas_completadas)::bigint       AS completadas,
               sum(mv.pedidos_concluidos)::bigint         AS pedidos,
               sum(mv.online_epoch)                       AS online_epoch,
               sum(mv.periodo_epoch)                      AS periodo_epoch
        FROM mv_performance_dia mv
        WHERE mv.id_empresa = v_c.id_empresa
          AND mv.data_periodo BETWEEN v_c.data_inicio AND v_ate
          AND (v_c.turnos IS NULL OR upper(btrim(mv.periodo)) = ANY (v_c.turnos))
          AND (v_c.pracas IS NULL OR (mv.entregador_id, mv.data_periodo, mv.periodo) IN (
                  SELECT pt.entregador_id, pt.data_periodo, pt.periodo
                  FROM "PerformanceTurno" pt
                  WHERE pt.id_empresa = v_c.id_empresa
                    AND pt.data_periodo BETWEEN v_c.data_inicio AND v_ate
                    AND upper(btrim(pt.subpraca)) = ANY (v_c.pracas)))
        GROUP BY mv.entregador_id
    ),
    ent AS (
        SELECT b.*, NULLIF(upper(btrim(e.dados_entrego_json -> 'informacoesEntrega' ->> 'modal')), '') AS modal
        FROM base b JOIN "Entregador" e ON e.id = b.entregador_id
    ),
    -- modal fora de `modais` não entra (nem é gravado); sem modal vira 'sem_modal'
    leit AS (
        SELECT ent.*,
               ent.aceitas::numeric / NULLIF(ent.ofertadas, 0)                       AS aceitacao,
               ent.completadas::numeric / NULLIF(ent.aceitas, 0)                     AS conclusao,
               LEAST(ent.online_epoch::numeric / NULLIF(ent.periodo_epoch, 0)::numeric, 1)    AS tempo
        FROM ent
        WHERE v_c.modais IS NULL OR ent.modal IS NULL OR ent.modal = ANY (v_c.modais)
    ),
    cls AS (
        SELECT l.*,
               array_remove(ARRAY[
                   CASE WHEN v_c.peso_aceitacao > 0 AND v_c.corte_aceitacao IS NOT NULL
                             AND (l.aceitacao IS NULL OR l.aceitacao < v_c.corte_aceitacao) THEN 'aceitacao' END,
                   CASE WHEN v_c.peso_conclusao > 0 AND v_c.corte_conclusao IS NOT NULL
                             AND (l.conclusao IS NULL OR l.conclusao < v_c.corte_conclusao) THEN 'conclusao' END,
                   CASE WHEN v_c.peso_tempo > 0 AND v_c.corte_tempo IS NOT NULL
                             AND (l.tempo IS NULL OR l.tempo < v_c.corte_tempo) THEN 'tempo' END,
                   CASE WHEN v_c.peso_pedidos > 0 AND v_c.corte_pedidos IS NOT NULL
                             AND (l.pedidos IS NULL OR l.pedidos < v_c.corte_pedidos) THEN 'pedidos' END
               ], NULL) AS motivo
        FROM leit l
    ),
    cls2 AS (
        SELECT cls.*,
               CASE WHEN v_c.modais IS NOT NULL AND cls.modal IS NULL THEN 'sem_modal'
                    WHEN cls.turnos < v_c.min_turnos THEN 'sem_minimo'
                    WHEN cardinality(cls.motivo) > 0 THEN 'abaixo_corte'
                    ELSE 'classificado' END AS sit
        FROM cls
    ),
    cls3 AS (
        SELECT cls2.*,
               max(cls2.pedidos) FILTER (WHERE cls2.sit = 'classificado') OVER () AS maxped
        FROM cls2
    ),
    nt AS (
        -- nota (ou nota hipotética) com a MESMA fórmula; pedidos relativo ao líder dos classificados
        SELECT cls3.*,
               round((v_c.peso_aceitacao * COALESCE(cls3.aceitacao, 0) * 100
                    + v_c.peso_conclusao * COALESCE(cls3.conclusao, 0) * 100
                    + v_c.peso_tempo * COALESCE(cls3.tempo, 0) * 100
                    + v_c.peso_pedidos * CASE WHEN cls3.maxped > 0
                                              THEN LEAST(COALESCE(cls3.pedidos, 0)::numeric / cls3.maxped * 100, 100)
                                              ELSE 0 END
                    ) / 100.0, 2) AS nref
        FROM cls3
    ),
    rk AS (
        SELECT nt.entregador_id,
               CASE WHEN nt.sit = 'classificado' THEN
                   row_number() OVER (PARTITION BY nt.sit ORDER BY nt.nref DESC, nt.pedidos DESC NULLS LAST,
                                      nt.tempo DESC NULLS LAST, nt.entregador_id ASC)
               END AS posicao,
               -- 1 + quantos classificados têm nota ESTRITAMENTE maior (empates não empurram)
               CASE WHEN nt.sit = 'abaixo_corte' THEN
                   1 + (count(*) FILTER (WHERE nt.sit = 'classificado') OVER (ORDER BY nt.nref DESC)
                      - count(*) FILTER (WHERE nt.sit = 'classificado') OVER (PARTITION BY nt.nref))
               END AS poship
        FROM nt
        WHERE nt.sit IN ('classificado', 'abaixo_corte')
    ),
    fin AS (
        SELECT nt.*, rk.posicao, rk.poship
        FROM nt LEFT JOIN rk ON rk.entregador_id = nt.entregador_id
    ),
    up AS (
        INSERT INTO "CampanhaRanking" AS r (
            campanha_id, entregador_id, id_empresa, turnos, ofertadas, aceitas, completadas, pedidos,
            online_epoch, periodo_epoch, aceitacao, conclusao, tempo,
            nota, nota_hipotetica, posicao, posicao_hipotetica, situacao, motivo_corte, modal, atualizado_em)
        SELECT v_c.id, f.entregador_id, v_c.id_empresa, f.turnos, f.ofertadas, f.aceitas, f.completadas, f.pedidos,
               f.online_epoch, f.periodo_epoch, round(f.aceitacao, 6), round(f.conclusao, 6), round(f.tempo, 6),
               CASE WHEN f.sit = 'classificado' THEN f.nref END,
               CASE WHEN f.sit = 'abaixo_corte' THEN f.nref END,
               f.posicao, f.poship, f.sit, f.motivo, f.modal, now()
        FROM fin f
        ON CONFLICT (campanha_id, entregador_id) DO UPDATE SET
            id_empresa = EXCLUDED.id_empresa, turnos = EXCLUDED.turnos, ofertadas = EXCLUDED.ofertadas,
            aceitas = EXCLUDED.aceitas, completadas = EXCLUDED.completadas, pedidos = EXCLUDED.pedidos,
            online_epoch = EXCLUDED.online_epoch, periodo_epoch = EXCLUDED.periodo_epoch,
            aceitacao = EXCLUDED.aceitacao, conclusao = EXCLUDED.conclusao, tempo = EXCLUDED.tempo,
            nota = EXCLUDED.nota, nota_hipotetica = EXCLUDED.nota_hipotetica,
            posicao_anterior = CASE WHEN v_mesmo THEN r.posicao_anterior ELSE r.posicao END,
            posicao = EXCLUDED.posicao, posicao_hipotetica = EXCLUDED.posicao_hipotetica,
            situacao = EXCLUDED.situacao, motivo_corte = EXCLUDED.motivo_corte, modal = EXCLUDED.modal,
            atualizado_em = EXCLUDED.atualizado_em
        RETURNING 1
    ),
    del AS (
        DELETE FROM "CampanhaRanking" r
        WHERE r.campanha_id = v_c.id
          AND NOT EXISTS (SELECT 1 FROM fin f WHERE f.entregador_id = r.entregador_id)
        RETURNING 1
    )
    SELECT COALESCE(jsonb_object_agg(s.sit, s.n), '{}'::jsonb)
    INTO v_cont
    FROM (SELECT f.sit, count(*) AS n FROM fin f GROUP BY f.sit) s;

    UPDATE "Campanha" SET dados_ate = v_max WHERE id = v_c.id;

    RETURN jsonb_build_object(
        'classificados', COALESCE((v_cont ->> 'classificado')::int, 0),
        'abaixo_corte',  COALESCE((v_cont ->> 'abaixo_corte')::int, 0),
        'sem_minimo',    COALESCE((v_cont ->> 'sem_minimo')::int, 0),
        'sem_modal',     COALESCE((v_cont ->> 'sem_modal')::int, 0),
        'ms',            round(extract(epoch FROM clock_timestamp() - v_t0) * 1000)
    );
END;
$$;

CREATE OR REPLACE FUNCTION hub_campanha_recalcular(p_campanha_id int)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    c "Campanha";
BEGIN
    c := hub_campanha_carregar(p_campanha_id, 'campanhas.gerir', false);
    IF hub_campanha_situacao(c) NOT IN ('agendada', 'em_andamento', 'apurando') THEN
        RAISE EXCEPTION 'CAMPANHA_SITUACAO_INVALIDA' USING ERRCODE = '55000';
    END IF;
    RETURN hub_campanha_recalcular_interno(c.id);
END;
$$;

-- Público de uma campanha para aviso: motoristas ATIVOS da empresa com conta; praça = rodou numa
-- praça selecionada nos últimos 60 dias (A10); modais = modal atual dentro da seleção.
CREATE OR REPLACE FUNCTION hub_campanha_publico_cnpjs(c "Campanha")
RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(array_agg(DISTINCT cm.cnpj_prestador), '{}')
    FROM "Entregador" e
    JOIN "ContaMotorista" cm ON cm.id = e.motorista_id AND cm.ativo
    WHERE e.id_empresa = c.id_empresa AND e.ativo
      AND (c.modais IS NULL
           OR upper(btrim(e.dados_entrego_json -> 'informacoesEntrega' ->> 'modal')) = ANY (c.modais))
      AND (c.pracas IS NULL OR e.id IN (
              SELECT pt.entregador_id FROM "PerformanceTurno" pt
              WHERE pt.id_empresa = c.id_empresa AND pt.data_periodo >= hub_hoje_sp() - 59
                AND upper(btrim(pt.subpraca)) = ANY (c.pracas)));
$$;

-- Fechamento (automático e manual): recálculo final, fechada_em, vencedores por faixa, aviso de resultado.
CREATE OR REPLACE FUNCTION hub_campanha_fechar_interno(p_id int)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    c       "Campanha";
    v_cnpjs text[];
BEGIN
    SELECT * INTO c FROM "Campanha" WHERE id = p_id FOR UPDATE;
    IF NOT FOUND OR c.fechada_em IS NOT NULL THEN RETURN; END IF;

    PERFORM hub_campanha_recalcular_interno(p_id);

    INSERT INTO "CampanhaVencedor" (campanha_id, posicao, id_empresa, entregador_id, premio_id)
    SELECT r.campanha_id, r.posicao, r.id_empresa, r.entregador_id, p.id
    FROM "CampanhaRanking" r
    JOIN "CampanhaPremio" p ON p.campanha_id = r.campanha_id AND r.posicao BETWEEN p.posicao_de AND p.posicao_ate
    WHERE r.campanha_id = p_id AND r.situacao = 'classificado'
    ON CONFLICT (campanha_id, posicao) DO NOTHING;

    UPDATE "Campanha" SET fechada_em = now() WHERE id = p_id;

    IF c.avisar AND c.aviso_fim_em IS NULL THEN
        SELECT COALESCE(array_agg(DISTINCT cm.cnpj_prestador), '{}') INTO v_cnpjs
        FROM "CampanhaRanking" r
        JOIN "Entregador" e ON e.id = r.entregador_id
        JOIN "ContaMotorista" cm ON cm.id = e.motorista_id AND cm.ativo
        WHERE r.campanha_id = p_id;
        IF cardinality(v_cnpjs) > 0 THEN
            PERFORM hub_notificacao_enfileirar(
                c.id_empresa, 'empresa', ARRAY[c.id_empresa], v_cnpjs, 'sistema',
                'Resultado da campanha',
                left('A campanha ' || c.nome, 120) || ' terminou. Veja sua posição.',
                '/campanhas/' || c.id::text);
        END IF;
        UPDATE "Campanha" SET aviso_fim_em = now() WHERE id = p_id;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION hub_campanha_fechar(p_id int)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    c "Campanha";
BEGIN
    c := hub_campanha_carregar(p_id, 'campanhas.gerir', true);
    IF hub_campanha_situacao(c) <> 'apurando' THEN
        RAISE EXCEPTION 'CAMPANHA_SITUACAO_INVALIDA' USING ERRCODE = '55000';
    END IF;
    IF hub_hoje_sp() < c.data_fim + 3 THEN
        RAISE EXCEPTION 'FECHAMENTO_ANTECIPADO' USING ERRCODE = '55000';
    END IF;
    PERFORM hub_campanha_fechar_interno(c.id);
END;
$$;

-- Gancho da importação (depois de hub_performance_refresh_mv). Escopo, sem permissão de campanha:
-- quem importa nem sempre gerencia campanhas. Falha de UMA campanha não derruba as outras.
CREATE OR REPLACE FUNCTION hub_campanhas_recalcular_ativas(p_id_empresa int)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_max    date;
    r        RECORD;
    v_recalc int := 0;
    v_fech   int := 0;
    v_erros  int[] := '{}';
BEGIN
    IF p_id_empresa IS NULL OR NOT (p_id_empresa = ANY (hub_jwt_escopo_ids())) THEN
        RAISE EXCEPTION 'FORA_DE_ESCOPO' USING ERRCODE = '42501';
    END IF;

    SELECT max(mv.data_periodo) INTO v_max FROM mv_performance_dia mv WHERE mv.id_empresa = p_id_empresa;
    IF v_max IS NULL THEN
        RETURN jsonb_build_object('recalculadas', 0, 'fechadas', 0, 'erros', '[]'::jsonb);
    END IF;

    FOR r IN
        SELECT c.id, c.data_fim FROM "Campanha" c
        WHERE c.id_empresa = p_id_empresa AND c.lancada_em IS NOT NULL
          AND c.cancelada_em IS NULL AND c.fechada_em IS NULL AND c.data_inicio <= v_max
        ORDER BY c.id
    LOOP
        BEGIN
            IF v_max >= r.data_fim THEN
                PERFORM hub_campanha_fechar_interno(r.id);
                v_fech := v_fech + 1;
            ELSE
                PERFORM hub_campanha_recalcular_interno(r.id);
                v_recalc := v_recalc + 1;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'hub_campanhas_recalcular_ativas: campanha % falhou: %', r.id, SQLERRM;
            v_erros := v_erros || r.id;
        END;
    END LOOP;

    RETURN jsonb_build_object('recalculadas', v_recalc, 'fechadas', v_fech, 'erros', to_jsonb(v_erros));
END;
$$;

-- Varredura de 60 s do push worker: aviso de INÍCIO, idempotente por aviso_inicio_em.
CREATE OR REPLACE FUNCTION hub_campanhas_avisar_inicio()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    r        RECORD;
    c        "Campanha";
    v_cnpjs  text[];
    v_n      int := 0;
BEGIN
    IF NOT hub_jwt_push_worker() THEN
        RAISE EXCEPTION 'PERMISSAO_NEGADA' USING ERRCODE = '42501';
    END IF;

    FOR r IN
        SELECT id FROM "Campanha"
        WHERE lancada_em IS NOT NULL AND cancelada_em IS NULL AND avisar AND aviso_inicio_em IS NULL
          AND hub_hoje_sp() BETWEEN data_inicio AND data_fim
        ORDER BY id
        FOR UPDATE SKIP LOCKED
    LOOP
        SELECT * INTO c FROM "Campanha" WHERE id = r.id;
        v_cnpjs := hub_campanha_publico_cnpjs(c);
        IF cardinality(v_cnpjs) > 0 THEN
            PERFORM hub_notificacao_enfileirar(
                c.id_empresa, 'empresa', ARRAY[c.id_empresa], v_cnpjs, 'sistema',
                'Nova campanha',
                left('A campanha ' || c.nome, 120) || ' começou. Veja como participar.',
                '/campanhas/' || c.id::text);
            v_n := v_n + 1;
        END IF;
        UPDATE "Campanha" SET aviso_inicio_em = now() WHERE id = r.id;
    END LOOP;
    RETURN v_n;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 10. RPCs do hub — leitura
-- ═══════════════════════════════════════════════════════════════════════

-- Item da lista (CONTRATOS §7), JSON camelCase — a mesma forma serve a lista e o detalhe.
CREATE OR REPLACE FUNCTION hub_campanha_item_json(c "Campanha")
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'id', c.id, 'nome', c.nome, 'situacao', hub_campanha_situacao(c),
        'dataInicio', c.data_inicio, 'dataFim', c.data_fim,
        'pracas', to_jsonb(c.pracas), 'turnos', to_jsonb(c.turnos), 'modais', to_jsonb(c.modais),
        'minTurnos', c.min_turnos,
        'pesos', jsonb_build_object('aceitacao', c.peso_aceitacao, 'conclusao', c.peso_conclusao,
                                    'tempo', c.peso_tempo, 'pedidos', c.peso_pedidos),
        'contagem', jsonb_build_object(
            'classificado', COALESCE(k.classificado, 0), 'abaixoCorte', COALESCE(k.abaixo_corte, 0),
            'semMinimo', COALESCE(k.sem_minimo, 0), 'semModal', COALESCE(k.sem_modal, 0)),
        'premiosPendentes', (
            SELECT count(*) FROM "CampanhaVencedor" v JOIN "CampanhaPremio" p ON p.id = v.premio_id
            WHERE v.campanha_id = c.id
              AND ((p.tipo = 'objeto' AND v.entregue_em IS NULL) OR (p.tipo = 'dinheiro' AND v.exportado_em IS NULL))),
        'dadosAte', c.dados_ate)
    FROM (
        SELECT count(*) FILTER (WHERE r.situacao = 'classificado')  AS classificado,
               count(*) FILTER (WHERE r.situacao = 'abaixo_corte')  AS abaixo_corte,
               count(*) FILTER (WHERE r.situacao = 'sem_minimo')    AS sem_minimo,
               count(*) FILTER (WHERE r.situacao = 'sem_modal')     AS sem_modal
        FROM "CampanhaRanking" r WHERE r.campanha_id = c.id
    ) k;
$$;

CREATE OR REPLACE FUNCTION hub_campanha_listar(p_id_empresa int, p_situacao text)
RETURNS TABLE (item jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM hub_campanha_autoriza(p_id_empresa, 'campanhas.consultar');
    RETURN QUERY
    SELECT hub_campanha_item_json(c)
    FROM "Campanha" c
    WHERE c.id_empresa = p_id_empresa
      AND (p_situacao IS NULL OR hub_campanha_situacao(c) = p_situacao)
    ORDER BY c.data_inicio DESC, c.id DESC;
END;
$$;

CREATE OR REPLACE FUNCTION hub_campanha_detalhe(p_id int)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    c "Campanha";
BEGIN
    c := hub_campanha_carregar(p_id, 'campanhas.consultar', false);
    RETURN hub_campanha_item_json(c) || jsonb_build_object(
        'descricao', c.descricao,
        'cortes', jsonb_build_object('aceitacao', c.corte_aceitacao, 'conclusao', c.corte_conclusao,
                                     'tempo', c.corte_tempo, 'pedidos', c.corte_pedidos),
        'premios', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', p.id, 'posicaoDe', p.posicao_de, 'posicaoAte', p.posicao_ate, 'tipo', p.tipo,
                'descricao', p.descricao, 'valorCentavos', p.valor_centavos, 'temFoto', p.foto IS NOT NULL)
                ORDER BY p.posicao_de)
            FROM "CampanhaPremio" p WHERE p.campanha_id = c.id), '[]'::jsonb),
        'avisar', c.avisar,
        'criadaPor', (SELECT u.nome FROM "Usuario" u WHERE u.id = c.criada_por),
        'criadaEm', c.criada_em,
        'lancadaPor', (SELECT u.nome FROM "Usuario" u WHERE u.id = c.lancada_por),
        'lancadaEm', c.lancada_em,
        'canceladaEm', c.cancelada_em,
        'motivoCancelamento', c.motivo_cancelamento,
        'fechadaEm', c.fechada_em,
        'notaCorteTop10', (SELECT r.nota FROM "CampanhaRanking" r
                           WHERE r.campanha_id = c.id AND r.situacao = 'classificado' AND r.posicao = 10));
END;
$$;

-- Ranking paginado. LIMIT/OFFSET ANTES dos joins; contagem à parte (sem count(*) OVER ()).
CREATE OR REPLACE FUNCTION hub_campanha_ranking(p_id int, p_situacao text, p_limite int, p_offset int)
RETURNS TABLE (
    posicao int, entregador_id int, nome text, modal text, situacao text, turnos int,
    aceitacao numeric, conclusao numeric, tempo numeric, pedidos bigint, nota numeric,
    nota_hipotetica numeric, posicao_hipotetica int, motivo_corte text[], posicao_anterior int
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    c        "Campanha";
    v_lim    int := LEAST(GREATEST(COALESCE(p_limite, 50), 1), 200);
    v_off    int := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
    c := hub_campanha_carregar(p_id, 'campanhas.consultar', false);

    RETURN QUERY
    SELECT r.posicao, r.entregador_id, e.nome, r.modal, r.situacao, r.turnos,
           round(r.aceitacao, 4), round(r.conclusao, 4), round(r.tempo, 4), r.pedidos, r.nota,
           r.nota_hipotetica, r.posicao_hipotetica, r.motivo_corte, r.posicao_anterior
    FROM (
        SELECT * FROM "CampanhaRanking" x
        WHERE x.campanha_id = c.id AND (p_situacao IS NULL OR x.situacao = p_situacao)
        ORDER BY x.posicao NULLS LAST, x.nota_hipotetica DESC NULLS LAST, x.turnos DESC, x.entregador_id
        LIMIT v_lim OFFSET v_off
    ) r
    JOIN "Entregador" e ON e.id = r.entregador_id
    ORDER BY r.posicao NULLS LAST, r.nota_hipotetica DESC NULLS LAST, r.turnos DESC, r.entregador_id;
END;
$$;

CREATE OR REPLACE FUNCTION hub_campanha_ranking_contagem(p_id int)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    c "Campanha";
BEGIN
    c := hub_campanha_carregar(p_id, 'campanhas.consultar', false);
    RETURN (
        SELECT jsonb_build_object(
            'classificado', count(*) FILTER (WHERE r.situacao = 'classificado'),
            'abaixo_corte', count(*) FILTER (WHERE r.situacao = 'abaixo_corte'),
            'sem_minimo',   count(*) FILTER (WHERE r.situacao = 'sem_minimo'),
            'sem_modal',    count(*) FILTER (WHERE r.situacao = 'sem_modal'))
        FROM "CampanhaRanking" r WHERE r.campanha_id = c.id);
END;
$$;

CREATE OR REPLACE FUNCTION hub_campanha_vencedores(p_id int)
RETURNS TABLE (
    posicao int, entregador_id int, nome text, cnpj text, nota numeric, premio_id int, premio_tipo text,
    premio_descricao text, valor_centavos int, entregue_em timestamptz, entregue_por_nome text,
    observacao text, exportado_em timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    c "Campanha";
BEGIN
    c := hub_campanha_carregar(p_id, 'campanhas.consultar', false);
    RETURN QUERY
    SELECT v.posicao, v.entregador_id, e.nome, cm.cnpj_prestador, r.nota, p.id, p.tipo, p.descricao,
           p.valor_centavos, v.entregue_em, u.nome, v.observacao, v.exportado_em
    FROM "CampanhaVencedor" v
    JOIN "CampanhaPremio" p ON p.id = v.premio_id
    JOIN "Entregador" e ON e.id = v.entregador_id
    LEFT JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
    LEFT JOIN "CampanhaRanking" r ON r.campanha_id = v.campanha_id AND r.entregador_id = v.entregador_id
    LEFT JOIN "Usuario" u ON u.id = v.entregue_por
    WHERE v.campanha_id = c.id
    ORDER BY v.posicao;
END;
$$;

CREATE OR REPLACE FUNCTION hub_campanha_registrar_entrega(p_id int, p_posicao int, p_observacao text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    c     "Campanha";
    v     RECORD;
    v_obs text := NULLIF(btrim(p_observacao), '');
BEGIN
    c := hub_campanha_carregar(p_id, 'campanhas.entregar', true);
    IF v_obs IS NOT NULL AND char_length(v_obs) > 500 THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'observacao';
    END IF;
    IF c.cancelada_em IS NOT NULL THEN
        RAISE EXCEPTION 'CAMPANHA_SITUACAO_INVALIDA' USING ERRCODE = '55000';
    END IF;
    SELECT vv.posicao, vv.entregue_em, p.tipo INTO v
    FROM "CampanhaVencedor" vv JOIN "CampanhaPremio" p ON p.id = vv.premio_id
    WHERE vv.campanha_id = c.id AND vv.posicao = p_posicao FOR UPDATE OF vv;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'CAMPANHA_NAO_ENCONTRADA' USING ERRCODE = 'P0002';
    END IF;
    -- só prêmio de objeto, e só uma vez
    IF v.tipo <> 'objeto' OR v.entregue_em IS NOT NULL THEN
        RAISE EXCEPTION 'CAMPANHA_SITUACAO_INVALIDA' USING ERRCODE = '55000';
    END IF;
    UPDATE "CampanhaVencedor"
    SET entregue_em = now(), entregue_por = NULLIF(hub_jwt_claims() ->> 'sub', '')::int, observacao = v_obs
    WHERE campanha_id = c.id AND posicao = p_posicao;
END;
$$;

-- Prêmios em DINHEIRO com CNPJ (sem CNPJ não volta). Carimba exportado_em na primeira exportação.
CREATE OR REPLACE FUNCTION hub_campanha_marcar_exportado(p_id int)
RETURNS TABLE (cnpj text, nome text, valor_centavos int, posicao int)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    c "Campanha";
BEGIN
    c := hub_campanha_carregar(p_id, 'campanhas.entregar', true);
    IF c.cancelada_em IS NOT NULL THEN
        RAISE EXCEPTION 'CAMPANHA_SITUACAO_INVALIDA' USING ERRCODE = '55000';
    END IF;
    RETURN QUERY
    WITH sel AS (
        SELECT v.posicao AS pos, cm.cnpj_prestador AS cnpj, e.nome AS nome, p.valor_centavos AS valor
        FROM "CampanhaVencedor" v
        JOIN "CampanhaPremio" p ON p.id = v.premio_id AND p.tipo = 'dinheiro'
        JOIN "Entregador" e ON e.id = v.entregador_id
        JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
        WHERE v.campanha_id = c.id
    ),
    mk AS (
        UPDATE "CampanhaVencedor" v SET exportado_em = COALESCE(v.exportado_em, now())
        FROM sel WHERE v.campanha_id = c.id AND v.posicao = sel.pos
        RETURNING v.posicao
    )
    SELECT sel.cnpj, sel.nome, sel.valor, sel.pos FROM sel ORDER BY sel.pos;
END;
$$;

CREATE OR REPLACE FUNCTION hub_campanha_premio_foto_salvar(p_premio_id int, p_mime text, p_base64 text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    pr     "CampanhaPremio";
    c      "Campanha";
    v_b    bytea;
    v_tipo text;
BEGIN
    SELECT * INTO pr FROM "CampanhaPremio" WHERE id = p_premio_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'CAMPANHA_NAO_ENCONTRADA' USING ERRCODE = 'P0002'; END IF;
    c := hub_campanha_carregar(pr.campanha_id, 'campanhas.gerir', true);
    IF c.lancada_em IS NOT NULL THEN
        RAISE EXCEPTION 'CAMPANHA_IMUTAVEL' USING ERRCODE = '55000';
    END IF;

    BEGIN
        v_b := decode(COALESCE(p_base64, ''), 'base64');
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'FOTO_INVALIDA' USING ERRCODE = '22023';
    END;
    IF octet_length(v_b) = 0 OR octet_length(v_b) > 512000 THEN
        RAISE EXCEPTION 'FOTO_INVALIDA' USING ERRCODE = '22023';
    END IF;
    -- tipo pelos BYTES iniciais (nunca pelo que o cliente declarou); sem SVG
    v_tipo := CASE
        WHEN substring(v_b FROM 1 FOR 3) = '\xffd8ff'::bytea THEN 'image/jpeg'
        WHEN substring(v_b FROM 1 FOR 4) = '\x89504e47'::bytea THEN 'image/png'
        WHEN substring(v_b FROM 1 FOR 4) = '\x52494646'::bytea AND substring(v_b FROM 9 FOR 4) = '\x57454250'::bytea THEN 'image/webp'
    END;
    IF v_tipo IS NULL OR v_tipo IS DISTINCT FROM p_mime THEN
        RAISE EXCEPTION 'FOTO_INVALIDA' USING ERRCODE = '22023';
    END IF;

    UPDATE "CampanhaPremio" SET foto = v_b, foto_mime = v_tipo WHERE id = p_premio_id;
END;
$$;

CREATE OR REPLACE FUNCTION hub_campanha_premio_foto(p_premio_id int)
RETURNS TABLE (mime text, base64 text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    pr "CampanhaPremio";
    c  "Campanha";
BEGIN
    SELECT * INTO pr FROM "CampanhaPremio" WHERE id = p_premio_id;
    IF NOT FOUND THEN RETURN; END IF;
    c := hub_campanha_carregar(pr.campanha_id, 'campanhas.consultar', false);
    IF pr.foto IS NULL THEN RETURN; END IF;
    -- encode(...,'base64') quebra linha a cada 76 caracteres; tirar.
    RETURN QUERY SELECT pr.foto_mime, translate(encode(pr.foto, 'base64'), E'\n', '');
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 11. RPCs do motorista (identidade SÓ pela claim motorista_cnpj)
-- ═══════════════════════════════════════════════════════════════════════
-- Resolução como em hub_adiantamento_repasse_motorista() (0117): CNPJ da claim -> "ContaMotorista"
-- -> "Entregador".motorista_id. Diferença deliberada: o motorista pode ter um Entregador por
-- empresa, então a empresa da CAMPANHA escolhe o entregador (o padrão original pega "o primeiro").

-- A10: lançada, não cancelada, encerrada só até 30 dias após fechada_em; com `pracas`, só quem
-- tem linha no ranking OU turno numa praça selecionada nos últimos 60 dias (consulta de UM entregador).
CREATE OR REPLACE FUNCTION hub_campanha_visivel(c "Campanha", p_entregador_id int)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT c.lancada_em IS NOT NULL
       AND c.cancelada_em IS NULL
       AND (c.fechada_em IS NULL OR c.fechada_em >= now() - interval '30 days')
       AND (c.pracas IS NULL
            OR EXISTS (SELECT 1 FROM "CampanhaRanking" r WHERE r.campanha_id = c.id AND r.entregador_id = p_entregador_id)
            OR EXISTS (SELECT 1 FROM "PerformanceTurno" pt
                       WHERE pt.id_empresa = c.id_empresa AND pt.entregador_id = p_entregador_id
                         AND pt.data_periodo >= hub_hoje_sp() - 59
                         AND upper(btrim(pt.subpraca)) = ANY (c.pracas)));
$$;

CREATE OR REPLACE FUNCTION hub_motorista_campanhas()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_cnpj text := hub_jwt_motorista_cnpj();
BEGIN
    IF v_cnpj IS NULL THEN RETURN '[]'::jsonb; END IF;

    RETURN COALESCE((
        SELECT jsonb_agg(s.item ORDER BY (s.fechada) , s.data_fim, s.id)
        FROM (
            SELECT DISTINCT ON (c.id) c.id, c.data_fim, (c.fechada_em IS NOT NULL) AS fechada,
                jsonb_build_object(
                    'id', c.id, 'nome', c.nome, 'situacao', hub_campanha_situacao(c),
                    'dataInicio', c.data_inicio, 'dataFim', c.data_fim,
                    'minhaPosicao', r.posicao,
                    'total', (SELECT count(*) FROM "CampanhaRanking" k WHERE k.campanha_id = c.id AND k.situacao = 'classificado'),
                    'minhaSituacao', r.situacao,
                    'naZonaPremio', COALESCE(r.posicao IS NOT NULL AND EXISTS (
                        SELECT 1 FROM "CampanhaPremio" p WHERE p.campanha_id = c.id AND r.posicao BETWEEN p.posicao_de AND p.posicao_ate), false)
                ) AS item
            FROM "ContaMotorista" cm
            JOIN "Entregador" e ON e.motorista_id = cm.id
            JOIN "Campanha" c ON c.id_empresa = e.id_empresa AND c.lancada_em IS NOT NULL
            LEFT JOIN "CampanhaRanking" r ON r.campanha_id = c.id AND r.entregador_id = e.id
            WHERE cm.cnpj_prestador = v_cnpj
              AND hub_campanha_visivel(c, e.id)
            ORDER BY c.id, e.id
        ) s
    ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION hub_motorista_campanha(p_id int)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_cnpj   text := hub_jwt_motorista_cnpj();
    c        "Campanha";
    v_ent    int;
    r        "CampanhaRanking";
    v_eu     jsonb := NULL;
    v_lider  bigint;
    v_acima  jsonb := NULL;
    v_prem   jsonb := NULL;
    v_pp     numeric;
BEGIN
    IF v_cnpj IS NULL THEN RAISE EXCEPTION 'SEM_VINCULO' USING ERRCODE = 'P0002'; END IF;
    IF NOT EXISTS (SELECT 1 FROM "ContaMotorista" cm JOIN "Entregador" e ON e.motorista_id = cm.id
                   WHERE cm.cnpj_prestador = v_cnpj) THEN
        RAISE EXCEPTION 'SEM_VINCULO' USING ERRCODE = 'P0002';
    END IF;

    SELECT * INTO c FROM "Campanha" WHERE id = p_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'CAMPANHA_NAO_ENCONTRADA' USING ERRCODE = 'P0002'; END IF;
    SELECT e.id INTO v_ent FROM "Entregador" e JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
    WHERE cm.cnpj_prestador = v_cnpj AND e.id_empresa = c.id_empresa ORDER BY e.id LIMIT 1;
    -- outra empresa ou invisível: mesmo 404 (não revela existência)
    IF v_ent IS NULL OR NOT hub_campanha_visivel(c, v_ent) THEN
        RAISE EXCEPTION 'CAMPANHA_NAO_ENCONTRADA' USING ERRCODE = 'P0002';
    END IF;

    SELECT max(k.pedidos) INTO v_lider FROM "CampanhaRanking" k
    WHERE k.campanha_id = c.id AND k.situacao = 'classificado';

    SELECT * INTO r FROM "CampanhaRanking" k WHERE k.campanha_id = c.id AND k.entregador_id = v_ent;
    IF FOUND THEN
        IF r.situacao = 'classificado' THEN
            SELECT jsonb_build_object('nome', hub_nome_abreviado(e.nome), 'nota', k.nota) INTO v_acima
            FROM "CampanhaRanking" k JOIN "Entregador" e ON e.id = k.entregador_id
            WHERE k.campanha_id = c.id AND k.situacao = 'classificado' AND k.posicao = r.posicao - 1;
            SELECT jsonb_build_object('tipo', p.tipo, 'descricao', p.descricao) INTO v_prem
            FROM "CampanhaPremio" p WHERE p.campanha_id = c.id AND r.posicao BETWEEN p.posicao_de AND p.posicao_ate
            ORDER BY p.posicao_de LIMIT 1;
        END IF;
        v_pp := CASE WHEN COALESCE(v_lider, 0) > 0
                     THEN LEAST(COALESCE(r.pedidos, 0)::numeric / v_lider * 100, 100) ELSE 0 END;
        v_eu := jsonb_build_object(
            'situacao', r.situacao, 'posicao', r.posicao, 'posicaoAnterior', r.posicao_anterior,
            'nota', r.nota, 'turnos', r.turnos,
            'leituras', jsonb_build_object('aceitacao', round(r.aceitacao, 4), 'conclusao', round(r.conclusao, 4),
                                           'tempo', round(r.tempo, 4), 'pedidos', r.pedidos),
            'notas', jsonb_build_object('aceitacao', round(COALESCE(r.aceitacao, 0) * 100, 2),
                                        'conclusao', round(COALESCE(r.conclusao, 0) * 100, 2),
                                        'tempo', round(COALESCE(r.tempo, 0) * 100, 2),
                                        'pedidos', round(v_pp, 2)),
            'motivoCorte', to_jsonb(r.motivo_corte),
            'notaHipotetica', r.nota_hipotetica, 'posicaoHipotetica', r.posicao_hipotetica,
            'ofertadas', r.ofertadas, 'aceitas', r.aceitas, 'completadas', r.completadas,
            'acima', v_acima, 'premio', v_prem,
            'entregueEm', (SELECT v.entregue_em FROM "CampanhaVencedor" v
                           WHERE v.campanha_id = c.id AND v.entregador_id = v_ent));
    END IF;

    RETURN jsonb_build_object(
        'campanha', jsonb_build_object(
            'id', c.id, 'nome', c.nome, 'descricao', c.descricao, 'situacao', hub_campanha_situacao(c),
            'dataInicio', c.data_inicio, 'dataFim', c.data_fim,
            'pracas', to_jsonb(c.pracas), 'turnos', to_jsonb(c.turnos), 'modais', to_jsonb(c.modais),
            'minTurnos', c.min_turnos,
            'pesos', jsonb_build_object('aceitacao', c.peso_aceitacao, 'conclusao', c.peso_conclusao,
                                        'tempo', c.peso_tempo, 'pedidos', c.peso_pedidos),
            'cortes', jsonb_build_object('aceitacao', c.corte_aceitacao, 'conclusao', c.corte_conclusao,
                                         'tempo', c.corte_tempo, 'pedidos', c.corte_pedidos),
            'dadosAte', c.dados_ate, 'fechadaEm', c.fechada_em),
        'premios', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', p.id, 'posicaoDe', p.posicao_de, 'posicaoAte', p.posicao_ate, 'tipo', p.tipo,
                'descricao', p.descricao, 'valorCentavos', CASE WHEN p.tipo = 'dinheiro' THEN p.valor_centavos END,
                'temFoto', p.foto IS NOT NULL) ORDER BY p.posicao_de)
            FROM "CampanhaPremio" p WHERE p.campanha_id = c.id), '[]'::jsonb),
        'eu', v_eu,
        'lider', jsonb_build_object('pedidos', v_lider),
        -- só o nome ABREVIADO de terceiros sai daqui
        'top10', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('posicao', t.posicao, 'nome', hub_nome_abreviado(t.nome),
                                                'nota', t.nota, 'souEu', t.entregador_id = v_ent) ORDER BY t.posicao)
            FROM (SELECT k.posicao, k.nota, k.entregador_id, e.nome
                  FROM "CampanhaRanking" k JOIN "Entregador" e ON e.id = k.entregador_id
                  WHERE k.campanha_id = c.id AND k.situacao = 'classificado' AND k.posicao <= 10
                  ORDER BY k.posicao) t), '[]'::jsonb),
        'totalClassificados', (SELECT count(*) FROM "CampanhaRanking" k
                               WHERE k.campanha_id = c.id AND k.situacao = 'classificado'));
END;
$$;

CREATE OR REPLACE FUNCTION hub_motorista_campanha_foto(p_premio_id int)
RETURNS TABLE (mime text, base64 text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_cnpj text := hub_jwt_motorista_cnpj();
    pr     "CampanhaPremio";
    c      "Campanha";
    v_ent  int;
BEGIN
    IF v_cnpj IS NULL THEN RETURN; END IF;
    SELECT * INTO pr FROM "CampanhaPremio" WHERE id = p_premio_id;
    IF NOT FOUND OR pr.foto IS NULL THEN RETURN; END IF;
    SELECT * INTO c FROM "Campanha" WHERE id = pr.campanha_id;
    SELECT e.id INTO v_ent FROM "Entregador" e JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
    WHERE cm.cnpj_prestador = v_cnpj AND e.id_empresa = c.id_empresa ORDER BY e.id LIMIT 1;
    IF v_ent IS NULL OR NOT hub_campanha_visivel(c, v_ent) THEN RETURN; END IF;
    RETURN QUERY SELECT pr.foto_mime, translate(encode(pr.foto, 'base64'), E'\n', '');
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 12. EXECUTE: tudo REVOKE FROM PUBLIC; só as RPCs de borda ganham `authenticated`
-- ═══════════════════════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION hub_campanha_autoriza(int, text)                       FROM PUBLIC;
REVOKE ALL ON FUNCTION hub_campanha_carregar(int, text, boolean)              FROM PUBLIC;
REVOKE ALL ON FUNCTION hub_campanha_recalcular_interno(int)                   FROM PUBLIC;
REVOKE ALL ON FUNCTION hub_campanha_fechar_interno(int)                       FROM PUBLIC;
REVOKE ALL ON FUNCTION hub_campanha_publico_cnpjs("Campanha")                 FROM PUBLIC;
REVOKE ALL ON FUNCTION hub_campanha_item_json("Campanha")                     FROM PUBLIC;
REVOKE ALL ON FUNCTION hub_campanha_visivel("Campanha", int)                  FROM PUBLIC;

DO $$
DECLARE
    f text;
BEGIN
    FOREACH f IN ARRAY ARRAY[
        'hub_campanha_opcoes(int, text[], text[], text[])',
        'hub_campanha_salvar(int, int, jsonb)',
        'hub_campanha_lancar(int)',
        'hub_campanha_cancelar(int, text)',
        'hub_campanha_fechar(int)',
        'hub_campanha_listar(int, text)',
        'hub_campanha_detalhe(int)',
        'hub_campanha_ranking(int, text, int, int)',
        'hub_campanha_ranking_contagem(int)',
        'hub_campanha_vencedores(int)',
        'hub_campanha_registrar_entrega(int, int, text)',
        'hub_campanha_marcar_exportado(int)',
        'hub_campanha_premio_foto_salvar(int, text, text)',
        'hub_campanha_premio_foto(int)',
        'hub_campanha_recalcular(int)',
        'hub_campanhas_recalcular_ativas(int)',
        'hub_campanhas_avisar_inicio()',
        'hub_motorista_campanhas()',
        'hub_motorista_campanha(int)',
        'hub_motorista_campanha_foto(int)'
    ] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
    END LOOP;
END
$$;
