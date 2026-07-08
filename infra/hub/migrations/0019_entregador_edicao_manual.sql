-- 0019 — Entregador: protecao do nome editado manualmente (S5 / hub-motoristas,
-- tasks.md 1.1, data-model.md Entity Entregador, research.md Decision 6).
-- Idempotente (ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE FUNCTION +
-- DROP TRIGGER IF EXISTS/CREATE TRIGGER). Aplicada por migrate.sh, que
-- registra em "SchemaMigration" e envia SIGUSR1 ao PostgREST.
--
-- Objetivo: quando um operador edita manualmente o nome de um Entregador
-- (PATCH /motoristas/:id, FASE 4), uma reimportacao subsequente do pipeline
-- S4 (upsert por id_externo) NAO deve sobrescrever esse nome. O trigger
-- intercepta qualquer UPDATE na linha e, se nome_editado_manualmente=true,
-- forca NEW.nome de volta ao valor anterior — nao importa quem fez o UPDATE
-- (pipeline S4 ou qualquer outro caller), preservando a edicao manual sem
-- exigir que o pipeline S4 conheca esta regra.

ALTER TABLE "Entregador"
    ADD COLUMN IF NOT EXISTS nome_editado_manualmente boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION hub_protege_nome_editado_entregador()
RETURNS trigger AS $$
BEGIN
    IF OLD.nome_editado_manualmente THEN
        NEW.nome := OLD.nome;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_entregador_protege_nome ON "Entregador";
CREATE TRIGGER trg_entregador_protege_nome
    BEFORE UPDATE ON "Entregador"
    FOR EACH ROW EXECUTE FUNCTION hub_protege_nome_editado_entregador();
