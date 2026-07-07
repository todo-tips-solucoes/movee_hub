-- 0012 — Erro por linha: tabela `ImportacaoLinhaErro` (data-model.md Entity
-- ImportacaoLinhaErro; research.md Decision 4; tasks.md 1.2). Idempotente.
--
-- `id_empresa` DENORMALIZADO (Decision 4): a linha-pai já carrega
-- `importacao_id -> ImportacaoArquivo.id_empresa`, mas duplicar a coluna aqui
-- permite RLS uniforme direto na tabela (mesmo padrão das outras 4 tabelas
-- novas), sem precisar de subquery/JOIN na policy. `valor_mascarado` NUNCA
-- carrega a linha bruta do CSV (LGPD §7.6) — mascaramento é feito pelo
-- parser/processor antes do INSERT, não por esta migration.

CREATE TABLE IF NOT EXISTS "ImportacaoLinhaErro" (
    id               serial PRIMARY KEY,
    importacao_id    int NOT NULL REFERENCES "ImportacaoArquivo"(id),
    id_empresa       int NOT NULL,
    numero_linha     int NOT NULL,
    motivo           text NOT NULL,
    campo            text NULL,
    valor_mascarado  text NULL,
    criado_em        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_importacaolinhaerro_importacao ON "ImportacaoLinhaErro"(importacao_id);

-- GRANTs explícitos ao role `authenticated`. Sem DELETE/UPDATE: erro de linha
-- é fato imutável de uma corrida de processamento (append-only, igual a
-- Auditoria) — reprocessar gera um novo `importacao_id`/nova leva de erros,
-- nunca edita os antigos.
GRANT SELECT, INSERT ON "ImportacaoLinhaErro" TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE "ImportacaoLinhaErro_id_seq" TO authenticated;
