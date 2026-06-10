-- =============================================================================
-- corte-modulo-c-levantamento-prod.sql  (READ-ONLY — não altera nada)
-- Objetivo: levantar, no banco de PRODUÇÃO, quais grupos existem e quais filiais
-- (id_grupo setado, NÃO empresa-pai) têm senha cadastrada — essas são exatamente
-- as que o corte do Módulo C vai afetar quando o grupo for ativado.
--
-- O classifier bloqueia meu acesso ao banco — rode você e me devolva a saída
-- (pode colar aqui). NÃO ative nenhum grupo (007 seção 4) antes de revisarmos isto
-- juntos e confirmarmos que cada filial afetada tem a senha do login do pai.
-- =============================================================================

-- (0) Sanidade: a coluna de senha em "Empresa" é mesmo "pass"? (o backend usa user.pass)
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'Empresa' AND column_name IN ('pass', 'id_grupo', 'email', 'nome_empresa')
ORDER BY column_name;

-- (1) Todos os grupos existentes (e seu pai). Confere quais existem além de D&G/Movee.
--     Inclui login_unico_ativo SE o DDL 007 já tiver sido aplicado (senão remova a coluna).
SELECT g.id              AS grupo_id,
       g.nome            AS grupo_nome,
       g.id_empresa_pai  AS empresa_pai_id,
       p.nome_empresa    AS empresa_pai_nome,
       p.email           AS empresa_pai_email
       -- , g.login_unico_ativo   -- descomente após aplicar o DDL 007
FROM "Grupo" g
LEFT JOIN "Empresa" p ON p.id = g.id_empresa_pai
ORDER BY g.id;

-- (2) FILIAIS AFETADAS pelo corte: empresa com id_grupo setado, que NÃO é pai de
--     nenhum grupo, e que TEM senha gravada (consegue logar sozinha hoje).
--     Ao ativar o grupo dela, esta filial passa a receber 403 no login próprio.
SELECT e.id                                   AS filial_id,
       e.nome_empresa                         AS filial_nome,
       e.email                                AS filial_email,
       e.id_grupo                             AS grupo_id,
       (e.pass IS NOT NULL AND e.pass <> '')  AS tem_senha
FROM "Empresa" e
WHERE e.id_grupo IS NOT NULL
  AND e.id NOT IN (SELECT id_empresa_pai FROM "Grupo" WHERE id_empresa_pai IS NOT NULL)
  AND e.pass IS NOT NULL AND e.pass <> ''
ORDER BY e.id_grupo, e.id;

-- (3) Contagem de filiais-com-senha por grupo — visão de impacto do corte.
SELECT e.id_grupo AS grupo_id,
       count(*)   AS filiais_com_senha
FROM "Empresa" e
WHERE e.id_grupo IS NOT NULL
  AND e.id NOT IN (SELECT id_empresa_pai FROM "Grupo" WHERE id_empresa_pai IS NOT NULL)
  AND e.pass IS NOT NULL AND e.pass <> ''
GROUP BY e.id_grupo
ORDER BY e.id_grupo;
