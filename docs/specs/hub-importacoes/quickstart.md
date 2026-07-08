# Quickstart — Cenários de teste (hub-importacoes)

Ambiente: **hub-homolog ISOLADO** (VPSTodo, recursos `hub-*`). NUNCA produção.
Usar seeds anonimizados da S1; CSV real só no sandbox context-mode. Unit-first
(parser/normalizador testados sem banco), depois integração via PostgREST do hub.

---

## Cenário 1 — Happy path faturamento (US1)

1. Autenticar no hub (cookie httpOnly) com papel que tem `importacoes.criar`.
2. `POST /importacoes` com `tipo=faturamento` + CSV anonimizado válido (~4k linhas).
   → **Expected**: `201 { id, status: "pending" }`.
3. Poll `GET /importacoes/:id` até terminal.
   → **Expected**: `status="completed"`, `contadores.validas ≈ total`, `invalidas=0`;
   linhas em `FaturamentoLancamento`; `Entregador` upsertado; `valor` com vírgula→ponto
   correto; `margem_fee_min/inter` derivados onde o texto casou a regex.

## Cenário 2 — Idempotência de arquivo (US2)

1. Reenviar o MESMO arquivo do Cenário 1.
   → **Expected**: `409 { importacaoOriginalId: <id do cenário 1> }`; zero linhas novas.
2. (dedupe de linha) Enviar arquivo NOVO contendo algumas linhas idênticas às já
   importadas + linhas novas.
   → **Expected**: só as linhas novas inserem (`ON CONFLICT (id_empresa, hash_linha)
   DO NOTHING`); as repetidas contam como válidas (dedupe silencioso).

## Cenário 3 — Performance com dialeto ponto + HH:MM:SS (US1)

1. `POST /importacoes` `tipo=performance` + CSV performance (header `sub_praca`,
   decimal ponto, `HH:MM:SS`, taxas em centavos).
   → **Expected**: `completed`; `duracao`/`tempo_disponivel` como `interval`;
   `tempo_disponivel_pct` numérico direto; `taxas_centavos` int sem divisão;
   linha sem UUID → **erro de linha** (UUID obrigatório em performance).

## Cenário 4 — Erros por linha + LGPD (US3)

1. Enviar arquivo com algumas linhas inválidas (campo obrigatório ausente, valor
   fora de faixa).
   → **Expected**: `completed_with_errors`; `GET /importacoes/:id/erros` lista
   `{ numeroLinha, campo, motivo, valorMascarado }`.
2. `GET /importacoes/:id/erros?format=csv`.
   → **Expected**: CSV abre em planilha; célula iniciada por `=/+/-/@` prefixada com
   `'` (anti-injection); **nenhum** UUID/nome bruto — só `valorMascarado`.

## Cenário 5 — Falha estrutural >50% (US3-4)

1. Enviar arquivo com maioria (>50%) das linhas inválidas OU cabeçalho errado.
   → **Expected**: `status="failed"`, `erroResumo` explicativo, **zero** linhas em
   `FaturamentoLancamento`/`PerformanceTurno` (rollback total).

## Cenário 6 — Reprocessar / cancelar (US4)

1. Sobre a importação `failed` do Cenário 5: `POST /importacoes/:id/reprocessar`.
   → **Expected**: `202 status=pending`; reusa arquivo; `ImportacaoLinhaErro` limpo,
   contadores zerados; NÃO cria novo `ImportacaoArquivo`.
2. Sobre uma importação `completed`: `POST /importacoes/:id/reprocessar`.
   → **Expected**: `409` (concluída não reprocessa).
3. Iniciar importação grande e `POST /importacoes/:id/cancelar` durante `processing`.
   → **Expected**: `202 status=cancelled`, interrompido entre lotes.

## Cenário 7 — Gate de export (US4-5)

1. Autenticar com papel `leitura` (tem `importacoes.consultar`, NÃO `exportar`).
2. `GET /importacoes/:id` → **Expected**: `200` (vê detalhe).
3. `GET /importacoes/:id/original` → **Expected**: `403 PERMISSAO_NEGADA`.
4. Repetir 3 com papel `admin_entidade` (tem `importacoes.exportar` após 0016)
   → **Expected**: `200` stream do arquivo.

## Cenário 8 — Isolamento multi-tenant (Constitution II)

1. Importação criada pela empresa A. Autenticar como empresa B (fora do escopo).
   → **Expected**: `GET /importacoes/:id` da empresa A retorna `404`; `GET
   /importacoes` de B não lista a importação de A. Reforçado por RLS
   (`id_empresa = ANY(hub_jwt_escopo_ids())`) + filtro do backend.

## Cenário 9 — Concorrência com lock advisory (Decision 5)

1. Disparar duas importações do mesmo `(id_empresa, tipo)` quase simultâneas.
   → **Expected**: a 2ª fica `pending` (espera visível) e inicia automaticamente
   quando a 1ª atinge estado terminal; nenhuma é rejeitada por concorrência.

## Cenário 10 — Roundtrip End-to-End (contrato real, não mock)

1. Fazer chamada REAL ao backend hub (`POST /importacoes` + `GET /importacoes/:id`),
   capturar o payload de resposta.
   → **Expected**: shape do JSON casa exatamente o contrato em
   `contracts/importacoes-api.md` (camelCase: `linhasValidas`, `dataReferencia`,
   `importacaoOriginalId`), sem drift snake_case↔camelCase entre PostgREST e a API.

## Cenário 11 — Branding / dark-light das telas novas (SC-007, resolve CHK006)

Nenhum dos Cenários 1–10 exercitava tema/branding explicitamente nas telas
novas de importações. Este cenário fecha o gap (CHK006).

1. Autenticar no hub com papel que tem `importacoes.consultar` (usuário
   sintético `e2e-teste-branding-*`, empresa `950201`, vínculo único —
   auto-seleção de entidade). Semear 1 `ImportacaoArquivo`
   `completed_with_errors` + 2 `ImportacaoLinhaErro` (valores mascarados,
   sem PII bruto) para dar conteúdo à tela de detalhe.
2. Alternar o tema via `next-themes` (`attribute="class"`, storageKey
   `theme` em `localStorage`, injetado por `addInitScript` ANTES da
   navegação — o shell do hub não expõe toggle de UI).
3. Capturar `/hub/dashboard/importacoes` (lista) e
   `/hub/dashboard/importacoes/:id` (detalhe) em `light` e `dark`.
   → **Expected**: as 4 telas renderizam na paleta EntreGô 2.0 correta do
   tema ativo (`html` recebe a classe `light`/`dark`); nenhuma cor
   hardcoded fora do design system (varredura confirma 0 hex/`rgb()`/`hsl()`/
   `style` inline — só tokens semânticos `text-muted-foreground`,
   `bg-card`, `text-destructive`, `bg-background`, `border-input`, …).
   A tela de detalhe também evidencia o mascaramento LGPD (coluna Valor com
   `**.***.***/****-**` e `R$ ***,**`, nunca dado bruto).

**Execução**: `infra/hub` — driver Playwright na imagem oficial
`mcr.microsoft.com/playwright` (`--network host --add-host` p/ o domínio
isolado do hub, `--memory=1g`), rito anti-starvation + verificação de
produção `envio-massa-homologacao_*` 4/4 antes/depois, cleanup dos dados
sintéticos em `trap`. Evidência: `docs/plans/hub-frota/evidencias/S4/
cenario11-{lista,detalhe}-{light,dark}.png`.
