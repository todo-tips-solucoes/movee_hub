-- prontidao-login-hub.sql — SOMENTE LEITURA. Checagem da virada de HUB_MOTORISTA_LOGIN_CONTA_ATIVA=true.
--
-- Criterio unico: nenhum motorista pode perder acesso ao ligar a chave. Conta-se "Motorista" com senha NOT NULL
-- para o qual NAO existe "ContaMotorista" com o mesmo CNPJ (so digitos), a mesma senha e o mesmo ativo.
-- Nao imprime hash nem CNPJ completo (mascarado: 2 primeiros + 4 ultimos digitos).
-- A ULTIMA linha da saida e o veredito: "PRONTO" ou "NAO PRONTO: N motoristas perderiam acesso".
--
-- Uso:
--   PGOPTIONS='-c default_transaction_read_only=on' psql -d <banco> -v ON_ERROR_STOP=1 -At -f infra/hub/scripts/prontidao-login-hub.sql

WITH perderiam AS (
SELECT m.id, m.nome,
       left(regexp_replace(m.cnpj_prestador, '\D', '', 'g'), 2) || '******' ||
       right(regexp_replace(m.cnpj_prestador, '\D', '', 'g'), 4) AS cnpj_mascarado,
       CASE
         WHEN NOT EXISTS (SELECT 1 FROM "ContaMotorista" c
                           WHERE c.cnpj_prestador = regexp_replace(m.cnpj_prestador, '\D', '', 'g')) THEN 'sem conta'
         WHEN NOT EXISTS (SELECT 1 FROM "ContaMotorista" c
                           WHERE c.cnpj_prestador = regexp_replace(m.cnpj_prestador, '\D', '', 'g')
                             AND c.senha = m.senha) THEN 'senha diferente'
         ELSE 'ativo diferente'
       END AS motivo
  FROM "Motorista" m
 WHERE m.senha IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "ContaMotorista" c
                    WHERE c.cnpj_prestador = regexp_replace(m.cnpj_prestador, '\D', '', 'g')
                      AND c.senha = m.senha
                      AND c.ativo IS NOT DISTINCT FROM m.ativo)
)
-- 1) lista mascarada (vazia quando PRONTO); 2) veredito, SEMPRE a ultima linha
SELECT linha FROM (
  SELECT 0 AS ordem, id::bigint AS ord2,
         'id=' || id || ' nome=' || coalesce(nome, '') || ' cnpj=' || cnpj_mascarado || ' motivo=' || motivo AS linha
    FROM perderiam
  UNION ALL
  SELECT 1, 0, CASE WHEN count(*) = 0 THEN 'PRONTO'
                    ELSE 'NAO PRONTO: ' || count(*) || ' motoristas perderiam acesso' END
    FROM perderiam
) t ORDER BY ordem, ord2;
