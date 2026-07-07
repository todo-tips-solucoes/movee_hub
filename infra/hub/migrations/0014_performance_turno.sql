-- 0014 — Fato append-only `PerformanceTurno` (data-model.md Entity
-- PerformanceTurno; tasks.md 1.3). Grão = entregador × turno × dia
-- (× subpraça). Decimal com PONTO no CSV original (ao contrário do
-- faturamento, que usa vírgula) — conversão é responsabilidade do parser,
-- não desta migration. Idempotente.
--
-- `entregador_id` NOT NULL: UUID é OBRIGATÓRIO neste CSV (linha sem UUID
-- válido é erro, ao contrário do faturamento onde ausência de UUID vira
-- `recebedor_agregado`). `importacao_id`/`entregador_id` referenciam tabelas
-- hub-local (0010/0011) — FK física.

CREATE TABLE IF NOT EXISTS "PerformanceTurno" (
    id                      serial PRIMARY KEY,
    id_empresa              int NOT NULL,
    importacao_id           int NOT NULL REFERENCES "ImportacaoArquivo"(id),
    entregador_id           int NOT NULL REFERENCES "Entregador"(id),
    data_periodo            date NOT NULL,
    periodo                 text NOT NULL,
    duracao                 interval NULL,
    min_entregadores_escala int NULL CHECK (min_entregadores_escala IS NULL OR min_entregadores_escala >= 0),
    tag                     text NULL,
    praca                   text NULL,
    subpraca                text NULL,
    origem                  text NULL,
    tempo_disponivel_pct    numeric(6,2) NULL CHECK (tempo_disponivel_pct IS NULL OR (tempo_disponivel_pct >= 0 AND tempo_disponivel_pct <= 150)),
    tempo_disponivel        interval NULL,
    corridas_ofertadas      int NOT NULL DEFAULT 0 CHECK (corridas_ofertadas >= 0),
    corridas_aceitas        int NOT NULL DEFAULT 0 CHECK (corridas_aceitas >= 0),
    corridas_rejeitadas     int NOT NULL DEFAULT 0 CHECK (corridas_rejeitadas >= 0),
    corridas_completadas    int NOT NULL DEFAULT 0 CHECK (corridas_completadas >= 0),
    corridas_canceladas     int NOT NULL DEFAULT 0 CHECK (corridas_canceladas >= 0),
    pedidos_concluidos      int NULL,
    taxas_centavos          int NULL,
    hash_linha              char(64) NOT NULL,
    criado_em               timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id_empresa, hash_linha)
);

CREATE INDEX IF NOT EXISTS idx_performanceturno_empresa_data
    ON "PerformanceTurno"(id_empresa, data_periodo);
CREATE INDEX IF NOT EXISTS idx_performanceturno_empresa_entregador_data
    ON "PerformanceTurno"(id_empresa, entregador_id, data_periodo);

-- GRANTs explícitos ao role `authenticated`. Sem DELETE/UPDATE: fato
-- append-only (dedupe por hash_linha, mesma decisão de 0013).
GRANT SELECT, INSERT ON "PerformanceTurno" TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE "PerformanceTurno_id_seq" TO authenticated;
