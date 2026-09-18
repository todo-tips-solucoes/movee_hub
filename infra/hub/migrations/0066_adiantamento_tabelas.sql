-- 0066 — Tabelas da feature "Adiantamento pelo App, Dados Bancários e
-- Exportação Transfeera" (tasks.md 1.1; data-model.md — todas as entidades
-- cobertas por este arquivo: AdiantamentoConfiguracao, ContaBancariaMotorista,
-- AdiantamentoSolicitacao, AdiantamentoLote, AdiantamentoEvento,
-- AdiantamentoLoteItem). NotificacaoMotorista e a alteração de Aviso ficam em
-- 0068 (FASE 5); a auditoria (policy de INSERT) fica em 0069 (FASE 1.3); o
-- módulo/permissões ficam em 0070 (FASE 1.4); as funções/RPCs/trigger de
-- transição ficam em 0067 (FASE 1.2) — este arquivo só cria tabelas, índices,
-- CHECKs, RLS e GRANTs mínimos, sem nenhuma função de negócio nova.
--
-- Convenções herdadas (data-model.md cabeçalho; 0006/0015/0021/0061):
--   tabelas em "PascalCase", colunas em snake_case; CREATE TABLE IF NOT
--   EXISTS; dinheiro numeric(12,2) (totais de lote numeric(14,2)), datas de
--   negócio date, instantes timestamptz; migrations idempotentes.
--   Escrita só por funções `hub_adiantamento_*` SECURITY DEFINER (0067) — as
--   tabelas aqui NÃO recebem GRANT INSERT/UPDATE/DELETE a `authenticated`,
--   nem GRANT de sequência (mesmo padrão de 0061 — comparar com 0010/0021,
--   anteriores à convenção SECURITY DEFINER-only).
--
-- RLS (Constitution II, dec-023, security CHK010): todas as 6 tabelas têm
-- `id_empresa` e RLS habilitada por `id_empresa = ANY (hub_jwt_escopo_ids())`
-- (função já criada em 0006). Duas exceções ao "SELECT direto liberado":
--   - "ContaBancariaMotorista": RLS habilitada, SEM política e SEM GRANT
--     SELECT — só as funções SECURITY DEFINER (dono da tabela) tocam a
--     tabela (mesmo padrão de AvisoEntrega/PushInscricao em 0061).
--   - "AdiantamentoLote": GRANT SELECT por COLUNA, excluindo `arquivo`
--     (bytea) — os bytes do arquivo só saem pela RPC de download.

-- ─────────────────────────────────────────────────────────────────────────
-- Helper: valida `dias_habilitados` (elementos em 0..6, sem repetição).
-- Função em vez de subquery inline no CHECK — CHECK constraint não pode
-- conter subquery diretamente (só chamada de função), mesmo padrão de
-- hub_normaliza_nome (0021).
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION hub_adiantamento_dias_validos(dias smallint[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT dias <@ ARRAY[0,1,2,3,4,5,6]::smallint[]
       AND cardinality(dias) = cardinality(ARRAY(SELECT DISTINCT unnest(dias)));
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- AdiantamentoConfiguracao — versionada, só inserção (data-model.md Entity
-- AdiantamentoConfiguracao).
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "AdiantamentoConfiguracao" (
    id                         bigserial PRIMARY KEY,
    id_empresa                 int NOT NULL,
    versao                     int NOT NULL,
    vigente_desde              timestamptz NOT NULL DEFAULT now(),
    timezone                   text NOT NULL,
    dias_habilitados           smallint[] NOT NULL,
    horario_abertura           time NOT NULL,
    horario_corte              time NOT NULL,
    percentual                 numeric(5,2) NOT NULL,
    taxa_fixa                  numeric(12,2) NOT NULL,
    fonte_producao             text NULL,
    categorias_producao        text[] NULL,
    previsao_pagamento_texto   text NOT NULL,
    descricao_pix_modelo       text NOT NULL,
    apuracao_dia_inicio        smallint NULL,
    apuracao_dias_ate_repasse  smallint NULL,
    apuracao_data_base         text NULL,
    categorias_extrato         text[] NULL,
    desconto_adiantamentos     boolean NOT NULL DEFAULT true,
    desconto_debitos           boolean NOT NULL DEFAULT false,
    repasse_visivel_app        boolean NOT NULL DEFAULT false,
    criado_por                 int NULL REFERENCES "Usuario"(id),
    criado_em                  timestamptz NOT NULL DEFAULT now(),
    motivo                     text NULL,
    CONSTRAINT adiantamentoconfiguracao_versao_uniq UNIQUE (id_empresa, versao),
    CONSTRAINT adiantamentoconfiguracao_timezone_chk CHECK (timezone IN ('America/Sao_Paulo')),
    CONSTRAINT adiantamentoconfiguracao_dias_chk CHECK (hub_adiantamento_dias_validos(dias_habilitados)),
    CONSTRAINT adiantamentoconfiguracao_horario_chk CHECK (horario_abertura < horario_corte),
    CONSTRAINT adiantamentoconfiguracao_percentual_chk CHECK (percentual > 0 AND percentual <= 100),
    CONSTRAINT adiantamentoconfiguracao_taxa_chk CHECK (taxa_fixa >= 0),
    CONSTRAINT adiantamentoconfiguracao_fonte_chk CHECK (
        fonte_producao IS NULL
        OR fonte_producao IN ('financeiro_lancamento', 'financeiro_referencia', 'performance_taxas')
    ),
    CONSTRAINT adiantamentoconfiguracao_categorias_obrigatorias_chk CHECK (
        (fonte_producao IS DISTINCT FROM 'financeiro_lancamento'
            AND fonte_producao IS DISTINCT FROM 'financeiro_referencia')
        OR (categorias_producao IS NOT NULL AND cardinality(categorias_producao) > 0)
    ),
    CONSTRAINT adiantamentoconfiguracao_previsao_chk CHECK (char_length(previsao_pagamento_texto) BETWEEN 1 AND 120),
    CONSTRAINT adiantamentoconfiguracao_pix_modelo_chk CHECK (descricao_pix_modelo LIKE '%{nome}%'),
    CONSTRAINT adiantamentoconfiguracao_apuracao_dia_chk CHECK (apuracao_dia_inicio IS NULL OR apuracao_dia_inicio BETWEEN 0 AND 6),
    CONSTRAINT adiantamentoconfiguracao_apuracao_dias_chk CHECK (apuracao_dias_ate_repasse IS NULL OR apuracao_dias_ate_repasse >= 0),
    CONSTRAINT adiantamentoconfiguracao_apuracao_base_chk CHECK (
        apuracao_data_base IS NULL OR apuracao_data_base IN ('data_lancamento', 'data_referencia')
    ),
    CONSTRAINT adiantamentoconfiguracao_motivo_chk CHECK (motivo IS NULL OR char_length(motivo) <= 500)
);

CREATE INDEX IF NOT EXISTS idx_adiantamentoconfiguracao_empresa_vigencia
    ON "AdiantamentoConfiguracao" (id_empresa, vigente_desde DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- ContaBancariaMotorista (data-model.md Entity ContaBancariaMotorista).
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "ContaBancariaMotorista" (
    id                        bigserial PRIMARY KEY,
    id_empresa                int NOT NULL,
    entregador_id             int NOT NULL REFERENCES "Entregador"(id),
    conta_motorista_id        int NULL REFERENCES "ContaMotorista"(id),
    origem                    text NOT NULL,
    status                    text NOT NULL,
    titular_nome              text NOT NULL,
    titular_documento         text NOT NULL,
    titular_tipo              text NOT NULL,
    banco_codigo              text NOT NULL,
    banco_nome                text NOT NULL,
    agencia                   text NOT NULL,
    conta                     text NOT NULL,
    conta_digito              text NOT NULL,
    tipo_conta                text NOT NULL,
    chave_pix_tipo            text NULL,
    chave_pix                 text NULL,
    email_comprovante         text NULL,
    alertas                   jsonb NOT NULL DEFAULT '[]',
    motivo_rejeicao           text NULL,
    entregador_confirmado_id  int NULL,
    solicitada_em             timestamptz NOT NULL DEFAULT now(),
    revisada_em               timestamptz NULL,
    revisada_por              int NULL REFERENCES "Usuario"(id),
    CONSTRAINT contabancariamotorista_origem_chk CHECK (origem IN ('APP', 'CARGA_INICIAL')),
    CONSTRAINT contabancariamotorista_status_chk CHECK (
        status IN ('PENDENTE', 'APROVADA', 'REJEITADA', 'SUBSTITUIDA', 'CANCELADA')
    ),
    CONSTRAINT contabancariamotorista_titular_nome_chk CHECK (char_length(btrim(titular_nome)) BETWEEN 1 AND 120),
    CONSTRAINT contabancariamotorista_documento_chk CHECK (
        titular_documento ~ '^[0-9]{11}$' OR titular_documento ~ '^[0-9]{14}$'
    ),
    CONSTRAINT contabancariamotorista_tipo_chk CHECK (
        (titular_tipo = 'PF' AND char_length(titular_documento) = 11)
        OR (titular_tipo = 'PJ' AND char_length(titular_documento) = 14)
    ),
    CONSTRAINT contabancariamotorista_banco_codigo_chk CHECK (banco_codigo ~ '^[0-9]{3}$'),
    CONSTRAINT contabancariamotorista_agencia_chk CHECK (agencia ~ '^[0-9]{4}$'),
    CONSTRAINT contabancariamotorista_conta_chk CHECK (conta ~ '^[0-9]{1,20}$'),
    CONSTRAINT contabancariamotorista_digito_chk CHECK (conta_digito ~ '^[0-9X]$'),
    CONSTRAINT contabancariamotorista_tipo_conta_chk CHECK (tipo_conta IN ('CORRENTE', 'POUPANCA')),
    CONSTRAINT contabancariamotorista_pix_tipo_chk CHECK (
        chave_pix_tipo IS NULL OR chave_pix_tipo IN ('CPF', 'CNPJ', 'EMAIL', 'TELEFONE', 'ALEATORIA')
    ),
    CONSTRAINT contabancariamotorista_pix_obrigatoria_chk CHECK (chave_pix_tipo IS NULL OR chave_pix IS NOT NULL),
    CONSTRAINT contabancariamotorista_email_chk CHECK (email_comprovante IS NULL OR char_length(email_comprovante) <= 254),
    CONSTRAINT contabancariamotorista_motivo_rejeicao_len_chk CHECK (motivo_rejeicao IS NULL OR char_length(motivo_rejeicao) <= 500),
    CONSTRAINT contabancariamotorista_motivo_rejeicao_obrigatorio_chk CHECK (
        status <> 'REJEITADA' OR motivo_rejeicao IS NOT NULL
    ),
    CONSTRAINT contabancariamotorista_confirmado_obrigatorio_chk CHECK (
        status <> 'APROVADA' OR entregador_confirmado_id IS NOT NULL
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_contabancariamotorista_aprovada
    ON "ContaBancariaMotorista" (entregador_id) WHERE status = 'APROVADA';
CREATE UNIQUE INDEX IF NOT EXISTS uniq_contabancariamotorista_pendente
    ON "ContaBancariaMotorista" (entregador_id) WHERE status = 'PENDENTE';
CREATE INDEX IF NOT EXISTS idx_contabancariamotorista_empresa_status
    ON "ContaBancariaMotorista" (id_empresa, status, solicitada_em DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- AdiantamentoSolicitacao (data-model.md Entity AdiantamentoSolicitacao).
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "AdiantamentoSolicitacao" (
    id                     bigserial PRIMARY KEY,
    id_empresa             int NOT NULL,
    conta_motorista_id     int NOT NULL REFERENCES "ContaMotorista"(id),
    cnpj_prestador         text NOT NULL,
    entregador_id          int NOT NULL REFERENCES "Entregador"(id),
    configuracao_id        bigint NOT NULL REFERENCES "AdiantamentoConfiguracao"(id),
    data_solicitacao       date NOT NULL,
    data_producao          date NOT NULL,
    solicitada_em          timestamptz NOT NULL DEFAULT now(),
    aceite_texto_sha256    char(64) NOT NULL,
    status                 text NOT NULL,
    motivo_status          text NULL,
    chave_idempotencia     uuid NOT NULL,
    fonte_producao         text NULL,
    categorias_producao    text[] NULL,
    producao_valor         numeric(12,2) NULL,
    producao_lancamentos   int NULL,
    producao_por_categoria jsonb NULL,
    percentual             numeric(5,2) NULL,
    valor_bruto            numeric(12,2) NULL,
    taxa                   numeric(12,2) NULL,
    valor_liquido          numeric(12,2) NULL,
    calculado_em           timestamptz NULL,
    tentativas_producao    int NOT NULL DEFAULT 0,
    conta_bancaria_id      bigint NULL REFERENCES "ContaBancariaMotorista"(id),
    CONSTRAINT adiantamentosolicitacao_cnpj_chk CHECK (cnpj_prestador ~ '^[0-9]{14}$'),
    CONSTRAINT adiantamentosolicitacao_data_producao_chk CHECK (data_producao = data_solicitacao - 1),
    CONSTRAINT adiantamentosolicitacao_status_chk CHECK (status IN (
        'AGUARDANDO_CORTE', 'AGUARDANDO_PRODUCAO', 'LIBERADA', 'EM_LOTE', 'EXPORTADA',
        'PAGA', 'FALHOU', 'INELEGIVEL', 'REJEITADA', 'CANCELADA', 'ENCERRADA'
    )),
    CONSTRAINT adiantamentosolicitacao_liberada_exige_dados_chk CHECK (
        status NOT IN ('LIBERADA', 'EM_LOTE', 'EXPORTADA', 'PAGA', 'FALHOU')
        OR (valor_liquido > 0 AND conta_bancaria_id IS NOT NULL)
    ),
    CONSTRAINT adiantamentosolicitacao_rejeitada_exige_motivo_chk CHECK (
        status <> 'REJEITADA' OR motivo_status IS NOT NULL
    ),
    -- ENCERRADA (D-23, operador 2026-09-17): FALHOU -> ENCERRADA por ação do
    -- financeiro quando a falha não será mais paga; motivo obrigatório
    -- (mesmo espírito de REJEITADA). Ajuste feito enquanto 0066 só existiu em
    -- stacks efêmeros hub-test-* (regra 3 da execução) — Decisão registrada.
    CONSTRAINT adiantamentosolicitacao_encerrada_exige_motivo_chk CHECK (
        status <> 'ENCERRADA' OR motivo_status IS NOT NULL
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_adiantamentosolicitacao_conta_dia
    ON "AdiantamentoSolicitacao" (conta_motorista_id, data_solicitacao) WHERE status <> 'CANCELADA';
CREATE UNIQUE INDEX IF NOT EXISTS uniq_adiantamentosolicitacao_entregador_producao
    ON "AdiantamentoSolicitacao" (entregador_id, data_producao) WHERE status <> 'CANCELADA';
CREATE UNIQUE INDEX IF NOT EXISTS uniq_adiantamentosolicitacao_idempotencia
    ON "AdiantamentoSolicitacao" (conta_motorista_id, chave_idempotencia);
CREATE INDEX IF NOT EXISTS idx_adiantamentosolicitacao_tick
    ON "AdiantamentoSolicitacao" (status, data_solicitacao) WHERE status IN ('AGUARDANDO_CORTE', 'AGUARDANDO_PRODUCAO');
CREATE INDEX IF NOT EXISTS idx_adiantamentosolicitacao_empresa_data
    ON "AdiantamentoSolicitacao" (id_empresa, data_solicitacao DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- AdiantamentoLote (data-model.md Entity AdiantamentoLote). Criada antes de
-- AdiantamentoEvento por causa da FK lote_id (nullable) de Evento.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "AdiantamentoLote" (
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
    CONSTRAINT adiantamentolote_idempotencia_uniq UNIQUE (criado_por, chave_idempotencia),
    CONSTRAINT adiantamentolote_status_chk CHECK (
        status IN ('GERANDO', 'GERADO', 'EXPORTADO', 'CONCLUIDO', 'CONCLUIDO_COM_FALHAS', 'CANCELADO')
    ),
    CONSTRAINT adiantamentolote_quantidade_chk CHECK (quantidade BETWEEN 1 AND 5000),
    CONSTRAINT adiantamentolote_valor_total_chk CHECK (valor_total > 0),
    -- Literal de data-model.md: "GERADO exige arquivo, arquivo_sha256 e
    -- arquivo_bytes não nulos" — escopo só do status GERADO, não estendido
    -- por inferência aos estados posteriores (EXPORTADO/CONCLUIDO/…).
    CONSTRAINT adiantamentolote_gerado_exige_arquivo_chk CHECK (
        status <> 'GERADO' OR (arquivo IS NOT NULL AND arquivo_sha256 IS NOT NULL AND arquivo_bytes IS NOT NULL)
    ),
    CONSTRAINT adiantamentolote_cancelado_exige_motivo_chk CHECK (
        status <> 'CANCELADO' OR cancelado_motivo IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_adiantamentolote_empresa_criado
    ON "AdiantamentoLote" (id_empresa, criado_em DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- AdiantamentoEvento — só inserção (data-model.md Entity AdiantamentoEvento).
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "AdiantamentoEvento" (
    id               bigserial PRIMARY KEY,
    solicitacao_id   bigint NOT NULL REFERENCES "AdiantamentoSolicitacao"(id),
    id_empresa       int NOT NULL,
    status_de        text NULL,
    status_para      text NOT NULL,
    ocorrido_em      timestamptz NOT NULL DEFAULT now(),
    ator_tipo        text NOT NULL,
    ator_usuario_id  int NULL REFERENCES "Usuario"(id),
    motivo           text NULL,
    lote_id          bigint NULL REFERENCES "AdiantamentoLote"(id),
    dados            jsonb NOT NULL DEFAULT '{}',
    CONSTRAINT adiantamentoevento_ator_tipo_chk CHECK (ator_tipo IN ('motorista', 'sistema', 'usuario')),
    CONSTRAINT adiantamentoevento_motivo_chk CHECK (motivo IS NULL OR char_length(motivo) <= 500)
);

CREATE INDEX IF NOT EXISTS idx_adiantamentoevento_solicitacao
    ON "AdiantamentoEvento" (solicitacao_id, ocorrido_em);

-- ─────────────────────────────────────────────────────────────────────────
-- AdiantamentoLoteItem (data-model.md Entity AdiantamentoLoteItem).
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "AdiantamentoLoteItem" (
    id                     bigserial PRIMARY KEY,
    lote_id                bigint NOT NULL REFERENCES "AdiantamentoLote"(id),
    solicitacao_id         bigint NOT NULL REFERENCES "AdiantamentoSolicitacao"(id),
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
    col_id_integracao      text NOT NULL,
    col_data_agendamento   text NOT NULL DEFAULT '',
    col_descricao_pix      text NOT NULL,
    conta_bancaria_id      bigint NOT NULL REFERENCES "ContaBancariaMotorista"(id),
    situacao               text NOT NULL,
    situacao_motivo        text NULL,
    situacao_em            timestamptz NULL,
    situacao_por           int NULL REFERENCES "Usuario"(id),
    origem_situacao        text NULL,
    item_anterior_id       bigint NULL REFERENCES "AdiantamentoLoteItem"(id),
    CONSTRAINT adiantamentoloteitem_lote_linha_uniq UNIQUE (lote_id, linha),
    CONSTRAINT adiantamentoloteitem_linha_chk CHECK (linha >= 3),
    CONSTRAINT adiantamentoloteitem_valor_chk CHECK (valor > 0),
    CONSTRAINT adiantamentoloteitem_descricao_pix_chk CHECK (char_length(col_descricao_pix) <= 140),
    CONSTRAINT adiantamentoloteitem_situacao_chk CHECK (situacao IN ('incluido', 'pago', 'falhou', 'cancelado')),
    CONSTRAINT adiantamentoloteitem_situacao_motivo_chk CHECK (situacao <> 'falhou' OR situacao_motivo IS NOT NULL),
    CONSTRAINT adiantamentoloteitem_origem_chk CHECK (origem_situacao IS NULL OR origem_situacao IN ('retorno', 'manual'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_adiantamentoloteitem_solicitacao_ativa
    ON "AdiantamentoLoteItem" (solicitacao_id) WHERE situacao IN ('incluido', 'pago');
CREATE INDEX IF NOT EXISTS idx_adiantamentoloteitem_lote
    ON "AdiantamentoLoteItem" (lote_id);

-- ─────────────────────────────────────────────────────────────────────────
-- RLS (Constitution II; dec-023) — nega por padrão; ContaBancariaMotorista
-- fica SEM política (RLS habilitada + 0 políticas = nega tudo a
-- `authenticated`; só as funções SECURITY DEFINER, rodando como dono da
-- tabela, tocam a tabela — mesmo raciocínio de 0006/0061).
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "AdiantamentoConfiguracao" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContaBancariaMotorista" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdiantamentoSolicitacao" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdiantamentoLote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdiantamentoEvento" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdiantamentoLoteItem" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS adiantamentoconfiguracao_select_por_escopo ON "AdiantamentoConfiguracao";
CREATE POLICY adiantamentoconfiguracao_select_por_escopo ON "AdiantamentoConfiguracao"
    FOR SELECT
    USING (id_empresa = ANY (hub_jwt_escopo_ids()));

DROP POLICY IF EXISTS adiantamentosolicitacao_select_por_escopo ON "AdiantamentoSolicitacao";
CREATE POLICY adiantamentosolicitacao_select_por_escopo ON "AdiantamentoSolicitacao"
    FOR SELECT
    USING (id_empresa = ANY (hub_jwt_escopo_ids()));

DROP POLICY IF EXISTS adiantamentolote_select_por_escopo ON "AdiantamentoLote";
CREATE POLICY adiantamentolote_select_por_escopo ON "AdiantamentoLote"
    FOR SELECT
    USING (id_empresa = ANY (hub_jwt_escopo_ids()));

DROP POLICY IF EXISTS adiantamentoevento_select_por_escopo ON "AdiantamentoEvento";
CREATE POLICY adiantamentoevento_select_por_escopo ON "AdiantamentoEvento"
    FOR SELECT
    USING (id_empresa = ANY (hub_jwt_escopo_ids()));

DROP POLICY IF EXISTS adiantamentoloteitem_select_por_escopo ON "AdiantamentoLoteItem";
CREATE POLICY adiantamentoloteitem_select_por_escopo ON "AdiantamentoLoteItem"
    FOR SELECT
    USING (id_empresa = ANY (hub_jwt_escopo_ids()));

-- Escrita é exclusiva das funções SECURITY DEFINER de 0067 — só SELECT vai
-- para `authenticated`; sem GRANT de sequência (mesmo padrão 0061).
GRANT SELECT ON "AdiantamentoConfiguracao" TO authenticated;
GRANT SELECT ON "AdiantamentoSolicitacao" TO authenticated;
GRANT SELECT ON "AdiantamentoEvento" TO authenticated;
GRANT SELECT ON "AdiantamentoLoteItem" TO authenticated;

-- AdiantamentoLote: GRANT por coluna, excluindo `arquivo` (dec-023, CHK010)
-- — os bytes do arquivo só saem pela RPC de download (0067).
GRANT SELECT (
    id, id_empresa, status, criado_por, criado_em, chave_idempotencia,
    quantidade, valor_total, arquivo_nome, arquivo_sha256, arquivo_bytes,
    arquivo_expurgado_em, gerado_em, primeiro_download_em, downloads,
    cancelado_em, cancelado_por, cancelado_motivo, nao_enviado_declarado,
    concluido_em
) ON "AdiantamentoLote" TO authenticated;

-- ContaBancariaMotorista: nenhum GRANT direto — só as funções SECURITY
-- DEFINER (dono da tabela) leem/escrevem (dec-023, CHK010).

-- ─────────────────────────────────────────────────────────────────────────
-- ApuracaoRepasse / ApuracaoRepasseItem (data-model.md; desbloqueadas por
-- D-23, operador 2026-09-17 — antes bloqueadas por CHK025/tarefa 4.5).
-- Adicionadas aqui (0066) em vez de numa migration nova porque 0066 ainda só
-- existia em stacks efêmeros hub-test-* no momento da decisão (regra 3 desta
-- execução); Decisão registrada no state da onda. Snapshot imutável ao
-- fechar um período (R-15/R-16) — mesmo padrão de imutabilidade de
-- "Auditoria" (0004:27-41): REVOKE explícito + trigger que bloqueia
-- INCONDICIONALMENTE qualquer UPDATE/DELETE.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "ApuracaoRepasse" (
    id              bigserial PRIMARY KEY,
    id_empresa      int NOT NULL,
    periodo_inicio  date NOT NULL,
    periodo_fim     date NOT NULL,
    data_repasse    date NOT NULL,
    configuracao_id bigint NOT NULL REFERENCES "AdiantamentoConfiguracao"(id),
    fechado_por     int NOT NULL REFERENCES "Usuario"(id),
    fechado_em      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT apuracaorepasse_periodo_uniq UNIQUE (id_empresa, periodo_inicio),
    CONSTRAINT apuracaorepasse_periodo_fim_chk CHECK (periodo_fim = periodo_inicio + 6)
);

CREATE TABLE IF NOT EXISTS "ApuracaoRepasseItem" (
    id            bigserial PRIMARY KEY,
    apuracao_id   bigint NOT NULL REFERENCES "ApuracaoRepasse"(id),
    id_empresa    int NOT NULL,
    entregador_id int NOT NULL REFERENCES "Entregador"(id),
    creditos      numeric(12,2) NOT NULL,
    adiantamentos numeric(12,2) NOT NULL,
    debitos       numeric(12,2) NOT NULL,
    remanescente  numeric(12,2) NOT NULL,
    detalhe       jsonb NOT NULL DEFAULT '{}',
    CONSTRAINT apuracaorepasseitem_entregador_uniq UNIQUE (apuracao_id, entregador_id)
);

CREATE INDEX IF NOT EXISTS idx_apuracaorepasseitem_apuracao ON "ApuracaoRepasseItem" (apuracao_id);

ALTER TABLE "ApuracaoRepasse" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApuracaoRepasseItem" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS apuracaorepasse_select_por_escopo ON "ApuracaoRepasse";
CREATE POLICY apuracaorepasse_select_por_escopo ON "ApuracaoRepasse"
    FOR SELECT
    USING (id_empresa = ANY (hub_jwt_escopo_ids()));

DROP POLICY IF EXISTS apuracaorepasseitem_select_por_escopo ON "ApuracaoRepasseItem";
CREATE POLICY apuracaorepasseitem_select_por_escopo ON "ApuracaoRepasseItem"
    FOR SELECT
    USING (id_empresa = ANY (hub_jwt_escopo_ids()));

GRANT SELECT ON "ApuracaoRepasse" TO authenticated;
GRANT SELECT ON "ApuracaoRepasseItem" TO authenticated;

REVOKE UPDATE, DELETE ON "ApuracaoRepasse" FROM authenticated;
REVOKE UPDATE, DELETE ON "ApuracaoRepasseItem" FROM authenticated;

CREATE OR REPLACE FUNCTION hub_bloqueia_alteracao_apuracao()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'ApuracaoRepasse e imutavel: UPDATE/DELETE bloqueados (R-15/R-16, D-23)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_apuracaorepasse_bloqueia_alteracao ON "ApuracaoRepasse";
CREATE TRIGGER trg_apuracaorepasse_bloqueia_alteracao
    BEFORE UPDATE OR DELETE ON "ApuracaoRepasse"
    FOR EACH ROW EXECUTE FUNCTION hub_bloqueia_alteracao_apuracao();

DROP TRIGGER IF EXISTS trg_apuracaorepasseitem_bloqueia_alteracao ON "ApuracaoRepasseItem";
CREATE TRIGGER trg_apuracaorepasseitem_bloqueia_alteracao
    BEFORE UPDATE OR DELETE ON "ApuracaoRepasseItem"
    FOR EACH ROW EXECUTE FUNCTION hub_bloqueia_alteracao_apuracao();
