-- PRE-CHECK da 0131 — SOMENTE LEITURA. Rodar em producao ANTES de aplicar a migration:
--   psql -U <usuario> -d <banco> -f 0131-precheck.sql
-- (transacao READ ONLY: qualquer escrita falha). A funcao hub_adiantamento_categorias_tokens_ok ainda nao existe,
-- por isso a regra e reimplementada inline.
--
-- Leitura: `linhas_que_reprovam` deve ser 0 nas 3 colunas. Se nao for, a 0131 cria o CHECK correspondente como NOT VALID
-- (continua valendo para linhas novas) e emite WARNING; ver os exemplos da 2a consulta.
-- `max_char_length_descricao` e so informativo (o limite de 200 caracteres vale para o NOME de categoria da campanha).
\set ON_ERROR_STOP on
BEGIN READ ONLY;

WITH listas AS (
    SELECT c.id, c.id_empresa, c.versao, v.coluna, v.lista
    FROM "AdiantamentoConfiguracao" c
    CROSS JOIN LATERAL (VALUES ('categorias_producao', c.categorias_producao),
                               ('categorias_extrato',  c.categorias_extrato),
                               ('categorias_nota',     c.categorias_nota)) v(coluna, lista)
), avaliadas AS (
    SELECT l.*, (
        l.lista IS NULL OR (
            NOT EXISTS (SELECT 1 FROM unnest(l.lista) x WHERE x IS NULL)
            AND (SELECT count(*) FROM unnest(l.lista) x WHERE x LIKE 'modo:%') <= 1
            AND NOT EXISTS (SELECT 1 FROM unnest(l.lista) x WHERE x LIKE 'modo:%' AND x <> 'modo:todas')
            AND NOT EXISTS (SELECT 1 FROM unnest(l.lista) x WHERE x LIKE 'familia:%'
                            AND x <> ALL (ARRAY['familia:promocao', 'familia:missoes', 'familia:indicador']))
        )) AS ok
    FROM listas l
)
SELECT coluna, count(*) AS versoes_avaliadas, count(*) FILTER (WHERE NOT ok) AS linhas_que_reprovam
FROM avaliadas GROUP BY coluna ORDER BY coluna;

-- exemplos (ate 20) das que reprovam: id/versao/empresa e os tokens suspeitos (modo:* / familia:*)
WITH listas AS (
    SELECT c.id, c.id_empresa, c.versao, v.coluna, v.lista
    FROM "AdiantamentoConfiguracao" c
    CROSS JOIN LATERAL (VALUES ('categorias_producao', c.categorias_producao),
                               ('categorias_extrato',  c.categorias_extrato),
                               ('categorias_nota',     c.categorias_nota)) v(coluna, lista)
)
SELECT id, id_empresa, versao, coluna,
       (SELECT string_agg(COALESCE(x, '<NULL>'), ' | ') FROM unnest(lista) x
         WHERE x IS NULL OR x LIKE 'modo:%' OR x LIKE 'familia:%') AS tokens
FROM listas
WHERE lista IS NOT NULL AND NOT (
        NOT EXISTS (SELECT 1 FROM unnest(lista) x WHERE x IS NULL)
        AND (SELECT count(*) FROM unnest(lista) x WHERE x LIKE 'modo:%') <= 1
        AND NOT EXISTS (SELECT 1 FROM unnest(lista) x WHERE x LIKE 'modo:%' AND x <> 'modo:todas')
        AND NOT EXISTS (SELECT 1 FROM unnest(lista) x WHERE x LIKE 'familia:%'
                        AND x <> ALL (ARRAY['familia:promocao', 'familia:missoes', 'familia:indicador'])))
ORDER BY id LIMIT 20;

-- campanhas ja gravadas com token que a 0131 passara a recusar nas linhas novas (informativo)
SELECT count(*) AS campanhas_com_modo_ou_familia_desconhecida
FROM "Campanha" k
WHERE k.categorias IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(k.categorias) x
      WHERE x LIKE 'modo:%' OR (x LIKE 'familia:%' AND x <> ALL (ARRAY['familia:promocao', 'familia:missoes', 'familia:indicador'])));

SELECT max(char_length(descricao)) AS max_char_length_descricao, count(*) AS lancamentos FROM "FaturamentoLancamento";

ROLLBACK;
