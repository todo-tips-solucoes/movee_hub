-- 0018 — correções pós-code-review do PR #57 (hub-importacoes/S4):
--   (a) F13: índice único p/ dedupe de ImportacaoLinhaErro num retry do
--       mesmo lote (evita linhas de erro duplicadas quando um POST de lote
--       é reenviado após timeout/erro transiente — o INSERT já retentado 1x
--       por `executarComRetry` podia gravar a MESMA linha 2x se a 1ª
--       tentativa tivesse sucedido no servidor mas a resposta se perdesse).
--   (b) F1.3: policy administrativa MÍNIMA para o job de recuperação de
--       lock órfão no boot (`recuperarImportacoesOrfas`,
--       lib/hub-import-processor.js) — sem isso, um restart do backend no
--       meio de uma importação (deploy) deixa o registro preso em
--       `validating`/`processing` para sempre, e o índice único parcial
--       (migration 0011, "1 importação ativa por (id_empresa,tipo)")
--       bloqueia TODO upload futuro daquele (id_empresa,tipo) até alguém
--       destravar manualmente — este era o achado mais grave do review
--       ("o mais importante — deploy dispara").
--
-- Idempotente: CREATE UNIQUE INDEX IF NOT EXISTS / CREATE OR REPLACE
-- FUNCTION / DROP POLICY IF EXISTS + CREATE POLICY são todos reexecutáveis.
-- Expand-only (Constitution): nenhuma coluna/tabela existente é alterada.

-- ─────────────────────────────────────────────────────────────────────────
-- (a) F13 — dedupe de ImportacaoLinhaErro em retry
-- ─────────────────────────────────────────────────────────────────────────
-- `inserirLoteErros` (lib/hub-import-processor.js) passa a usar
-- `on_conflict=importacao_id,numero_linha` com `Prefer: resolution=
-- ignore-duplicates` (ON CONFLICT DO NOTHING) — precisa de um índice único
-- nessas 2 colunas para o PostgREST montar o ON CONFLICT. `numero_linha` é
-- único DENTRO de uma importação (nunca 2 linhas de erro para a mesma linha
-- do CSV de origem — normalizarLinha* produz no máximo múltiplos `erros`
-- por linha, mas cada 1 vira uma linha separada em ImportacaoLinhaErro; ver
-- nota abaixo).
--
-- NOTA IMPORTANTE: `normalizarLinhaFaturamento`/`normalizarLinhaPerformance`
-- podem produzir MAIS DE 1 erro para a MESMA `numero_linha` (ex.: `recebedor`
-- E `valor` inválidos na mesma linha do CSV — ver
-- tests/hub-import-processor.test.js "1 de 3 linhas inválida... 3 erros
-- nesta linha"). Esse comportamento pré-existe a esta migration e o índice
-- abaixo NÃO o quebra por si só (retry não é o caminho normal de inserção —
-- é o caminho de recuperação transiente): quando MÚLTIPLOS erros da MESMA
-- linha original entram no MESMO lote de INSERT, um deles sobrevive e os
-- demais colidem no índice único e são descartados por
-- `ON CONFLICT DO NOTHING` — efeito aceito nesta correção (F13 visa
-- primariamente eliminar DUPLICATAS entre 1ª tentativa e retry do MESMO
-- lote, não multiplicar o relatório de erros por linha; 1 erro reportado já
-- direciona o usuário à linha problemática do arquivo original).
CREATE UNIQUE INDEX IF NOT EXISTS importacaolinhaerro_dedupe_linha
    ON "ImportacaoLinhaErro" (importacao_id, numero_linha);

-- ─────────────────────────────────────────────────────────────────────────
-- (b) F1.3 — recuperação de lock órfão no boot (claim administrativa)
-- ─────────────────────────────────────────────────────────────────────────
-- `hub_jwt_boot_recovery()` espelha `hub_jwt_escopo_ids()` (0006): lê a
-- claim `hub_boot_recovery` do JWT (booleana). Claim ausente/inválida ->
-- false (nega-por-padrão, mesma postura de FR-028).
CREATE OR REPLACE FUNCTION hub_jwt_boot_recovery()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE((hub_jwt_claims() ->> 'hub_boot_recovery')::boolean, false);
$$;

-- Policy ADICIONAL (permissiva) em "ImportacaoArquivo", cumulativa com
-- `importacaoarquivo_update_por_escopo` (0015) — múltiplas policies
-- permissivas para o MESMO comando são combinadas com OR pelo Postgres, ou
-- seja: esta policy NUNCA restringe o acesso normal por escopo (que
-- continua exigindo `id_empresa = ANY(hub_jwt_escopo_ids())`); ela só
-- ADICIONA uma via alternativa, estreita, usada exclusivamente pelo job de
-- boot: USING exige que a linha esteja em `validating`/`processing` (as
-- únicas travadas pelo índice único parcial de 0011) E a claim
-- `hub_boot_recovery=true`; WITH CHECK exige que o NOVO valor de `status`
-- seja `failed` E a mesma claim — ou seja, esta via NUNCA permite ler outra
-- coluna, nem gravar qualquer status diferente de `failed`, nem tocar
-- linhas que não estejam travadas. A claim `hub_boot_recovery` só é emitida
-- por `lib/hub-import-processor.js#recuperarImportacoesOrfas` (nunca por
-- nenhuma rota que atende requisição de usuário) — ver
-- lib/hub-postgrest-jwt.js.
--
-- CORREÇÃO #1 (validado empiricamente no hub-homolog durante a
-- implementação desta correção): uma policy `FOR UPDATE` SOZINHA NÃO É
-- SUFICIENTE — o Postgres precisa também de uma policy de VISIBILIDADE
-- (`FOR SELECT`) para localizar as linhas candidatas a atualizar; sem ela,
-- o UPDATE roda sem erro mas afeta 0 linhas (a query de localização das
-- linhas é filtrada pela policy de SELECT, que aqui exige escopo — ausente
-- na claim de recuperação).
--
-- CORREÇÃO #2 (também validada empiricamente): a policy de SELECT precisa
-- cobrir tanto o status ANTES quanto DEPOIS da transição — o Postgres
-- exige que a linha RESULTANTE de um UPDATE também seja visível via SELECT
-- para poder devolvê-la em `RETURNING` (PostgREST sempre pede
-- `return=representation`/`return=minimal`, mas a checagem interna do
-- Postgres roda de qualquer forma); com o filtro restrito só a
-- `validating`/`processing`, a linha JÁ COMO `failed` (pós-update) ficava
-- invisível e o Postgres recusava a transição inteira com "new row
-- violates row-level security policy" mesmo o UPDATE em si sendo permitido.
-- Por isso o `status IN (...)` abaixo inclui `failed` — cobre as duas
-- pontas da ÚNICA transição que esta via permite.
DROP POLICY IF EXISTS importacaoarquivo_select_recuperacao_orfa ON "ImportacaoArquivo";
CREATE POLICY importacaoarquivo_select_recuperacao_orfa ON "ImportacaoArquivo"
    FOR SELECT
    USING (hub_jwt_boot_recovery() AND status IN ('validating', 'processing', 'failed'));

DROP POLICY IF EXISTS importacaoarquivo_update_recuperacao_orfa ON "ImportacaoArquivo";
CREATE POLICY importacaoarquivo_update_recuperacao_orfa ON "ImportacaoArquivo"
    FOR UPDATE
    USING (hub_jwt_boot_recovery() AND status IN ('validating', 'processing'))
    WITH CHECK (hub_jwt_boot_recovery() AND status = 'failed');
