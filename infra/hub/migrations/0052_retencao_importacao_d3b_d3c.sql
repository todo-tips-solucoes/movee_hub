-- 0052 — retenção do arquivo importado (D3b) e recuperabilidade da linha
-- rejeitada (D3c).
--
-- Plano: docs/plans/performance-linha-por-turno.md §4.1.
--
-- ── Por que as duas juntas ───────────────────────────────────────────────────
--
-- A D3b (expurgar o arquivo original depois de 12 meses) NÃO PODE ser ligada
-- antes da D3c. Medido em produção: a importação de faturamento rejeitou 179
-- linhas, e delas o banco guarda apenas `valor_mascarado = '**'` — nem dá para
-- saber de quem era. O conteúdo real existe SÓ dentro do ZIP. Expurgar o ZIP
-- sem antes trazer essas linhas para o banco destruiria 179 lançamentos de
-- faturamento para sempre, justamente os que alguém precisaria reprocessar
-- depois de corrigir o UUID inválido que os recusou.
--
-- Decisão do operador (2026-08-18): reter o arquivo por 12 meses, alinhado à
-- Auditoria (D5 do hub-frota, migration 0041), e extrair as linhas rejeitadas
-- para o banco antes de qualquer expurgo.
--
-- ── A parte delicada: isto reverte parcialmente uma decisão de LGPD ──────────
--
-- `research.md` Decision 8 e o requisito 4.5.4 diziam "NUNCA grava a linha
-- bruta" / "nunca retorna o valor original em NENHUM branch". Estas são duas
-- coisas diferentes, e só a PRIMEIRA muda aqui:
--
--   GRAVAR  a linha bruta  -> passa a acontecer (é o que a torna recuperável);
--   RETORNAR a linha bruta -> continua NÃO acontecendo pela API.
--
-- Sem essa distinção a mudança seria um alargamento silencioso de exposição de
-- dado pessoal. Verificado em 2026-08-18 que o risco é concreto: o PostgREST
-- de produção é alcançável em `postgrest.todo-tips.com` (a tabela responde 401
-- com token ausente e uma tabela inexistente responde 404 — a sonda
-- discrimina), e `authenticated` tinha SELECT em NÍVEL DE TABELA
-- (`authenticated=ard/chatmasterveloz`). Ou seja: sem o bloco de privilégios
-- abaixo, qualquer usuário logado do tenant poderia pedir `select=linha_bruta`
-- direto na API e ler o que a tela mascara.
--
-- A recuperação das linhas passa a ser feita como DONO do banco (psql), que é
-- o que "recuperável do banco" significa aqui — e o mesmo grau de acesso que
-- baixar o arquivo original já exigia.
--
-- Idempotente (ADD COLUMN IF NOT EXISTS / REVOKE+GRANT são reexecutáveis).

-- ─────────────────────────────────────────────────────────────────────────
-- 1. D3c — a linha rejeitada passa a ser recuperável
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "ImportacaoLinhaErro"
    ADD COLUMN IF NOT EXISTS linha_bruta text;

COMMENT ON COLUMN "ImportacaoLinhaErro".linha_bruta IS
    'Conteúdo CRU da linha recusada, como veio no arquivo. Existe para que o '
    'expurgo do arquivo original (12 meses, D3b) não destrua a única cópia de '
    'uma linha que ninguém conseguiria reconstruir a partir de '
    '`valor_mascarado`. NÃO é exposta pela API: os privilégios abaixo tiram '
    'esta coluna do alcance de `authenticated`, e a leitura é feita como dono '
    'do banco. Contém PII (CNPJ/UUID/nome).';

-- Deny-by-default no lugar do SELECT de tabela inteira. Efeito colateral
-- bem-vindo: daqui em diante QUALQUER coluna nova desta tabela nasce
-- inacessível pela API até ser explicitamente liberada — o oposto do que
-- acabou de quase acontecer.
--
-- A lista abaixo é exatamente o que o app já lia (`select=numero_linha,campo,
-- motivo,valor_mascarado` em routes/hub-importacoes.js) mais as colunas que os
-- filtros usam (`importacao_id`, `id_empresa`). INSERT e DELETE continuam em
-- nível de tabela — o processador precisa gravar `linha_bruta`, e o
-- reprocessamento precisa apagar a tentativa anterior (0017).
REVOKE SELECT ON "ImportacaoLinhaErro" FROM authenticated;
GRANT SELECT (id, importacao_id, id_empresa, numero_linha, motivo, campo,
              valor_mascarado, criado_em)
    ON "ImportacaoLinhaErro" TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. D3b — marca de expurgo do arquivo original
--
-- Sem esta coluna, um arquivo expurgado e um arquivo PERDIDO ficam
-- indistinguíveis: os dois viram um 410 genérico, e quem perguntar em 2028 por
-- que o arquivo sumiu não terá como saber se foi política ou incidente. Com
-- ela, `GET /importacoes/:id/original` responde qual dos dois foi.
--
-- Quem escreve é o expurgo, rodando como dono no host
-- (infra/producao/backup-producao.sh). `authenticated` mantém o UPDATE de
-- tabela que já tinha — restringi-lo exigiria enumerar todas as colunas que o
-- processador atualiza, com risco desproporcional ao ganho: o pior caso é um
-- usuário do tenant marcar como expurgado um arquivo que continua no disco,
-- o que atrapalha a leitura da tela mas não apaga nada.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "ImportacaoArquivo"
    ADD COLUMN IF NOT EXISTS arquivo_expurgado_em timestamptz;

COMMENT ON COLUMN "ImportacaoArquivo".arquivo_expurgado_em IS
    'Quando o arquivo original foi apagado do volume pela política de retenção '
    '(12 meses, D3b). NULL = nunca expurgado. Distingue "apagado por política" '
    'de "sumiu" — sem isso os dois casos viram o mesmo 410.';

-- Índice parcial: o expurgo pergunta sempre "quais ainda NÃO foram expurgados
-- e já passaram do prazo". A condição derruba a varredura para as linhas que
-- interessam, e o índice fica minúsculo porque só indexa as não-expurgadas.
CREATE INDEX IF NOT EXISTS idx_importacao_pendente_expurgo
    ON "ImportacaoArquivo" (criado_em)
    WHERE arquivo_expurgado_em IS NULL;
