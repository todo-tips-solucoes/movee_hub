-- diagnostico-motorista-sync.sql — SOMENTE LEITURA.
--
-- Mede a divergencia entre "Motorista" (legado, login do app) e "ContaMotorista" (hub), ANTES e DEPOIS das
-- migrations 0121/0122/0123 (frente motorista-cadastro-hub). Nao escreve nada, nao imprime hash de senha nem CNPJ
-- completo (CNPJ sai mascarado: 2 primeiros + 4 ultimos digitos).
--
-- Uso (em psql com ON_ERROR_STOP; rodar com papel que leia as tabelas):
--   psql -d <banco> -v ON_ERROR_STOP=1 -f infra/hub/scripts/diagnostico-motorista-sync.sql
-- Para garantir leitura pura: PGOPTIONS='-c default_transaction_read_only=on' psql ...
--
-- Parte 1 = contagens D0..D9. Parte 2 = LISTAS DO GATE (C3b, C3d, C2, C4): casos AMBIGUOS que a 0121 NAO corrige e
-- que o operador decide um a um. "Grupo Movee" = empresa 6 + filiais (Grupo.id_empresa_pai = 6), a mesma regra de
-- mesmoGrupoQue (routes/grupo.js).

\echo '=== D0. dono / RLS das tabelas'
SELECT relname, pg_get_userbyid(relowner) AS dono, relrowsecurity AS rls, relforcerowsecurity AS rls_forcada
  FROM pg_class
 WHERE relname IN ('Motorista', 'ContaMotorista', 'Entregador', 'EnvioMassa', 'Empresa', 'Grupo')
   AND relkind = 'r'
 ORDER BY relname;

\echo '=== D1. panorama'
SELECT 'Motorista' AS tabela, count(*) AS total, count(*) FILTER (WHERE senha IS NOT NULL) AS com_senha,
       count(*) FILTER (WHERE NOT ativo) AS inativos,
       count(*) FILTER (WHERE cnpj_prestador !~ '^[0-9]{14}$') AS cnpj_fora_padrao
  FROM "Motorista"
UNION ALL
SELECT 'ContaMotorista', count(*), count(*) FILTER (WHERE senha IS NOT NULL),
       count(*) FILTER (WHERE NOT ativo), count(*) FILTER (WHERE cnpj_prestador !~ '^[0-9]{14}$')
  FROM "ContaMotorista";

\echo '=== D2. conta COM senha SEM linha legada (nao entra no app), por vinculo/movimento Movee'
WITH movee AS (
    SELECT 6::bigint AS id
    UNION SELECT e.id FROM "Empresa" e JOIN "Grupo" g ON g.id = e.id_grupo WHERE g.id_empresa_pai = 6),
mot AS (SELECT regexp_replace(cnpj_prestador, '\D', '', 'g') AS d FROM "Motorista"),
c AS (
    SELECT cm.id,
           coalesce(bool_or(e.id_empresa IN (SELECT id FROM movee)), false) AS vinculo_movee,
           EXISTS (SELECT 1 FROM "EnvioMassa" em
                    WHERE em.cnpj_prestador IN (cm.cnpj_prestador,
                          substr(cm.cnpj_prestador,1,2)||'.'||substr(cm.cnpj_prestador,3,3)||'.'||substr(cm.cnpj_prestador,6,3)
                          ||'/'||substr(cm.cnpj_prestador,9,4)||'-'||substr(cm.cnpj_prestador,13,2))
                      AND em.id_empresa IN (SELECT id FROM movee)) AS tem_movimento_movee
      FROM "ContaMotorista" cm LEFT JOIN "Entregador" e ON e.motorista_id = cm.id
     WHERE cm.senha IS NOT NULL AND cm.cnpj_prestador NOT IN (SELECT d FROM mot)
     GROUP BY cm.id, cm.cnpj_prestador)
SELECT vinculo_movee, tem_movimento_movee, count(*) AS contas FROM c GROUP BY 1, 2 ORDER BY 1, 2;

\echo '=== D3. senha/ativo divergentes (mesmo CNPJ normalizado)'
WITH mot AS (SELECT m.*, regexp_replace(m.cnpj_prestador, '\D', '', 'g') AS d FROM "Motorista" m)
SELECT count(*) AS pares,
       count(*) FILTER (WHERE cm.senha IS NULL AND m.senha IS NOT NULL AND cm.token_reset_hash IS NULL) AS so_legado,
       count(*) FILTER (WHERE cm.senha IS NULL AND m.senha IS NOT NULL AND cm.token_reset_hash IS NOT NULL) AS so_legado_reset_em_curso,
       count(*) FILTER (WHERE cm.senha IS NOT NULL AND m.senha IS NULL) AS so_hub,
       count(*) FILTER (WHERE cm.senha IS NOT NULL AND m.senha IS NOT NULL AND cm.senha <> m.senha) AS ambos_diferentes,
       count(*) FILTER (WHERE cm.ativo AND NOT m.ativo) AS ativo_hub_inativo_legado,
       count(*) FILTER (WHERE NOT cm.ativo AND m.ativo) AS inativo_hub_ativo_legado
  FROM "ContaMotorista" cm JOIN mot m ON m.d = cm.cnpj_prestador;

\echo '=== D4. CNPJ fora do padrao (14 digitos) e colisao ao normalizar'
SELECT 'Motorista' AS tabela, length(regexp_replace(cnpj_prestador, '\D', '', 'g')) AS digitos,
       (cnpj_prestador ~ '[^0-9]') AS pontuado, count(*)
  FROM "Motorista" WHERE cnpj_prestador !~ '^[0-9]{14}$' GROUP BY 1, 2, 3
UNION ALL
SELECT 'ContaMotorista', length(regexp_replace(cnpj_prestador, '\D', '', 'g')), (cnpj_prestador ~ '[^0-9]'), count(*)
  FROM "ContaMotorista" WHERE cnpj_prestador !~ '^[0-9]{14}$' GROUP BY 1, 2, 3;

\echo '=== D4b. grupos de CNPJ que colidem ao normalizar'
SELECT 'Motorista' AS tabela, count(*) AS grupos_colidentes FROM (
    SELECT 1 FROM "Motorista" GROUP BY regexp_replace(cnpj_prestador, '\D', '', 'g') HAVING count(*) > 1) x
UNION ALL
SELECT 'ContaMotorista', count(*) FROM (
    SELECT 1 FROM "ContaMotorista" GROUP BY regexp_replace(cnpj_prestador, '\D', '', 'g') HAVING count(*) > 1) y;

\echo '=== D5. CNPJ da conta vinculada x CNPJ do ultimo movimento do Entregador (assinatura de troca de CNPJ so no legado)'
WITH ult AS (
    SELECT DISTINCT ON (coalesce(em.entregador_uuid, em.uuid)) coalesce(em.entregador_uuid, em.uuid) AS entregador_uuid,
           regexp_replace(em.cnpj_prestador, '\D', '', 'g') AS d
      FROM "EnvioMassa" em
     WHERE coalesce(em.entregador_uuid, em.uuid) IS NOT NULL AND em.cnpj_prestador IS NOT NULL
     ORDER BY coalesce(em.entregador_uuid, em.uuid), em.created_at DESC)
SELECT count(*) AS total_pareado,
       count(*) FILTER (WHERE u.d <> cm.cnpj_prestador) AS cnpj_divergente,
       count(*) FILTER (WHERE u.d <> cm.cnpj_prestador
                          AND EXISTS (SELECT 1 FROM "Motorista" m WHERE m.cnpj_prestador = u.d)
                          AND NOT EXISTS (SELECT 1 FROM "Motorista" m WHERE m.cnpj_prestador = cm.cnpj_prestador)) AS legado_migrou_conta_nao
  FROM "Entregador" e JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
  JOIN ult u ON u.entregador_uuid = e.id_externo;

\echo '=== D6. Motorista sem ContaMotorista'
WITH mot AS (SELECT m.*, regexp_replace(m.cnpj_prestador, '\D', '', 'g') AS d FROM "Motorista" m)
SELECT (m.senha IS NOT NULL) AS com_senha, m.ativo, count(*)
  FROM mot m WHERE NOT EXISTS (SELECT 1 FROM "ContaMotorista" cm WHERE cm.cnpj_prestador = m.d)
 GROUP BY 1, 2 ORDER BY 1, 2;

\echo '=== D7. EnvioMassa com CNPJ pontuado'
SELECT count(*) FILTER (WHERE cnpj_prestador ~ '[^0-9]') AS pontuadas,
       count(*) FILTER (WHERE cnpj_prestador ~ '[^0-9]' AND NOT mov_fechado) AS pontuadas_abertas,
       count(*) AS total
  FROM "EnvioMassa";

\echo '=== D8. Motorista fora do grupo Movee (poluicao historica das seeds)'
WITH movee AS (
    SELECT 6::bigint AS id
    UNION SELECT e.id FROM "Empresa" e JOIN "Grupo" g ON g.id = e.id_grupo WHERE g.id_empresa_pai = 6)
SELECT (m.senha IS NOT NULL) AS com_senha, count(*)
  FROM "Motorista" m
 WHERE NOT EXISTS (SELECT 1 FROM "EnvioMassa" em
                    WHERE em.cnpj_prestador IN (m.cnpj_prestador, regexp_replace(m.cnpj_prestador, '\D', '', 'g'))
                      AND em.id_empresa IN (SELECT id FROM movee))
 GROUP BY 1 ORDER BY 1;

\echo '=== D9. as duas fontes de "grupo Movee" concordam? (Grupo/Empresa x EmpresaGrupoMovee)'
WITH movee AS (
    SELECT 6::bigint AS id
    UNION SELECT e.id FROM "Empresa" e JOIN "Grupo" g ON g.id = e.id_grupo WHERE g.id_empresa_pai = 6)
SELECT 'so_Grupo' AS lado, id FROM movee WHERE id NOT IN (SELECT id_empresa FROM "EmpresaGrupoMovee")
UNION ALL
SELECT 'so_allowlist', id_empresa FROM "EmpresaGrupoMovee" WHERE id_empresa NOT IN (SELECT id FROM movee);

-- =====================================================================================================
-- PARTE 2 — LISTAS DO GATE. A 0121 NAO corrige nada disto; o operador decide caso a caso.
-- =====================================================================================================

\echo '=== LISTA C3b. senha DIFERENTE nos dois lados (nao corrigida; nunca imprime hash)'
\echo '    colunas: conta_id, nome, cnpj mascarado, ativo hub/legado, atualizado_em da conta, created_at do legado'
WITH mot AS (SELECT m.*, regexp_replace(m.cnpj_prestador, '\D', '', 'g') AS d FROM "Motorista" m)
SELECT cm.id AS conta_id, cm.nome,
       left(cm.cnpj_prestador, 2) || '**********' || right(cm.cnpj_prestador, 2) AS cnpj,
       cm.ativo AS ativo_hub, m.ativo AS ativo_legado,
       cm.atualizado_em AS conta_atualizada_em, m.created_at AS legado_criado_em
  FROM "ContaMotorista" cm JOIN mot m ON m.d = cm.cnpj_prestador
 WHERE cm.senha IS NOT NULL AND m.senha IS NOT NULL AND cm.senha <> m.senha
 ORDER BY cm.id;

\echo '=== LISTA C3d. ativo DIVERGENTE (nao corrigida)'
WITH mot AS (SELECT m.*, regexp_replace(m.cnpj_prestador, '\D', '', 'g') AS d FROM "Motorista" m)
SELECT cm.id AS conta_id, cm.nome,
       left(cm.cnpj_prestador, 2) || '**********' || right(cm.cnpj_prestador, 2) AS cnpj,
       cm.ativo AS ativo_hub, m.ativo AS ativo_legado,
       (cm.senha IS NOT NULL) AS hub_tem_senha, (m.senha IS NOT NULL) AS legado_tem_senha
  FROM "ContaMotorista" cm JOIN mot m ON m.d = cm.cnpj_prestador
 WHERE cm.ativo IS DISTINCT FROM m.ativo
 ORDER BY cm.id;

\echo '=== LISTA C2. Entregador vinculado a CNPJ diferente do ultimo movimento (re-vinculo manual)'
\echo '    alvo_conta_id nulo = nao existe conta no CNPJ do movimento; alvo_com_entregador = a conta-alvo ja tem outro Entregador'
WITH ult AS (
    SELECT DISTINCT ON (coalesce(em.entregador_uuid, em.uuid)) coalesce(em.entregador_uuid, em.uuid) AS entregador_uuid,
           regexp_replace(em.cnpj_prestador, '\D', '', 'g') AS d, em.created_at
      FROM "EnvioMassa" em
     WHERE coalesce(em.entregador_uuid, em.uuid) IS NOT NULL AND em.cnpj_prestador IS NOT NULL
     ORDER BY coalesce(em.entregador_uuid, em.uuid), em.created_at DESC)
SELECT e.id AS entregador_id, e.id_empresa, e.nome AS entregador,
       cm.id AS conta_id, left(cm.cnpj_prestador, 2) || '**********' || right(cm.cnpj_prestador, 2) AS cnpj_conta,
       left(u.d, 2) || '**********' || right(u.d, 2) AS cnpj_ultimo_movimento, u.created_at::date AS ultimo_movimento,
       alvo.id AS alvo_conta_id,
       (alvo.id IS NOT NULL AND EXISTS (SELECT 1 FROM "Entregador" e2 WHERE e2.motorista_id = alvo.id)) AS alvo_com_entregador,
       (alvo.senha IS NOT NULL) AS alvo_tem_senha,
       EXISTS (SELECT 1 FROM "Motorista" m WHERE m.cnpj_prestador = u.d) AS alvo_tem_legado
  FROM "Entregador" e
  JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
  JOIN ult u ON u.entregador_uuid = e.id_externo
  LEFT JOIN "ContaMotorista" alvo ON alvo.cnpj_prestador = u.d
 WHERE u.d <> cm.cnpj_prestador
 ORDER BY e.id;

\echo '=== LISTA C4. contas com reset de senha EM CURSO ou EXPIRADO (token_reset_hash preenchido; nunca imprime hash)'
\echo '    O reset zera Motorista.senha (G2, 0123) e o /register recusa o CNPJ enquanto o token existir.'
\echo '    colunas: conta_id, nome, cnpj mascarado, expira em, expirado, legado ainda tem senha, vinculada a Entregador'
WITH mot AS (SELECT regexp_replace(m.cnpj_prestador, '\D', '', 'g') AS d, bool_or(m.senha IS NOT NULL) AS tem_senha
               FROM "Motorista" m GROUP BY 1)
SELECT cm.id AS conta_id, cm.nome,
       left(cm.cnpj_prestador, 2) || '**********' || right(cm.cnpj_prestador, 2) AS cnpj,
       cm.token_reset_expira AS expira_em,
       (cm.token_reset_expira IS NULL OR cm.token_reset_expira < now()) AS expirado,
       coalesce(mot.tem_senha, false) AS legado_tem_senha,
       EXISTS (SELECT 1 FROM "Entregador" e WHERE e.motorista_id = cm.id) AS vinculada_a_entregador
  FROM "ContaMotorista" cm LEFT JOIN mot ON mot.d = cm.cnpj_prestador
 WHERE cm.token_reset_hash IS NOT NULL
 ORDER BY cm.token_reset_expira NULLS FIRST, cm.id;
