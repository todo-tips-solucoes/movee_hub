-- 0108 — Lote de pagamento do repasse (F5 da frente nota-pendente-motorista).
-- Plano: docs/plans/nota-pendente-motorista/PLANO-F5-LOTE-REPASSE.md (§3.1).
-- Espelha 0066 (tabelas) + 0067/0074/0076 (funções) do adiantamento. ADITIVA e
-- IDEMPOTENTE: só cria objetos novos; não altera nenhuma tabela/função existente.
-- Zero permissão nova: reusa adiantamentos.{pagamentos_consultar,lote_criar,
-- exportar,pagamento_confirmar,reprocessar} (D5 — o papel financeiro_aprovador
-- nasceu como cópia do financeiro; permissão nova não se propagaria).

-- ─────────────────────────────────────────────────────────────────────────
-- RepasseLote
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "RepasseLote" (
    id                     bigserial PRIMARY KEY,
    id_empresa             int NOT NULL,
    status                 text NOT NULL,
    criado_por             int NOT NULL REFERENCES "Usuario"(id),
    criado_em              timestamptz NOT NULL DEFAULT now(),
    chave_idempotencia     uuid NOT NULL,
    quantidade             int NOT NULL,
    valor_total            numeric(14,2) NOT NULL,
    arquivo_nome           text NULL,
    arquivo                bytea NULL,
    arquivo_sha256         char(64) NULL,
    arquivo_bytes          int NULL,
    arquivo_expurgado_em   timestamptz NULL,
    gerado_em              timestamptz NULL,
    primeiro_download_em   timestamptz NULL,
    downloads              int NOT NULL DEFAULT 0,
    cancelado_em           timestamptz NULL,
    cancelado_por          int NULL REFERENCES "Usuario"(id),
    cancelado_motivo       text NULL,
    nao_enviado_declarado  boolean NULL,
    concluido_em           timestamptz NULL,
    CONSTRAINT repasselote_idempotencia_uniq UNIQUE (criado_por, chave_idempotencia),
    CONSTRAINT repasselote_status_chk CHECK (
        status IN ('GERANDO', 'GERADO', 'EXPORTADO', 'CONCLUIDO', 'CONCLUIDO_COM_FALHAS', 'CANCELADO')
    ),
    CONSTRAINT repasselote_quantidade_chk CHECK (quantidade BETWEEN 1 AND 5000),
    CONSTRAINT repasselote_valor_total_chk CHECK (valor_total > 0),
    CONSTRAINT repasselote_gerado_exige_arquivo_chk CHECK (
        status <> 'GERADO' OR (arquivo IS NOT NULL AND arquivo_sha256 IS NOT NULL AND arquivo_bytes IS NOT NULL)
    ),
    CONSTRAINT repasselote_cancelado_exige_motivo_chk CHECK (
        status <> 'CANCELADO' OR cancelado_motivo IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_repasselote_empresa_criado
    ON "RepasseLote" (id_empresa, criado_em DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- RepasseLoteItem — um item por ENTREGADOR × APURAÇÃO (D2), não por solicitação.
--
-- ⚠️ NENHUMA FK para "EnvioMassa" (D6): existe `DELETE /envio-massa/:id`
-- (app_homologacao/backend/server.js:1185). Uma FK faria esse DELETE do legado
-- estourar violação (500 com texto cru do Postgres) — regressão no produto
-- antigo. A trilha de auditoria do que foi pago sobrevive no snapshot col_* e
-- nas FKs do hub (apuracao_id/entregador_id). Quem for "melhorar" isto com uma
-- FK: leia o plano F5 §D6 antes.
--
-- ⚠️ `valor` vem de "ApuracaoRepasseItem".valor_pago (numeric — já desconta
-- adiantamentos, aplica saldo mínimo e soma saldo transportado). NUNCA de
-- "EnvioMassa".valor, que é double precision (float para dinheiro) e pagaria
-- em duplicidade com o adiantamento já recebido (D1).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "RepasseLoteItem" (
    id                     bigserial PRIMARY KEY,
    lote_id                bigint NOT NULL REFERENCES "RepasseLote"(id),
    apuracao_id            bigint NOT NULL REFERENCES "ApuracaoRepasse"(id),
    entregador_id          int NOT NULL REFERENCES "Entregador"(id),
    id_empresa             int NOT NULL,
    linha                  int NOT NULL,
    col_nome               text NOT NULL,
    col_documento          text NOT NULL,
    col_email              text NOT NULL DEFAULT '',
    col_banco              text NOT NULL,
    col_agencia            text NOT NULL,
    col_conta              text NOT NULL,
    col_digito             text NOT NULL,
    col_tipo_conta         text NOT NULL,
    valor                  numeric(12,2) NOT NULL,
    col_id_integracao      text NOT NULL DEFAULT '',
    col_data_agendamento   text NOT NULL DEFAULT '',
    col_descricao_pix      text NOT NULL,
    conta_bancaria_id      bigint NOT NULL REFERENCES "ContaBancariaMotorista"(id),
    situacao               text NOT NULL,
    situacao_motivo        text NULL,
    situacao_em            timestamptz NULL,
    situacao_por           int NULL REFERENCES "Usuario"(id),
    origem_situacao        text NULL,
    CONSTRAINT repasseloteitem_lote_linha_uniq UNIQUE (lote_id, linha),
    CONSTRAINT repasseloteitem_chave_uniq UNIQUE (lote_id, apuracao_id, entregador_id),
    CONSTRAINT repasseloteitem_linha_chk CHECK (linha >= 3),
    CONSTRAINT repasseloteitem_valor_chk CHECK (valor > 0),
    CONSTRAINT repasseloteitem_descricao_pix_chk CHECK (char_length(col_descricao_pix) <= 140),
    CONSTRAINT repasseloteitem_situacao_chk CHECK (situacao IN ('incluido', 'pago', 'falhou', 'cancelado')),
    CONSTRAINT repasseloteitem_situacao_motivo_chk CHECK (situacao <> 'falhou' OR situacao_motivo IS NOT NULL),
    CONSTRAINT repasseloteitem_origem_chk CHECK (origem_situacao IS NULL OR origem_situacao IN ('retorno', 'manual'))
);

-- Serve a revalidação "já em outro lote" (prévia e criar, sob o lock).
CREATE INDEX IF NOT EXISTS idx_repasseloteitem_ativo
    ON "RepasseLoteItem" (apuracao_id, entregador_id) WHERE situacao IN ('incluido', 'pago');
CREATE INDEX IF NOT EXISTS idx_repasseloteitem_lote
    ON "RepasseLoteItem" (lote_id);

-- ─────────────────────────────────────────────────────────────────────────
-- RLS + GRANTs — escrita só pelas funções SECURITY DEFINER abaixo.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "RepasseLote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RepasseLoteItem" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS repasselote_select_por_escopo ON "RepasseLote";
CREATE POLICY repasselote_select_por_escopo ON "RepasseLote"
    FOR SELECT USING (id_empresa = ANY (hub_jwt_escopo_ids()));

DROP POLICY IF EXISTS repasseloteitem_select_por_escopo ON "RepasseLoteItem";
CREATE POLICY repasseloteitem_select_por_escopo ON "RepasseLoteItem"
    FOR SELECT USING (id_empresa = ANY (hub_jwt_escopo_ids()));

GRANT SELECT ON "RepasseLoteItem" TO authenticated;

-- RepasseLote: GRANT por coluna, EXCLUINDO `arquivo` — os bytes só saem pela
-- RPC de download (que checa permissão e conta o download).
GRANT SELECT (
    id, id_empresa, status, criado_por, criado_em, chave_idempotencia,
    quantidade, valor_total, arquivo_nome, arquivo_sha256, arquivo_bytes,
    arquivo_expurgado_em, gerado_em, primeiro_download_em, downloads,
    cancelado_em, cancelado_por, cancelado_motivo, nao_enviado_declarado,
    concluido_em
) ON "RepasseLote" TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- Funções
-- ─────────────────────────────────────────────────────────────────────────

-- col_id_integracao = 'REP-' + id do ITEM (D8) — um entregador pago em semanas
-- diferentes precisa de uma linha de CSV única por pagamento.
CREATE OR REPLACE FUNCTION hub_repasse_integration_id(p_id bigint)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN p_id < 1000000 THEN 'REP-' || lpad(p_id::text, 6, '0')
        ELSE 'REP-' || p_id::text
    END;
$$;

-- Avaliação de elegibilidade — UMA definição, usada pela prévia e pelo criar
-- (que reavalia sob o lock). Interna: sem GRANT a `authenticated`.
--   p_apuracoes/p_entregadores NULL  -> todos os candidatos do escopo ainda
--                                       fora de lote ativo (modo "listar").
--   arrays posicionais               -> exatamente esses pares, inclusive os
--                                       já em lote (motivo JA_EM_LOTE).
-- ⚠️ Nota aprovada = nota_ok preenchido E erro_validacao vazio. `nota_ok`
-- guarda a URL do XML e é gravado MESMO QUANDO A NOTA É REPROVADA; sozinho NÃO
-- prova aprovação (mesma regra de notaAprovada() em routes/hub-validacao-xml.js).
-- Movimento sem EnvioMassa (excluído pelo legado) conta como nota pendente.
-- Entregador só entra se TODOS os movimentos da apuração estão aprovados.
-- Cadeia da conta: ContaBancariaMotorista.entregador_id + status='APROVADA'
-- (D4 — não ligar por documento: conta PF do hub nunca casa com o CNPJ).
CREATE OR REPLACE FUNCTION hub_repasse_lote_avaliar(p_apuracoes bigint[], p_entregadores int[])
RETURNS TABLE (
    apuracao_id bigint, entregador_id int, entregador_nome text,
    periodo_inicio date, periodo_fim date, id_empresa int,
    valor_pago numeric, conta_bancaria_id bigint, apta boolean, motivo_pendencia text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH base AS (
        SELECT i.apuracao_id, i.entregador_id, ent.nome AS entregador_nome,
               ar.periodo_inicio, ar.periodo_fim, ar.fechado_em, i.id_empresa,
               i.valor_pago, cb.id AS conta_id,
               mov.total, mov.aprovadas, mov.reprovadas,
               EXISTS (SELECT 1 FROM "RepasseLoteItem" li
                       WHERE li.apuracao_id = i.apuracao_id AND li.entregador_id = i.entregador_id
                         AND li.situacao IN ('incluido', 'pago')) AS em_lote
        FROM "ApuracaoRepasseItem" i
        JOIN "ApuracaoRepasse" ar ON ar.id = i.apuracao_id
        JOIN "Entregador" ent ON ent.id = i.entregador_id
        LEFT JOIN "ContaBancariaMotorista" cb
               ON cb.entregador_id = i.entregador_id AND cb.status = 'APROVADA'
        LEFT JOIN LATERAL (
            SELECT count(m.id) AS total,
                   count(em.id) FILTER (WHERE NULLIF(btrim(em.nota_ok, E' \t\r\n'), '') IS NOT NULL
                                          AND NULLIF(btrim(em.erro_validacao, E' \t\r\n'), '') IS NULL) AS aprovadas,
                   count(em.id) FILTER (WHERE NULLIF(btrim(em.erro_validacao, E' \t\r\n'), '') IS NOT NULL) AS reprovadas
            FROM "ApuracaoRepasseMovimento" m
            LEFT JOIN "EnvioMassa" em ON em.id = m.envio_massa_id
            WHERE m.apuracao_id = i.apuracao_id AND m.entregador_id = i.entregador_id
        ) mov ON true
        WHERE i.id_empresa = ANY (hub_jwt_escopo_ids())
          AND (
              (p_apuracoes IS NULL AND i.valor_pago > 0)
              OR EXISTS (SELECT 1 FROM unnest(p_apuracoes, p_entregadores) AS par(a, e)
                         WHERE par.a = i.apuracao_id AND par.e = i.entregador_id)
          )
    ), motivo AS (
        SELECT b.*,
            CASE
                WHEN b.em_lote THEN 'JA_EM_LOTE'
                WHEN b.fechado_em IS NULL THEN 'APURACAO_ABERTA'
                WHEN b.valor_pago IS NULL OR b.valor_pago <= 0 THEN 'VALOR_INVALIDO'
                WHEN b.reprovadas > 0 THEN 'NOTA_REPROVADA'
                WHEN b.total = 0 OR b.aprovadas < b.total THEN 'NOTA_PENDENTE'
                WHEN b.conta_id IS NULL THEN 'SEM_CONTA'
                ELSE NULL
            END AS m
        FROM base b
    )
    SELECT apuracao_id, entregador_id, entregador_nome, periodo_inicio, periodo_fim, id_empresa,
           valor_pago, conta_id, (m IS NULL), m
    FROM motivo
    -- modo "listar": quem já está em lote ativo não é candidato, é histórico
    WHERE NOT (p_apuracoes IS NULL AND em_lote)
$$;

-- Prévia: elegíveis E bloqueados com o motivo (padrão `reason` do adiantamento).
CREATE OR REPLACE FUNCTION hub_repasse_lote_previa(p_apuracoes bigint[] DEFAULT NULL, p_entregadores int[] DEFAULT NULL)
RETURNS TABLE (
    apuracao_id bigint, entregador_id int, entregador_nome text,
    periodo_inicio date, periodo_fim date,
    valor_pago numeric, apta boolean, motivo_pendencia text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.pagamentos_consultar') THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;
    IF (p_apuracoes IS NULL) <> (p_entregadores IS NULL)
       OR cardinality(p_apuracoes) IS DISTINCT FROM cardinality(p_entregadores) THEN
        RAISE EXCEPTION 'DADOS_INVALIDOS';
    END IF;

    RETURN QUERY
    SELECT a.apuracao_id, a.entregador_id, a.entregador_nome, a.periodo_inicio, a.periodo_fim,
           a.valor_pago, a.apta, a.motivo_pendencia
    FROM hub_repasse_lote_avaliar(p_apuracoes, p_entregadores) a
    ORDER BY a.apta DESC, a.periodo_inicio, a.entregador_nome, a.entregador_id;
END;
$$;

-- Criar: dois arrays posicionais (evita tipo composto no contrato do PostgREST).
CREATE OR REPLACE FUNCTION hub_repasse_lote_criar(
    p_apuracoes bigint[], p_entregadores int[],
    p_quantidade_esperada int, p_total_esperado numeric, p_chave uuid
)
RETURNS TABLE (id bigint, status text, quantidade int, valor_total numeric, reutilizado boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_sub          int := NULLIF(hub_jwt_claims() ->> 'sub', '')::int;
    v_empresa      int := NULLIF(hub_jwt_claims() ->> 'empresa_ativa', '')::int;
    v_existente    RECORD;
    v_conflitantes text;
    v_qtd          int;
    v_total        numeric(14,2);
    v_lote_id      bigint;
    v_linha        int := 3;
    v_row          RECORD;
    v_item_id      bigint;
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.lote_criar') THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;
    IF v_sub IS NULL THEN RAISE EXCEPTION 'NAO_AUTENTICADO'; END IF;
    IF p_apuracoes IS NULL OR p_entregadores IS NULL
       OR cardinality(p_apuracoes) = 0
       OR cardinality(p_apuracoes) <> cardinality(p_entregadores) THEN
        RAISE EXCEPTION 'DADOS_INVALIDOS';
    END IF;

    -- idempotência: mesma (criado_por, chave) devolve o lote já criado
    SELECT l.id, l.status, l.quantidade, l.valor_total INTO v_existente
    FROM "RepasseLote" l WHERE l.criado_por = v_sub AND l.chave_idempotencia = p_chave;
    IF FOUND THEN
        RETURN QUERY SELECT v_existente.id, v_existente.status, v_existente.quantidade, v_existente.valor_total, true;
        RETURN;
    END IF;

    IF cardinality(p_apuracoes) > 5000 THEN RAISE EXCEPTION 'LOTE_ACIMA_DO_LIMITE'; END IF;

    -- par repetido estouraria o UNIQUE (lote_id, apuracao_id, entregador_id) com erro cru
    IF (SELECT count(DISTINCT (a, e)) FROM unnest(p_apuracoes, p_entregadores) AS par(a, e)) <> cardinality(p_apuracoes) THEN
        RAISE EXCEPTION 'DADOS_INVALIDOS';
    END IF;

    -- FOR UPDATE em ordem de id (anti-deadlock entre dois criar concorrentes)
    PERFORM 1
    FROM "ApuracaoRepasseItem" i
    WHERE EXISTS (SELECT 1 FROM unnest(p_apuracoes, p_entregadores) AS par(a, e)
                  WHERE par.a = i.apuracao_id AND par.e = i.entregador_id)
    ORDER BY i.id
    FOR UPDATE;

    -- revalidação de "já em outro lote" SOB o lock
    SELECT string_agg(li.apuracao_id || ':' || li.entregador_id, ',') INTO v_conflitantes
    FROM "RepasseLoteItem" li
    WHERE li.situacao IN ('incluido', 'pago')
      AND EXISTS (SELECT 1 FROM unnest(p_apuracoes, p_entregadores) AS par(a, e)
                  WHERE par.a = li.apuracao_id AND par.e = li.entregador_id);
    IF v_conflitantes IS NOT NULL THEN
        RAISE EXCEPTION 'ITENS_EM_OUTRO_LOTE' USING DETAIL = v_conflitantes;
    END IF;

    SELECT count(*), COALESCE(sum(a.valor_pago), 0)
    INTO v_qtd, v_total
    FROM hub_repasse_lote_avaliar(p_apuracoes, p_entregadores) a
    WHERE a.apta;

    IF v_qtd IS DISTINCT FROM cardinality(p_apuracoes)
       OR v_qtd IS DISTINCT FROM p_quantidade_esperada
       OR v_total IS DISTINCT FROM p_total_esperado::numeric(14,2) THEN
        RAISE EXCEPTION 'PREVIA_DESATUALIZADA';
    END IF;

    INSERT INTO "RepasseLote" (id_empresa, status, criado_por, chave_idempotencia, quantidade, valor_total)
    VALUES (COALESCE(v_empresa, 6), 'GERANDO', v_sub, p_chave, v_qtd, v_total)
    RETURNING "RepasseLote".id INTO v_lote_id;

    FOR v_row IN
        SELECT a.apuracao_id, a.entregador_id, a.id_empresa, a.valor_pago,
               cb.id AS conta_id, cb.titular_nome, cb.titular_documento, cb.banco_codigo,
               cb.agencia, cb.conta, cb.conta_digito, cb.tipo_conta, cb.email_comprovante,
               cfg.descricao_pix_modelo
        FROM hub_repasse_lote_avaliar(p_apuracoes, p_entregadores) a
        JOIN "ContaBancariaMotorista" cb ON cb.id = a.conta_bancaria_id
        JOIN "ApuracaoRepasse" ar ON ar.id = a.apuracao_id
        JOIN "AdiantamentoConfiguracao" cfg ON cfg.id = ar.configuracao_id
        WHERE a.apta  -- refiltra: este statement tem snapshot próprio (READ COMMITTED); sem isso, nota reprovada entre os dois statements vira item
        ORDER BY a.apuracao_id, a.entregador_id
    LOOP
        -- col_documento FORMATADO, não mascarado: o arquivo Transfeera precisa do
        -- documento real (0074 corrigiu exatamente isso no adiantamento; mascarar
        -- aqui geraria um arquivo que o banco recusa).
        -- Descrição Pix: grava o MODELO BRUTO (cortado em 140), de propósito. NÃO renderizar aqui
        -- (já "corrigido" duas vezes por engano). descricao_pix_modelo é editável por operador do
        -- hub e o texto vai num arquivo para um sistema de pagamento de TERCEIRO; interpolar campo
        -- arbitrário vazaria dado não previsto (S5). Quem renderiza é o Node, em
        -- renderizarDescricaoPix (lib/adiantamento-transfeera-xlsx.js), que só aceita
        -- PLACEHOLDERS_PERMITIDOS e LANÇA em qualquer outro {...}; o resultado volta por
        -- hub_repasse_lote_arquivo(p_itens) na mesma transação que marca o lote GERADO. A janela
        -- com modelo bruto existe só em GERANDO (transitório). Mesmo desenho da 0076 (adiantamento).
        INSERT INTO "RepasseLoteItem" (
            lote_id, apuracao_id, entregador_id, id_empresa, linha, col_nome, col_documento, col_email,
            col_banco, col_agencia, col_conta, col_digito, col_tipo_conta, valor,
            col_descricao_pix, conta_bancaria_id, situacao
        ) VALUES (
            v_lote_id, v_row.apuracao_id, v_row.entregador_id, v_row.id_empresa, v_linha,
            v_row.titular_nome, hub_adiantamento_formatar_documento(v_row.titular_documento),
            COALESCE(v_row.email_comprovante, ''), v_row.banco_codigo, v_row.agencia,
            v_row.conta, v_row.conta_digito,
            CASE v_row.tipo_conta WHEN 'CORRENTE' THEN 'Conta Corrente' ELSE 'Conta Poupança' END,
            v_row.valor_pago, left(COALESCE(v_row.descricao_pix_modelo, ''), 140),
            v_row.conta_id, 'incluido'
        ) RETURNING "RepasseLoteItem".id INTO v_item_id;

        UPDATE "RepasseLoteItem" SET col_id_integracao = hub_repasse_integration_id(v_item_id) WHERE id = v_item_id;

        v_linha := v_linha + 1;
    END LOOP;

    RETURN QUERY SELECT v_lote_id, 'GERANDO'::text, v_qtd, v_total::numeric, false;
END;
$$;

-- DROP da versão de 5 parâmetros: sem ele CREATE OR REPLACE deixaria 2 sobrecargas (PostgREST ambíguo).
-- ⚠️ Idempotência: reaplicar a 0108 dropa a de 5 se existir; a de 6 é recriada por OR REPLACE.
DROP FUNCTION IF EXISTS hub_repasse_lote_arquivo(bigint, text, char, int, text);
CREATE OR REPLACE FUNCTION hub_repasse_lote_arquivo(
    p_lote_id bigint, p_arquivo text, p_sha256 char, p_bytes int, p_nome text,
    p_itens jsonb DEFAULT '[]'::jsonb
)
RETURNS TABLE (id bigint, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_lote     "RepasseLote";
    v_bytes    bytea;
    v_sha_calc text;
    v_item     jsonb;
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.lote_criar') THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;

    SELECT * INTO v_lote FROM "RepasseLote" WHERE id = p_lote_id AND id_empresa = ANY (hub_jwt_escopo_ids()) FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NAO_ENCONTRADA'; END IF;
    IF v_lote.status <> 'GERANDO' THEN RAISE EXCEPTION 'TRANSICAO_INVALIDA'; END IF;

    v_bytes := decode(p_arquivo, 'base64');
    v_sha_calc := encode(sha256(v_bytes), 'hex');
    IF v_sha_calc <> lower(p_sha256) THEN RAISE EXCEPTION 'SHA256_DIVERGENTE'; END IF;

    -- descrições Pix já renderizadas/validadas pelo Node, escopadas ao próprio lote
    IF p_itens IS NOT NULL AND jsonb_typeof(p_itens) = 'array' THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
        LOOP
            UPDATE "RepasseLoteItem"
            SET col_descricao_pix = left(v_item ->> 'descricao', 140)
            WHERE id = (v_item ->> 'id')::bigint AND lote_id = p_lote_id;
        END LOOP;
    END IF;

    UPDATE "RepasseLote"
    SET status = 'GERADO', arquivo = v_bytes, arquivo_sha256 = v_sha_calc,
        arquivo_bytes = p_bytes, arquivo_nome = p_nome, gerado_em = now()
    WHERE id = p_lote_id;

    RETURN QUERY SELECT p_lote_id, 'GERADO'::text;
END;
$$;

-- Única porta dos bytes do arquivo.
CREATE OR REPLACE FUNCTION hub_repasse_lote_download(p_lote_id bigint)
RETURNS TABLE (arquivo_base64 text, sha256 text, nome text, downloads int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_lote "RepasseLote";
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.exportar') THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;

    SELECT * INTO v_lote FROM "RepasseLote" WHERE id = p_lote_id AND id_empresa = ANY (hub_jwt_escopo_ids()) FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NAO_ENCONTRADA'; END IF;

    IF v_lote.arquivo_expurgado_em IS NOT NULL THEN
        RAISE EXCEPTION 'ARQUIVO_EXPURGADO' USING DETAIL = to_jsonb(v_lote.arquivo_expurgado_em)::text;
    END IF;

    IF v_lote.status NOT IN ('GERADO', 'EXPORTADO', 'CONCLUIDO', 'CONCLUIDO_COM_FALHAS') OR v_lote.arquivo IS NULL THEN
        RAISE EXCEPTION 'ARQUIVO_INDISPONIVEL';
    END IF;

    IF v_lote.status = 'GERADO' THEN
        UPDATE "RepasseLote" SET status = 'EXPORTADO', primeiro_download_em = now(), downloads = downloads + 1
        WHERE id = p_lote_id;
    ELSE
        UPDATE "RepasseLote" SET downloads = downloads + 1 WHERE id = p_lote_id;
    END IF;

    RETURN QUERY SELECT encode(v_lote.arquivo, 'base64'), v_lote.arquivo_sha256::text, v_lote.arquivo_nome, (v_lote.downloads + 1);
END;
$$;

-- Cancelar devolve os itens ao pool (situacao='cancelado' sai do índice parcial,
-- então a dupla apuração×entregador volta a ser elegível).
CREATE OR REPLACE FUNCTION hub_repasse_lote_cancelar(p_lote_id bigint, p_motivo text, p_nao_enviado boolean DEFAULT false)
RETURNS TABLE (id bigint, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_lote "RepasseLote";
    v_sub  int := NULLIF(hub_jwt_claims() ->> 'sub', '')::int;
BEGIN
    SELECT * INTO v_lote FROM "RepasseLote" WHERE id = p_lote_id AND id_empresa = ANY (hub_jwt_escopo_ids()) FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NAO_ENCONTRADA'; END IF;

    -- além de `reprocessar`, o criador cancela o lote que ELE criou enquanto
    -- ainda GERANDO (socorro quando a montagem do xlsx falha) — igual ao adiantamento.
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
        IF p_nao_enviado IS NOT TRUE THEN RAISE EXCEPTION 'CONFIRMACAO_NAO_ENVIADO_OBRIGATORIA'; END IF;
    ELSE
        RAISE EXCEPTION 'TRANSICAO_INVALIDA';
    END IF;

    UPDATE "RepasseLote"
    SET status = 'CANCELADO', cancelado_em = now(), cancelado_por = v_sub, cancelado_motivo = p_motivo,
        nao_enviado_declarado = p_nao_enviado
    WHERE id = p_lote_id;

    UPDATE "RepasseLoteItem" SET situacao = 'cancelado' WHERE lote_id = p_lote_id AND situacao = 'incluido';

    RETURN QUERY SELECT p_lote_id, 'CANCELADO'::text;
END;
$$;

-- Confirmação do lote (retorno da Transfeera 'retorno' ou à mão 'manual'). Espelha
-- hub_adiantamento_lote_confirmar (viva em 0083): UMA chamada, UMA transação, N motivos.
-- p_falhas = [{id, motivo}], id = RepasseLoteItem.id; viram 'falhou' (cada um com o seu
-- motivo); todo item do lote ainda 'incluido' fora da lista vira 'pago'; sem 'incluido'
-- restante o lote fecha (CONCLUIDO / CONCLUIDO_COM_FALHAS). Exige lote EXPORTADO.
-- Única porta de escrita de situação do item (D9) — não criar outra.
-- 'falhou' não está no índice parcial: o par volta ao pool.
DROP FUNCTION IF EXISTS hub_repasse_lote_item_situacao(bigint[], text, text, text);
CREATE OR REPLACE FUNCTION hub_repasse_lote_confirmar(
    p_lote_id bigint, p_falhas jsonb DEFAULT '[]'::jsonb, p_origem text DEFAULT 'retorno'
)
RETURNS TABLE (id bigint, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_lote   "RepasseLote";
    v_sub    int := NULLIF(hub_jwt_claims() ->> 'sub', '')::int;
    v_ids    bigint[];
    v_falhas int;
    v_final  text;
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.pagamento_confirmar') THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;
    IF p_origem IS NULL OR p_origem NOT IN ('retorno', 'manual') THEN RAISE EXCEPTION 'DADOS_INVALIDOS'; END IF;
    IF jsonb_typeof(COALESCE(p_falhas, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'DADOS_INVALIDOS'; END IF;

    SELECT * INTO v_lote FROM "RepasseLote" WHERE id = p_lote_id AND id_empresa = ANY (hub_jwt_escopo_ids()) FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NAO_ENCONTRADA'; END IF;
    IF v_lote.status <> 'EXPORTADO' THEN RAISE EXCEPTION 'TRANSICAO_INVALIDA'; END IF;

    SELECT array_agg((f ->> 'id')::bigint) INTO v_ids FROM jsonb_array_elements(COALESCE(p_falhas, '[]'::jsonb)) f;

    -- recusas explícitas (nunca silenciosas): id de outro lote/empresa, motivo vazio
    IF EXISTS (
        SELECT 1 FROM unnest(COALESCE(v_ids, ARRAY[]::bigint[])) fid
        WHERE NOT EXISTS (SELECT 1 FROM "RepasseLoteItem" li WHERE li.lote_id = p_lote_id AND li.id = fid)
    ) THEN
        RAISE EXCEPTION 'ITEM_FORA_DO_LOTE';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_falhas, '[]'::jsonb)) f
               WHERE NULLIF(btrim(f ->> 'motivo'), '') IS NULL) THEN
        RAISE EXCEPTION 'MOTIVO_OBRIGATORIO';
    END IF;

    UPDATE "RepasseLoteItem" li
    SET situacao = 'falhou', situacao_motivo = f ->> 'motivo', situacao_em = now(), situacao_por = v_sub, origem_situacao = p_origem
    FROM jsonb_array_elements(COALESCE(p_falhas, '[]'::jsonb)) f
    WHERE li.lote_id = p_lote_id AND li.id = (f ->> 'id')::bigint AND li.situacao = 'incluido';

    UPDATE "RepasseLoteItem"
    SET situacao = 'pago', situacao_em = now(), situacao_por = v_sub, origem_situacao = p_origem
    WHERE lote_id = p_lote_id AND situacao = 'incluido';

    SELECT count(*) INTO v_falhas FROM "RepasseLoteItem" WHERE lote_id = p_lote_id AND situacao = 'falhou';
    v_final := CASE WHEN v_falhas > 0 THEN 'CONCLUIDO_COM_FALHAS' ELSE 'CONCLUIDO' END;
    UPDATE "RepasseLote" SET status = v_final, concluido_em = now() WHERE id = p_lote_id;

    RETURN QUERY SELECT p_lote_id, v_final;
END;
$$;

-- Varredura de órfãos: criar commita o lote em GERANDO e o Node ainda faz mais chamadas
-- HTTP (itens -> arquivo -> cancelar no catch). Se o processo morre nessa janela (deploy,
-- OOM, 502) o lote fica GERANDO e o índice parcial mantém cada par como JA_EM_LOTE para
-- sempre. Espelha hub_adiantamento_lote_orfaos (0067/0077): chamada pelo WORKER (claim
-- hub_adiantamento_worker), não por usuário; a barreira real é o IF dentro da função.
CREATE OR REPLACE FUNCTION hub_repasse_lote_orfaos(p_minutos int DEFAULT 5)
RETURNS TABLE (id bigint, id_empresa int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_lote RECORD;
BEGIN
    IF NOT hub_jwt_adiantamento_worker() THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;

    FOR v_lote IN
        SELECT l.id, l.id_empresa
        FROM "RepasseLote" l
        WHERE l.status = 'GERANDO' AND l.criado_em < now() - make_interval(mins => p_minutos)
        ORDER BY l.id
        FOR UPDATE SKIP LOCKED
    LOOP
        UPDATE "RepasseLote" l2
        SET status = 'CANCELADO', cancelado_em = now(), cancelado_motivo = 'falha_geracao'
        WHERE l2.id = v_lote.id;

        UPDATE "RepasseLoteItem" SET situacao = 'cancelado' WHERE lote_id = v_lote.id AND situacao = 'incluido';

        RETURN QUERY SELECT v_lote.id, v_lote.id_empresa;
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION hub_repasse_lote_avaliar(bigint[], int[]) FROM PUBLIC;

REVOKE ALL ON FUNCTION hub_repasse_integration_id(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_repasse_integration_id(bigint) TO authenticated;

REVOKE ALL ON FUNCTION hub_repasse_lote_previa(bigint[], int[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_repasse_lote_previa(bigint[], int[]) TO authenticated;

REVOKE ALL ON FUNCTION hub_repasse_lote_criar(bigint[], int[], int, numeric, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_repasse_lote_criar(bigint[], int[], int, numeric, uuid) TO authenticated;

REVOKE ALL ON FUNCTION hub_repasse_lote_arquivo(bigint, text, char, int, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_repasse_lote_arquivo(bigint, text, char, int, text, jsonb) TO authenticated;

REVOKE ALL ON FUNCTION hub_repasse_lote_download(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_repasse_lote_download(bigint) TO authenticated;

REVOKE ALL ON FUNCTION hub_repasse_lote_cancelar(bigint, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_repasse_lote_cancelar(bigint, text, boolean) TO authenticated;

REVOKE ALL ON FUNCTION hub_repasse_lote_confirmar(bigint, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_repasse_lote_confirmar(bigint, jsonb, text) TO authenticated;

REVOKE ALL ON FUNCTION hub_repasse_lote_orfaos(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_repasse_lote_orfaos(int) TO authenticated;
