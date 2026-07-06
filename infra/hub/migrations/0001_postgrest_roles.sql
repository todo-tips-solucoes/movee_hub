-- 0001 — infra mínima do PostgREST próprio do hub (§4.6).
-- NÃO é schema funcional (Prompt A: banco vazio + SchemaMigration): é o role
-- anônimo exigido pelo PostgREST para subir (PGRST_DB_ANON_ROLE=hub_web_anon).
-- Sem permissões de leitura em tabela alguma até as fases funcionais (S3+).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hub_web_anon') THEN
        CREATE ROLE hub_web_anon NOLOGIN;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO hub_web_anon;
