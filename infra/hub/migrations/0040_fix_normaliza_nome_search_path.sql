-- 0040 — corretiva (S10): hub_normaliza_nome com unaccent SCHEMA-QUALIFICADO.
--
-- Achado do ensaio de rollback da S10 (evidencias/S10/rollback/): o
-- pg_restore de um dump -Fc roda com search_path VAZIO (comportamento padrão
-- do pg_dump desde o fix de CVE-2018-1058); a função criada pela 0021
-- chamava unaccent() sem qualificar o schema e o CREATE INDEX
-- idx_conta_motorista_nome_trgm falhava no restore com "function
-- unaccent(text) does not exist" (1 erro ignorado) — ou seja, o backup do
-- banco NÃO restaurava limpo, exatamente o cenário que o rollback do
-- cutover precisa garantir.
--
-- Migration CORRETIVA (preferível a editar a 0021 já aplicada — plano
-- técnico §4.10 item 11). Idempotente: CREATE OR REPLACE com corpo de mesma
-- semântica, apenas qualificado; o índice existente permanece válido e não
-- precisa de rebuild (a função é a mesma, resolvida agora sem depender de
-- search_path).
CREATE OR REPLACE FUNCTION hub_normaliza_nome(texto text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT lower(public.unaccent(coalesce(texto, '')));
$$;
