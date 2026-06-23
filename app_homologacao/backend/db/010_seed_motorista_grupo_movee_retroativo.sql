-- 010_seed_motorista_grupo_movee_retroativo.sql
-- Feature: fix-upload-motorista-observabilidade
-- Objetivo: popular "Motorista" a partir do histórico de "EnvioMassa" para os
--   motoristas do GRUPO MOVEE (empresa 6 + filiais) que ficaram só no movimento
--   e não entraram na base de login do app — sintoma: "fiz o import mas o
--   motorista não foi cadastrado no app motorista".
--
-- Causa-raiz do sintoma (confirmada nos logs de produção): o upsert do /upload
--   (upsertMotoristasFromLote) checa quais CNPJs já existem via
--   `Motorista?cnpj_prestador=in.(<todos os CNPJs do lote>)`. Num upload grande
--   (centenas de CNPJs) a URL estoura o limite de header do PostgREST →
--   "Parse Error: Header overflow" → o GET lança ANTES do INSERT e o erro era
--   engolido silenciosamente (movimento preservado, motorista não cadastrado).
--   O FIX de código pagina esse `in.(...)` em lotes; este seed faz o BACKFILL do
--   que já ficou para trás, via SQL direto (não passa pela URL, então não estoura).
-- O ALTER/NOTIFY abaixo são apenas salvaguarda idempotente (pré-cadastro sem senha).
--
-- Diferença para o 008b: o 008b puxa "EnvioMassa" INTEIRA. Como hoje a base é
--   multi-tenant, isso poluiria "Motorista" com CNPJs de outras empresas. A base
--   Motorista é EXCLUSIVA do grupo Movee — por isso aqui filtramos por
--   id_empresa ∈ grupo Movee (empresa 6 + filiais via Grupo/Empresa), espelhando
--   o gate mesmoGrupoQue(_, 6) do backend.
--
-- Idempotente e aditivo: re-rodar não duplica (NOT EXISTS) nem sobrescreve senhas.
-- Pré-requisito coberto aqui mesmo: ALTER ... DROP NOT NULL (idempotente).

BEGIN;

-- pré-requisito idempotente: pré-cadastro nasce sem senha
ALTER TABLE "Motorista" ALTER COLUMN senha DROP NOT NULL;

WITH membros_movee AS (
  SELECT 6::bigint AS id_empresa
  UNION
  SELECT e.id
  FROM "Empresa" e
  JOIN "Grupo" g ON e.id_grupo = g.id
  WHERE g.id_empresa_pai = 6
),
candidatos AS (
  SELECT regexp_replace(em.cnpj_prestador, '\D', '', 'g') AS cnpj_norm,
         NULLIF(btrim(em.nome), '')                       AS nome_val
  FROM "EnvioMassa" em
  WHERE em.cnpj_prestador IS NOT NULL
    AND em.id_empresa IN (SELECT id_empresa FROM membros_movee)
)
INSERT INTO "Motorista" (cnpj_prestador, nome, ativo)
SELECT DISTINCT ON (c.cnpj_norm) c.cnpj_norm, c.nome_val, true
FROM candidatos c
WHERE length(c.cnpj_norm) = 14
  AND NOT EXISTS (SELECT 1 FROM "Motorista" m WHERE m.cnpj_prestador = c.cnpj_norm)
ORDER BY c.cnpj_norm, c.nome_val NULLS LAST;

-- Relatório
DO $$
DECLARE total bigint; sem_senha bigint;
BEGIN
  SELECT count(*) INTO total     FROM "Motorista";
  SELECT count(*) INTO sem_senha FROM "Motorista" WHERE senha IS NULL;
  RAISE NOTICE 'Motorista: % no total, % em pré-cadastro (senha NULL).', total, sem_senha;
END $$;

COMMIT;

-- PostgREST enxerga a nova nullability/linhas (chave da correção do upload).
NOTIFY pgrst, 'reload schema';
