-- 0021 — ContaMotorista (espelho local read-mostly do app motorista, NUNCA
-- fonte de verdade nem ponte de rede para producao) + extensoes de
-- similaridade + FK fisica/indice unico em Entregador.motorista_id (S5 /
-- hub-motoristas, tasks.md 1.3, data-model.md Entity ContaMotorista,
-- research.md Decisions 2-4). Idempotente (CREATE TABLE/EXTENSION/INDEX IF
-- NOT EXISTS; ADD CONSTRAINT protegido por bloco DO). Aplicada por
-- migrate.sh, que registra em "SchemaMigration" e envia SIGUSR1 ao
-- PostgREST.
--
-- ContaMotorista e populada por seed deterministico
-- (infra/hub/scripts/gen-seeds.py), nunca por sincronizacao ao vivo com
-- "Motorista" em chatmasterveloz — nenhuma integracao de rede com producao
-- (Constitution V / plan.md gate V).

CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS "ContaMotorista" (
    id                 serial PRIMARY KEY,
    cnpj_prestador     text NOT NULL UNIQUE,
    nome               text NOT NULL,
    ativo              boolean NOT NULL DEFAULT true,
    cadastro_completo  boolean NOT NULL DEFAULT true,
    criado_em          timestamptz NOT NULL DEFAULT now(),
    atualizado_em      timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION hub_normaliza_nome(texto text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT lower(unaccent(coalesce(texto, '')));
$$;

CREATE INDEX IF NOT EXISTS idx_conta_motorista_nome_trgm
    ON "ContaMotorista" USING gin (hub_normaliza_nome(nome) gin_trgm_ops);

GRANT SELECT, INSERT, UPDATE ON "ContaMotorista" TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE "ContaMotorista_id_seq" TO authenticated;

-- FK fisica Entregador.motorista_id -> ContaMotorista(id) + indice unico
-- parcial (uma conta em no maximo um Entregador — FR-012). ADD CONSTRAINT
-- nao tem forma IF NOT EXISTS nativa; protegido via bloco DO idempotente.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_entregador_conta_motorista'
    ) THEN
        ALTER TABLE "Entregador"
            ADD CONSTRAINT fk_entregador_conta_motorista
                FOREIGN KEY (motorista_id) REFERENCES "ContaMotorista"(id);
    END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_entregador_motorista_id_unico
    ON "Entregador"(motorista_id) WHERE motorista_id IS NOT NULL;
