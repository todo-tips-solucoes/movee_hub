-- =============================================================================
-- 001-config-ui-tenant-schema.sql
-- Feature: config-ui-tenant (White-label por Tenant + Grupo de CNPJs)
-- Entregue ao operador para aplicar no banco — NÃO executar automaticamente.
--
-- Pré-requisito: tabela "Empresa" já existe no schema PostgreSQL exposto pelo
--   PostgREST (confirmado via postgrestRequest('Empresa?...') no backend).
--
-- Como aplicar:
--   psql $DATABASE_URL -f docs/sql/001-config-ui-tenant-schema.sql
--
-- Idempotente: usa IF NOT EXISTS / ADD COLUMN IF NOT EXISTS em todo lugar.
-- Pode ser re-executado sem efeito colateral.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Tabela "Grupo"
--    Representa uma holding: um CNPJ pai administrando zero ou mais CNPJs filhos.
--    A empresa pai é identificada por id_empresa_pai (FK UNIQUE → máx 1 grupo por empresa).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "Grupo" (
  id              bigserial     PRIMARY KEY,
  nome            text          NOT NULL,
  -- FK UNIQUE garante: uma empresa só pode ser pai de no máximo 1 grupo.
  -- Também é o mecanismo que permite derivar is_grupo_pai no backend:
  --   SELECT EXISTS(SELECT 1 FROM "Grupo" WHERE id_empresa_pai = $empresaId)
  id_empresa_pai  bigint        NOT NULL UNIQUE REFERENCES "Empresa"(id),
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2. Alteração aditiva em "Empresa"
--    Adiciona FK id_grupo NULLABLE (NULL = empresa sem grupo → escopo individual,
--    fallback Movee). Nenhuma coluna existente é alterada.
-- ---------------------------------------------------------------------------
ALTER TABLE "Empresa"
  ADD COLUMN IF NOT EXISTS id_grupo bigint REFERENCES "Grupo"(id);

-- Índice para queries de filhos por grupo (GET /grupo/filhos usa este índice)
CREATE INDEX IF NOT EXISTS idx_empresa_id_grupo ON "Empresa"(id_grupo);

-- ---------------------------------------------------------------------------
-- 3. Tabela "Branding"
--    Configuração de identidade visual, 1:1 com Grupo.
--    UNIQUE em id_grupo impõe cardinalidade 1:1.
--
--    Campos de cores validados no handler Express antes de persistir:
--      cor_primaria / cor_destaque: regex ^#[0-9a-fA-F]{6}$
--    nome_exibicao: VARCHAR semântico — limite de 60 chars (dec-022, CHK033)
--      aplicado no backend (400 se > 60) e documentado aqui como constraint lógica.
--      (PostgreSQL text não impõe limite; o handler aplica a regra.)
--
--    logo_url: URL pública do Supabase Storage; NULL = sem logo (usa wordmark/nome).
--    remove_logo (dec-020, CHK025): não é coluna — é flag no PUT body; o handler
--      seta logo_url = NULL quando remove_logo: true.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "Branding" (
  id              bigserial   PRIMARY KEY,
  id_grupo        bigint      NOT NULL UNIQUE REFERENCES "Grupo"(id),
  logo_url        text,                                  -- NULL = sem logo
  cor_primaria    text,                                  -- hex #RRGGBB, validado no handler
  cor_destaque    text,                                  -- hex #RRGGBB, validado no handler
  -- nome_exibicao: limite lógico de 60 chars (dec-022, CHK033) — aplicado no handler
  nome_exibicao   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 4. FR-INFRA-LOCK (dec-026, dec-033): mecanismo de lock para POST /grupo/filhos
--    Race condition prevenida pela verificação server-side no handler Express:
--      1. SELECT id_grupo FROM "Empresa" WHERE id = $empresaIdFilho
--      2. Se id_grupo IS NOT NULL → retorna 409 "Empresa já pertence a outro grupo"
--      3. UPDATE "Empresa" SET id_grupo = $id_grupo WHERE id = $empresaIdFilho
--    Em ambiente multi-pod, a janela de race é mínima (leitura+escrita na mesma
--    transação). Para hardening futuro: usar SELECT ... FOR UPDATE dentro da transação.
--
--    Status code para path param não-numérico (dec-016, CHK003):
--    empresaIdFilho não-numérico → 400 Bad Request
--      { "error": "Parâmetro inválido: empresaIdFilho deve ser um número inteiro." }
--    (documentado também em docs/specs/config-ui-tenant/contracts/grupo-api.md)
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 5. NOTIFY pgrst — recarregar schema do PostgREST após aplicar o DDL
--    Alternativa se NOTIFY não funcionar: docker kill -s SIGUSR1 <container_postgrest>
--    Confirmar nome do container: docker ps | grep -i pgrst
-- ---------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';

COMMIT;

-- =============================================================================
-- Script de levantamento para FASE-1b (BLOQUEADA — não executar ainda)
-- Operador: execute este SELECT e compartilhe o resultado para desbloquear a
-- migração D&G (task 1b.1):
--
-- SELECT id, cnpj, nome_empresa
-- FROM "Empresa"
-- WHERE nome_empresa ILIKE '%D&G%'
--    OR nome_empresa ILIKE '%D e G%'
--    OR cnpj IN (/* CNPJs conhecidos da D&G */)
-- ORDER BY id;
--
-- Salvar resultado em docs/sql/dg-levantamento-resultado.txt e compartilhar.
-- Após confirmação, o arquivo 002-config-ui-tenant-dg-vinculo.sql será gerado.
-- =============================================================================
