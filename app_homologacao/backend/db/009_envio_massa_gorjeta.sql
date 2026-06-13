-- 009_envio_massa_gorjeta.sql
-- Migração aditiva: adiciona coluna `gorjeta` à tabela EnvioMassa.
-- Idempotente: usa ADD COLUMN IF NOT EXISTS — pode ser reaplicado sem erro.
-- Ref: spec gorjeta-motorista FR-001..FR-003 / tasks 1.1 / plan §3.1
--
-- ATENÇÃO: executar APENAS pelo operador (Rito 6.1). Não aplicar pelo agente.
-- Após aplicar, recarregar o schema do PostgREST (NOTIFY pgrst, 'reload schema').

-- Passo 1: adicionar coluna espelhando `valor` (CL-001).
-- Tipo confirmado no rito 6.1: "EnvioMassa".valor é DOUBLE PRECISION (float8),
-- então gorjeta usa o MESMO tipo — garante serialização idêntica no PostgREST
-- (double precision -> number JSON, igual a `valor`; numeric viraria string).
ALTER TABLE "EnvioMassa"
  ADD COLUMN IF NOT EXISTS gorjeta DOUBLE PRECISION DEFAULT NULL;

-- Passo 2: comentário descritivo na coluna
COMMENT ON COLUMN "EnvioMassa".gorjeta
  IS 'Valor de gorjeta em BRL. NULL quando ausente ou não informado. Opcional — não bloqueia upload (FR-003).';

-- Passo 3: notificar PostgREST para recarregar o schema
-- (necessário para que a coluna fique visível na API REST imediatamente)
NOTIFY pgrst, 'reload schema';
