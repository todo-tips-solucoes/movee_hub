-- 0013 — Fato append-only `FaturamentoLancamento` (data-model.md Entity
-- FaturamentoLancamento; research.md Decision 9; D4/dec-033 ratificação do
-- operador 2026-07-07, DIARIO.md; tasks.md 1.3). Grão = 1 linha do CSV de
-- faturamento (decimal com VÍRGULA no arquivo original, já convertida a
-- ponto pelo parser antes do INSERT). Idempotente.
--
-- `entregador_id` referencia "Entregador" (hub-local, 0010) — FK física.
-- `importacao_id` referencia "ImportacaoArquivo" (hub-local, 0011) — FK
-- física. `atingido`/`margem_fee_*`: D4 RESOLVIDO — ingestão fiel, SEM
-- pré-interpretar negócio (fica para S6/S7): `atingido` numeric(8,2) 0–1000;
-- `margem_fee_raw` cru + `margem_fee_min`/`margem_fee_inter` derivadas via
-- regex `MIN:(x),INTER:(y)` (parse falho ⇒ só `raw`, sem quebrar o insert).

CREATE TABLE IF NOT EXISTS "FaturamentoLancamento" (
    id                            serial PRIMARY KEY,
    id_empresa                    int NOT NULL,
    importacao_id                 int NOT NULL REFERENCES "ImportacaoArquivo"(id),
    entregador_id                 int NULL REFERENCES "Entregador"(id),
    recebedor_agregado            text NULL,
    data_lancamento               date NOT NULL,
    data_referencia               date NOT NULL,
    data_repasse                  date NULL,
    periodo                       text NULL,
    praca                         text NULL,
    subpraca                      text NULL,
    origem                        text NULL,
    tipo                          text NOT NULL,
    valor                         numeric(12,2) NOT NULL CHECK (valor > 0),
    descricao                     text NOT NULL,
    atingido                      numeric(8,2) NULL CHECK (atingido IS NULL OR (atingido >= 0 AND atingido <= 1000)),
    pct_tempo_disponivel          numeric(8,2) NULL,
    pct_aceitacao                 numeric(8,2) NULL,
    pct_conclusao                 numeric(8,2) NULL,
    criterio_tempo_disponivel     numeric(8,2) NULL,
    criterio_rotas_aceitas        numeric(8,2) NULL,
    criterio_rotas_concluidas     numeric(8,2) NULL,
    margem_fee_raw                text NULL,
    margem_fee_min                numeric(8,2) NULL,
    margem_fee_inter              numeric(8,2) NULL,
    hash_linha                    char(64) NOT NULL,
    criado_em                     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id_empresa, hash_linha)
);

CREATE INDEX IF NOT EXISTS idx_faturamentolancamento_empresa_data
    ON "FaturamentoLancamento"(id_empresa, data_referencia);
CREATE INDEX IF NOT EXISTS idx_faturamentolancamento_empresa_entregador_data
    ON "FaturamentoLancamento"(id_empresa, entregador_id, data_referencia);
CREATE INDEX IF NOT EXISTS idx_faturamentolancamento_empresa_descricao
    ON "FaturamentoLancamento"(id_empresa, descricao);

-- GRANTs explícitos ao role `authenticated`. Sem DELETE/UPDATE: fato
-- append-only (research.md Decision 6 — dedupe por hash_linha, reprocessar
-- não sobrescreve, ON CONFLICT DO NOTHING).
GRANT SELECT, INSERT ON "FaturamentoLancamento" TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE "FaturamentoLancamento_id_seq" TO authenticated;
