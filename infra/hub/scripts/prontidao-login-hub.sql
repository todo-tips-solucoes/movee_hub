-- prontidao-login-hub.sql — SOMENTE LEITURA. Checagem da virada de HUB_MOTORISTA_LOGIN_CONTA_ATIVA=true.
--
-- Criterio unico: nenhum motorista pode perder acesso ao ligar a chave. Conta-se "Motorista" com senha NOT NULL
-- para o qual NAO existe "ContaMotorista" com o mesmo CNPJ (so digitos), a mesma senha e o mesmo ativo.
-- Classe que NAO bloqueia ("cnpj migrado"): Motorista sem conta no seu CNPJ, mas com ContaMotorista ATIVA de hash
-- de senha identico (bcrypt tem sal aleatorio: hash igual so existe por copia) em OUTRO CNPJ. O motorista entra pelo
-- CNPJ novo com a mesma senha; precisa ser AVISADO antes da virada (o CNPJ antigo deixa de entrar).
-- Nao imprime hash nem CNPJ completo (mascarado: 2 primeiros + 4 ultimos digitos).
-- Antes do veredito, "AVISAR: N motoristas devem passar a usar o CNPJ novo" (so se N > 0).
-- A ULTIMA linha da saida e o veredito (conta so quem realmente perderia acesso): "PRONTO" ou "NAO PRONTO: N motoristas perderiam acesso".
--
-- Uso:
--   PGOPTIONS='-c default_transaction_read_only=on' psql -d <banco> -v ON_ERROR_STOP=1 -At -f infra/hub/scripts/prontidao-login-hub.sql

WITH base AS (
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
       END AS motivo,
       (SELECT min(left(c.cnpj_prestador, 2) || '******' || right(c.cnpj_prestador, 4))
          FROM "ContaMotorista" c
         WHERE c.senha = m.senha AND c.ativo IS TRUE
           AND c.cnpj_prestador <> regexp_replace(m.cnpj_prestador, '\D', '', 'g')) AS cnpj_novo_mascarado
  FROM "Motorista" m
 WHERE m.senha IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "ContaMotorista" c
                    WHERE c.cnpj_prestador = regexp_replace(m.cnpj_prestador, '\D', '', 'g')
                      AND c.senha = m.senha
                      AND c.ativo IS NOT DISTINCT FROM m.ativo)
),
perderiam AS (SELECT * FROM base WHERE NOT (motivo = 'sem conta' AND cnpj_novo_mascarado IS NOT NULL)),
migrados  AS (SELECT * FROM base WHERE motivo = 'sem conta' AND cnpj_novo_mascarado IS NOT NULL)
-- 1) lista mascarada (vazia quando nada a mostrar); 2) AVISAR (se houver migrados); 3) veredito, SEMPRE a ultima linha
SELECT linha FROM (
  SELECT 0 AS ordem, id::bigint AS ord2,
         'id=' || id || ' nome=' || coalesce(nome, '') || ' cnpj=' || cnpj_mascarado || ' motivo=' || motivo AS linha
    FROM perderiam
  UNION ALL
  SELECT 0, id::bigint,
         'id=' || id || ' nome=' || coalesce(nome, '') || ' cnpj=' || cnpj_mascarado
         || ' motivo=cnpj migrado: entra pelo CNPJ ' || cnpj_novo_mascarado || ' com a mesma senha'
    FROM migrados
  UNION ALL
  SELECT 1, 0, 'AVISAR: ' || count(*) || ' motoristas devem passar a usar o CNPJ novo'
    FROM migrados HAVING count(*) > 0
  UNION ALL
  SELECT 2, 0, CASE WHEN count(*) = 0 THEN 'PRONTO'
                    ELSE 'NAO PRONTO: ' || count(*) || ' motoristas perderiam acesso' END
    FROM perderiam
) t ORDER BY ordem, ord2;
