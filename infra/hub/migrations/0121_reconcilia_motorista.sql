-- 0121 — reconcilia "Motorista" (legado, login do app) com "ContaMotorista" (hub), ANTES de os gatilhos da 0123
-- passarem a manter as duas em sincronia.
--
-- POR QUE: o hub e o legado gravavam cada um na sua tabela, sem ponte. Medido na copia do backup de producao de
-- 2026-10-31: 195 contas sem senha no hub com senha no legado (+15 com reset em curso), 2 so no hub, 3 contas com
-- senha SEM linha legada (o motorista nao entra no app), 3 `Motorista` com senha SEM conta. Os gatilhos da 0123 so
-- tratam o que acontece DEPOIS deles; esta migration alinha o passado.
--
-- RECONCILIACAO POR CAMPO (decisao do operador, 2026-10-31):
--   C4  CNPJ pontuado -> so digitos, onde nao colide (o CHECK de 14 digitos da 0122 exige).
--   C3a senha: hub NULO <- legado (e a senha que funciona hoje no login). Pula conta com reset em curso
--       (`token_reset_hash` preenchido): reviver a senha antiga anularia o reset.
--   C3c senha: legado NULO <- hub (so existe um valor).
--   C1  conta COM senha sem linha legada -> INSERT em `Motorista`, so se o CNPJ for do grupo Movee
--       (empresa 6 + filiais, a regra de `mesmoGrupoQue`): o app motorista e exclusivo do grupo.
--   C5  `Motorista` COM senha sem conta -> INSERT em `ContaMotorista`. Pre-cadastro SEM senha NAO ganha conta
--       (o vinculo do hub cria quando precisar).
--
-- O QUE ESTA MIGRATION NAO FAZ, DE PROPOSITO — vai para a LISTA do gate (infra/hub/scripts/diagnostico-motorista-sync.sql),
-- o operador decide caso a caso:
--   C3b senha DIFERENTE nos dois lados.   C3d `ativo` divergente.   C2 Entregador vinculado a CNPJ diferente do
--   ultimo movimento (re-vinculo). Tambem nao apaga nada e nao normaliza "EnvioMassa".
--
-- Aditiva e idempotente: cada UPDATE so casa linha que ainda diverge e cada INSERT so cria a que falta
-- (rodar de novo nao muda nada). Corre numa transacao (migrate.sh aplica com `psql -1`). Os gatilhos da 0123 ainda
-- nao existem aqui, entao nada se propaga como efeito colateral.
-- ROLLBACK: nao ha DROP — restaurar com `pg_dump -t '"Motorista"' -t '"ContaMotorista"'` tirado antes de aplicar.

-- C4. normalizar CNPJ pontuado (so onde nao colide; colisao fica para decisao humana — ver D4b do diagnostico)
UPDATE "Motorista" m
   SET cnpj_prestador = regexp_replace(m.cnpj_prestador, '\D', '', 'g')
 WHERE m.cnpj_prestador ~ '[^0-9]'
   AND length(regexp_replace(m.cnpj_prestador, '\D', '', 'g')) = 14
   AND NOT EXISTS (SELECT 1 FROM "Motorista" x
                    WHERE x.cnpj_prestador = regexp_replace(m.cnpj_prestador, '\D', '', 'g'));

UPDATE "ContaMotorista" c
   SET cnpj_prestador = regexp_replace(c.cnpj_prestador, '\D', '', 'g'), atualizado_em = now()
 WHERE c.cnpj_prestador ~ '[^0-9]'
   AND length(regexp_replace(c.cnpj_prestador, '\D', '', 'g')) = 14
   AND NOT EXISTS (SELECT 1 FROM "ContaMotorista" x
                    WHERE x.cnpj_prestador = regexp_replace(c.cnpj_prestador, '\D', '', 'g'));

-- C3a. hub sem senha <- legado (pulando reset em curso)
UPDATE "ContaMotorista" cm
   SET senha = m.senha, atualizado_em = now()
  FROM "Motorista" m
 WHERE m.cnpj_prestador = cm.cnpj_prestador
   AND cm.senha IS NULL AND m.senha IS NOT NULL
   AND cm.token_reset_hash IS NULL;

-- C3c. legado sem senha <- hub
UPDATE "Motorista" m
   SET senha = cm.senha
  FROM "ContaMotorista" cm
 WHERE m.cnpj_prestador = cm.cnpj_prestador
   AND m.senha IS NULL AND cm.senha IS NOT NULL;

-- C1. conta com senha sem linha legada, so grupo Movee (vinculo Entregador numa empresa do grupo OU movimento nela)
WITH movee AS (
    SELECT 6::bigint AS id
    UNION SELECT e.id FROM "Empresa" e JOIN "Grupo" g ON g.id = e.id_grupo WHERE g.id_empresa_pai = 6
)
INSERT INTO "Motorista" (cnpj_prestador, senha, nome, ativo)
SELECT cm.cnpj_prestador, cm.senha, nullif(btrim(cm.nome), ''), cm.ativo
  FROM "ContaMotorista" cm
 WHERE cm.senha IS NOT NULL
   AND cm.cnpj_prestador ~ '^[0-9]{14}$'
   AND NOT EXISTS (SELECT 1 FROM "Motorista" m WHERE m.cnpj_prestador = cm.cnpj_prestador)
   AND (EXISTS (SELECT 1 FROM "Entregador" e
                 WHERE e.motorista_id = cm.id AND e.id_empresa IN (SELECT id FROM movee))
        OR EXISTS (SELECT 1 FROM "EnvioMassa" em
                    WHERE em.cnpj_prestador IN (cm.cnpj_prestador,
                              substr(cm.cnpj_prestador, 1, 2) || '.' || substr(cm.cnpj_prestador, 3, 3) || '.' ||
                              substr(cm.cnpj_prestador, 6, 3) || '/' || substr(cm.cnpj_prestador, 9, 4) || '-' ||
                              substr(cm.cnpj_prestador, 13, 2))
                      AND em.id_empresa IN (SELECT id FROM movee)))
ON CONFLICT (cnpj_prestador) DO NOTHING;

-- C5. legado COM senha sem conta -> cria a conta (telefone: ultimo numero valido do CNPJ na EnvioMassa, como a 0093)
INSERT INTO "ContaMotorista" (cnpj_prestador, nome, ativo, senha, telefone)
SELECT m.cnpj_prestador, coalesce(nullif(btrim(m.nome), ''), '(sem nome)'), m.ativo, m.senha,
       (SELECT em.number FROM "EnvioMassa" em
         WHERE em.cnpj_prestador IN (m.cnpj_prestador,
                   substr(m.cnpj_prestador, 1, 2) || '.' || substr(m.cnpj_prestador, 3, 3) || '.' ||
                   substr(m.cnpj_prestador, 6, 3) || '/' || substr(m.cnpj_prestador, 9, 4) || '-' ||
                   substr(m.cnpj_prestador, 13, 2))
           AND em.number ~ '^[0-9]{12,13}$'
         ORDER BY em.created_at DESC LIMIT 1)
  FROM "Motorista" m
 WHERE m.senha IS NOT NULL
   AND m.cnpj_prestador ~ '^[0-9]{14}$'
   AND NOT EXISTS (SELECT 1 FROM "ContaMotorista" cm WHERE cm.cnpj_prestador = m.cnpj_prestador)
ON CONFLICT (cnpj_prestador) DO NOTHING;
