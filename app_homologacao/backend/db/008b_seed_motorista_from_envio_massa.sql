-- 008b_seed_motorista_from_envio_massa.sql
-- Feature: cadastro-motorista-base-validada (migração inicial — decisão §6.3)
-- Objetivo: popular "Motorista" a partir do histórico já existente em
--   "EnvioMassa", para que motoristas do passado também fiquem elegíveis a
--   cadastrar sem depender de um novo upload.
--
-- Regras:
--   - Insere apenas cnpj_prestador AINDA NÃO presente em "Motorista"
--     (WHERE NOT EXISTS) → preserva as contas já existentes e suas senhas.
--   - Pré-cadastro: linha SEM senha (senha NULL — requer a 008 aplicada antes).
--   - cnpj_prestador normalizado para 14 dígitos (EnvioMassa guarda os dois
--     formatos: só-dígitos e com máscara).
--   - Escolhe um `nome` não-vazio por CNPJ (DISTINCT ON + ORDER BY).
-- Idempotente: re-rodar não duplica nem sobrescreve.
-- Pré-requisito: aplicar 008_cadastro_motorista_base.sql ANTES (senha nullable).

INSERT INTO "Motorista" (cnpj_prestador, nome, ativo)
SELECT DISTINCT ON (src.cnpj_norm)
       src.cnpj_norm,
       src.nome_val,
       true
FROM (
  SELECT regexp_replace(cnpj_prestador, '\D', '', 'g') AS cnpj_norm,
         NULLIF(btrim(nome), '')                        AS nome_val
  FROM "EnvioMassa"
  WHERE cnpj_prestador IS NOT NULL
) src
WHERE length(src.cnpj_norm) = 14
  AND NOT EXISTS (
    SELECT 1 FROM "Motorista" m WHERE m.cnpj_prestador = src.cnpj_norm
  )
ORDER BY src.cnpj_norm, src.nome_val NULLS LAST;

-- Relatório: quantos motoristas existem e quantos ainda sem senha (pré-cadastro).
DO $$
DECLARE
  total      bigint;
  sem_senha  bigint;
BEGIN
  SELECT count(*) INTO total     FROM "Motorista";
  SELECT count(*) INTO sem_senha FROM "Motorista" WHERE senha IS NULL;
  RAISE NOTICE 'Motorista: % linha(s) no total, % em pré-cadastro (senha NULL).', total, sem_senha;
END
$$;
