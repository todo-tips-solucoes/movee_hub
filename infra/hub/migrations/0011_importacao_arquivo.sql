-- 0011 — Cabeçalho de importação: tabela `ImportacaoArquivo` (data-model.md
-- Entity ImportacaoArquivo; research.md Decision 5/6; tasks.md 1.2).
-- Idempotente. `criado_por` referencia "Usuario" (hub-local, 0002) — FK
-- física legítima, ao contrário de `id_empresa` (legado, outro banco).
--
-- Mutex de concorrência (research.md Decision 5, ADENDO dec-033/CHK036):
-- `pg_try_advisory_lock` foi descartado porque `lib/hub-postgrest.js` é HTTP
-- stateless (sem sessão Postgres dedicada persistente entre chamadas). O
-- mecanismo substituto com o MESMO contrato funcional (1 importação ativa por
-- `(id_empresa,tipo)`, demais ficam `pending`, sem 409) é o índice único
-- parcial abaixo: "adquirir" = UPDATE status='validating' WHERE
-- status='pending' (atômico via PostgREST); se colidir com uma linha já
-- `validating`/`processing` do mesmo (id_empresa,tipo), o índice rejeita a
-- transição e a nova importação permanece em `pending` (espera visível).

CREATE TABLE IF NOT EXISTS "ImportacaoArquivo" (
    id                serial PRIMARY KEY,
    id_empresa        int NOT NULL,
    tipo              text NOT NULL CHECK (tipo IN ('faturamento', 'performance', 'envio_massa')),
    nome_arquivo      text NULL,
    hash_sha256       char(64) NOT NULL,
    tamanho_bytes     bigint NULL,
    status            text NOT NULL DEFAULT 'pending' CHECK (status IN (
                          'pending', 'validating', 'processing', 'completed',
                          'completed_with_errors', 'failed', 'cancelled'
                      )),
    total_linhas      int NULL,
    linhas_validas    int NULL,
    linhas_invalidas  int NULL,
    data_referencia   date NULL,
    iniciado_em       timestamptz NULL,
    concluido_em      timestamptz NULL,
    erro_resumo       text NULL,
    criado_por        int NULL REFERENCES "Usuario"(id),
    criado_em         timestamptz NOT NULL DEFAULT now(),
    atualizado_em     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id_empresa, tipo, hash_sha256)
);

CREATE INDEX IF NOT EXISTS idx_importacaoarquivo_empresa_tipo_data
    ON "ImportacaoArquivo"(id_empresa, tipo, data_referencia DESC);

-- Mutex de concorrência (ver cabeçalho): 1 importação ativa (validating ou
-- processing) por (id_empresa, tipo). CREATE INDEX IF NOT EXISTS não existe
-- para índices únicos parciais nomeados de forma idempotente-segura no
-- Postgres < 15 sob DDL concorrente — mas em migração serial (fora de
-- transação concorrente) IF NOT EXISTS é suficiente e idempotente.
CREATE UNIQUE INDEX IF NOT EXISTS importacaoarquivo_uma_ativa_por_tipo
    ON "ImportacaoArquivo" (id_empresa, tipo)
    WHERE status IN ('validating', 'processing');

-- GRANTs explícitos ao role `authenticated`. Sem DELETE: histórico de
-- importação é append-only (auditoria via Auditoria já cobre criação/estado).
GRANT SELECT, INSERT, UPDATE ON "ImportacaoArquivo" TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE "ImportacaoArquivo_id_seq" TO authenticated;
