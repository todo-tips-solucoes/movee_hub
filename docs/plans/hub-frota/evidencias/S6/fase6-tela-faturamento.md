# FASE 6 — Tela `/hub/dashboard/faturamento` (evidências)

Execução: onda-007 do `/feature-00c` (short_name `hub-faturamento`), 2026-07-08.
Ambiente: hub-homolog ISOLADO e PERSISTENTE (`https://hub-homolog.todo-tips.com:8443`),
recursos `hub-*`/`hub_*` (exceção G1). Produção `envio-massa-homologacao_*` conferida
(smoke `/login` = 200) ANTES e DEPOIS de todo o trabalho — nenhuma mudança.

## 0. Deploy (pré-requisito)

Achado: `hub_homolog_backend` rodava imagem **sem** as rotas do S6 (FASES 1-5
nunca haviam sido deployadas no ambiente persistente — só testadas em
`hub-test-*` efêmero/testes de integração). Migrations 0026/0027 já estavam
aplicadas no banco (confirmado nas evidências da onda-006).

- `DOCKER_BUILDKIT=0 docker compose -p hub-homolog -f compose.hub.homolog.yml
  --env-file /var/lib/hub_secrets/.env.hub.homolog build --memory=2g backend`
  + `up -d --wait backend` → `routes/hub-faturamento.js` confirmado dentro do
  container, rota montada em `server.js` (log `[hub-faturamento]` ausente de
  erro, `GET /faturamento` respondendo).
- Idem para `frontend` (build Next confirma `/hub/dashboard/faturamento`
  entre as rotas geradas) + `up -d --wait frontend`.
- `ModuloEntidade` (modulo `faturamento`, id=3) ativado para empresa 9001 e
  9002 via SQL idempotente (`ON CONFLICT ... DO UPDATE SET ativo=true`) —
  mesmo padrão da S5 (nav do shell não gateia por módulo, só permissão
  RBAC; a ativação é só para o item aparecer na navegação lateral).
- Produção (`envio-massa-homologacao_*`) smoke `/login` = 200 antes e depois
  do deploy; nenhum recurso fora do prefixo `hub-`/`hub_` tocado.

## 1. Task 6.1 — DTO/API client frontend

- `lib/hub/faturamento-dto.ts` + `lib/hub/faturamento-api.ts` criados,
  espelhando `contracts/faturamento-api.md` (mesmo molde de
  `motoristas-dto.ts`/`motoristas-api.ts`). `valor`/`totalGeral`/`total`
  tipados como `string` (nunca convertidos para `number`).
- Teste unitário `faturamento-dto.test.ts`: **11/11 passed** (`npx vitest run
  lib/hub/faturamento-dto.test.ts`).
- **Roundtrip real (task 6.1.3, Cenário 13)** — login via `curl` contra
  `qa.importacoes@moveelog.local` (empresa 9001), fetch real de
  `GET /faturamento`/`GET /faturamento/resumo`(`?groupBy=categoria`), JSON
  salvo em arquivo e alimentado a `parseFaturamentoListResponse` /
  `parseFaturamentoResumoCards` / `parseFaturamentoResumoAgrupado` via
  `node --experimental-strip-types` (sem transpilar, sem mock):
  ```
  LIST OK — items: 3 total: 212 valor typeof: string
  CARDS OK — {"totalGeral":"21000.00","categoriaMaiorValor":"seed FASE 8 hub-motoristas","entregadoresDistintos":207}
  AGRUPADO OK — {"groupBy":"categoria","grupos":[{"chave":"reimport FASE 8 cenario 4","rotulo":"reimport FASE 8 cenario 4","total":"100.00","quantidade":2}]}
  ```
  Nenhuma exceção lançada pelos parsers — shape real do backend bate 100%
  com o contrato/DTO, sem drift snake_case↔camelCase.

## 2. Task 6.2 — Página `/hub/dashboard/faturamento`

- Cards (total geral / categoria de maior valor / entregadores distintos),
  filtros server-side (`de`/`ate` rotulados explicitamente como "data de
  competência" — Cenário 5; `categoria`/`subpraca`/`entregadorId`/
  `comEntregador`), tabela paginada, export CSV condicionado a
  `faturamento.exportar`, link condicional para
  `/hub/dashboard/motoristas/{entregadorId}` quando `motoristas.consultar`
  presente, estados vazio/loading/erro — mesmo molde de
  `.../importacoes/page.tsx`/`.../motoristas/page.tsx`.
- Guarda de UI para o filtro contraditório do contrato (`entregadorId` +
  `comEntregador=false`): ao selecionar "Só agregados/bônus" o campo de ID
  do entregador é limpo automaticamente (e vice-versa) — evita o usuário
  topar com `400 FILTRO_CONTRADITORIO`.
- `npx tsc --noEmit` — limpo. `npx eslint` nos 4 arquivos novos — limpo.
  `npm run build` (Next/Turbopack) — build de produção OK, rota
  `/hub/dashboard/faturamento` gerada (○ estática).
- **Cenário 14 (branding claro/escuro)** — `playwright.config.cenario14.ts`
  + `tests/e2e-hub-cenario14/cenario14-branding.spec.ts` (mesmo molde do
  Cenário 12 da S5): login real, tema via `localStorage`, aguarda
  "Carregando" sumir, valida heading + card "Total geral" visíveis,
  screenshot full-page. **2/2 passed**. Screenshots em
  `cenario14-faturamento-{light,dark}.png` (cópia nesta pasta) — identidade
  EntreGô 2.0 preservada nos dois temas (paleta creme/azul-marinho,
  tipografia, cards, badges de "Agregados/bônus", links azuis para o
  detalhe do entregador).

## 3. Dataset observado (ambiente hub-homolog, não é seed novo desta fase)

211-212 lançamentos (varia com o timing de reimportações de cenários
anteriores da S5/S6), 207 entregadores distintos, total geral R$ 20.900,00
no filtro default (últimos 30 dias) — dados residuais das FASES 1-5/S5,
suficientes para validar shape e UI; o dataset de ~900 mil linhas dedicado
(Cenário 15, performance) é tarefa da FASE 7 (7.2.1), ainda não gerado.

## 4. Pendências para a FASE 7

- Quickstart Cenários 1-14 (verificação exaustiva com queries SQL de
  referência, incluindo bypass de UI via `curl` para permissões
  independentes — Cenário 10 — e isolamento multi-tenant — Cenário 11).
- Cenário 15 (performance sob volume ampliado ~900 mil linhas/1 ano) —
  gerar seed dedicado, medir `GET /faturamento/resumo` com/sem `groupBy`,
  `EXPLAIN ANALYZE`.
- Registro no DIÁRIO do hub-frota + evidências finais para `review-task`.
