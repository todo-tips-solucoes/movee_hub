-- =============================================================================
-- 007-corte-modulo-c-login-unico-flag.sql
-- Feature: grupo-unificado-filiais — CORTE CONTROLADO do Módulo C (login único)
-- Entregue ao operador para aplicar no banco — NAO executar automaticamente.
--
-- CONTEXTO: a guarda de filial no POST /login (server.js) e no POST /token/refresh
-- bloqueava QUALQUER filial (403 "Acesse o painel usando o login do grupo") de forma
-- GLOBAL e incondicional. O corte controlado torna o bloqueio POR GRUPO: a guarda só
-- bloqueia se o grupo da filial tiver login_unico_ativo = true.
--
-- ESTRATÉGIA (decidida na clarify com o operador):
--   - Flag por grupo, default FALSE → aplicar este DDL NÃO bloqueia ninguém.
--   - Toggle A QUENTE, sem cache → UPDATE reflete no próximo login, sem redeploy.
--   - Ativação inicial pretendida: Movee + D&G (ver seção 4, COMENTADA — só rodar
--     com autorização explícita e APÓS o levantamento de produção + senha do pai).
--
-- ORDEM DE DEPLOY: aplicar ESTE DDL ANTES (ou junto) de subir o backend que lê a
-- coluna. Backend com a coluna ausente faz fail-open (não bloqueia) — seguro, mas a
-- coluna precisa existir para que a ativação (UPDATE) tenha efeito.
--
-- Como aplicar:
--   psql $DATABASE_URL -f docs/sql/007-corte-modulo-c-login-unico-flag.sql
--
-- Idempotente: ADD COLUMN IF NOT EXISTS. Reaplicar é seguro (não reseta valores já
-- setados — IF NOT EXISTS não toca a coluna existente).
-- =============================================================================

BEGIN;

-- 1. Flag de ativação do login único, por grupo.
--    NOT NULL DEFAULT false → todo grupo existente nasce INATIVO (ninguém bloqueado).
--    O operador ativa grupo a grupo via UPDATE (seção 4), reversível a quente.
ALTER TABLE "Grupo"
  ADD COLUMN IF NOT EXISTS login_unico_ativo boolean NOT NULL DEFAULT false;

-- 2. GRANT defensivo (no-op): o 003-config-ui-tenant-grants.sql já concede
--    SELECT/INSERT/UPDATE/DELETE em "Grupo" ao role authenticated, e grants em nível
--    de tabela cobrem a coluna nova — este passo é redundante. Concedemos APENAS
--    SELECT aqui porque a feature do corte só LÊ a flag (grupoLoginUnicoAtivo). A
--    ATIVAÇÃO (UPDATE) é feita por psql/owner na seção 4, NÃO pelo role authenticated
--    — não ampliamos privilégio de escrita por causa do corte (menor privilégio).
GRANT SELECT ON "Grupo" TO authenticated;

COMMIT;

-- 3. Recarregar o schema/privilégios no PostgREST
NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- 4. ATIVAÇÃO (NÃO faz parte do DDL — rodar SEPARADAMENTE, com autorização
--    explícita do operador, APÓS o levantamento de produção e a confirmação de
--    que os usuários das filiais têm a senha do login do grupo (pai)).
--
--    ⚠️ Ativar um grupo BLOQUEIA imediatamente o login próprio de TODAS as filiais
--    daquele grupo (no próximo login/refresh). Só ative quando a migração para o
--    login do pai estiver comunicada e a senha do pai disponível.
--
--    Os ids/nomes abaixo são de HOMOLOGAÇÃO (D&G = grupo cujo pai é a empresa id=2;
--    Movee = grupo cujo pai é a empresa id=6). Em PRODUÇÃO confirme os ids reais com
--    docs/sql/corte-modulo-c-levantamento-prod.sql ANTES de rodar o UPDATE.
--
--    -- 4a. Pré-visualizar o que será ativado (dry-run, read-only):
--    SELECT id, nome, id_empresa_pai, login_unico_ativo
--    FROM "Grupo"
--    WHERE nome ILIKE '%movee%' OR nome ILIKE '%D&G%' OR nome ILIKE '%D & G%';
--
--    -- 4b. Ativar SÓ a Movee (sem filiais reais após 006b — impacto zero):
--    UPDATE "Grupo" SET login_unico_ativo = true
--    WHERE nome ILIKE '%movee%';
--
--    -- 4c. Ativar a D&G (BLOQUEIA as 5 filiais reais — só após comunicar):
--    UPDATE "Grupo" SET login_unico_ativo = true
--    WHERE nome ILIKE '%D&G%' OR nome ILIKE '%D & G%';
--
--    -- 4d. ROLLBACK a quente (desativar qualquer grupo, sem redeploy):
--    UPDATE "Grupo" SET login_unico_ativo = false WHERE id = <id_do_grupo>;
-- =============================================================================

-- =============================================================================
-- 5. Verificação (manual, após aplicar o DDL):
--   SELECT column_name, data_type, column_default, is_nullable
--     FROM information_schema.columns
--     WHERE table_name = 'Grupo' AND column_name = 'login_unico_ativo';
--   -- esperado: boolean, default false, NOT NULL
--   SELECT id, nome, id_empresa_pai, login_unico_ativo FROM "Grupo" ORDER BY id;
-- =============================================================================
