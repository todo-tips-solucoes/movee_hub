# Plano de Implementação — Módulo Faturamento (hub-faturamento / S6)

**Feature**: hub-faturamento · **Fase**: S6 do Hub de Frota · **Branch alvo**:
`feat/hub-faturamento` · **Ambiente**: hub-homolog ISOLADO (VPSTodo, recursos
`hub-*`) — NUNCA produção/`chatmasterveloz`.

## Summary

Consulta somente-leitura sobre o fato `FaturamentoLancamento` (já populado
pelo pipeline de importações da S4, granularidade = 1 linha por lançamento
de crédito): lista paginada e filtrável (período por `data_referencia`,
categoria, entregador, subpraça, presença/ausência de vínculo), cards de
resumo (total geral, categoria de maior valor com desempate alfabético
determinístico — dec-014, entregadores distintos), agregados por
dia/categoria/entregador (bucket fixo "agregados/bônus" para lançamentos
sem entregador — dec-010), export CSV com proteção contra CSV injection e
streaming em lotes (sem carregar o período inteiro em memória), e navegação
opcional para o detalhe da pessoa entregadora (módulo Motoristas, S5).
Nenhuma escrita, nenhuma estrutura de dado nova em `FaturamentoLancamento`
— toda a agregação acontece em 2 funções SQL novas (evita SQL ad-hoc e
mantém a soma numérica 100% em Postgres, sem ponto flutuante). Única lacuna
de RBAC encontrada (research.md Decision 1): falta a permissão
`faturamento.listar` no seed atual — 2 migrations expand-only (`0026`
RBAC, `0027` funções RPC). Detalhes em `research.md`, `data-model.md`,
`contracts/faturamento-api.md`, `quickstart.md`.

## Technical Context

| Campo | Valor |
|-------|-------|
| Linguagem backend | Node.js 14 (Express) — `app_homologacao/backend/` (imagem `Dockerfile.hub`, Node 20 no container do hub) |
| Linguagem frontend | Next.js (frontend_v2, node:20-alpine) — `app_homologacao/frontend_v2/` |
| Persistência | PostgreSQL 13 do hub via **PostgREST** (`lib/hub-postgrest.js`) — isolado, sem acesso a `chatmasterveloz` |
| Auth | JWT cookies httpOnly (`accessToken`/`refreshToken`); claims `sub`/`empresa_ativa`/`escopo` |
| RBAC | `middleware/hub-require-permission.js` (fail-closed) + `lib/hub-rbac-cache.js`; permissões `faturamento.consultar`/`faturamento.exportar` já semeadas em `0007`; `faturamento.listar` **nova**, migration `0026` (research.md Decision 1) |
| RLS | `FaturamentoLancamento` já coberta desde `0015` (`id_empresa = ANY(hub_jwt_escopo_ids())`); nenhuma policy nova — funções RPC novas são `SECURITY INVOKER`, herdam a mesma RLS |
| Migrations | `infra/hub/migrations/` (próxima=0026), aplicadas por `infra/hub/scripts/migrate.sh` |
| Agregação | 2 funções SQL (`hub_faturamento_totais`/`hub_faturamento_agrupado`), migration `0027` — `SUM(valor)` nativo sobre `numeric(12,2)`, zero ponto flutuante (research.md Decision 2) |
| Export CSV | streaming em lotes de 1.000 via paginação `Range` do PostgREST já existente; proteção de injeção extraída para `lib/hub-csv.js` compartilhado (research.md Decisions 5/6) |
| Testing | unit (DTO/CSV/RPC-mapper) + integração (PostgREST hub) — padrão `tests/hub-*.test.js` |
| Design UI | EntreGô 2.0 preservado; tela via `/ui-ux-pro-max`; rota real `/hub/dashboard/faturamento` (research.md Decision 10, segue convenção S4/S5, não o rascunho `/faturamento` do plano técnico) |
| NEEDS CLARIFICATION restantes | 0 (5 Q/A do clarify integradas: Q1-Q3 por heurística autônoma dec-009/010/011/012, Q4 por resposta do operador dec-014) |

## Constitution Check

*GATE: passou antes do Phase 0 (`feature-00c-preflight.sh check`, exit 0,
`{"ok":true,"findings":[]}`); re-checado após Phase 1 (§ no fim).*

| Princípio | Status | Notas |
|-----------|--------|-------|
| I. Segurança de Auth & Segredos (NON-NEGOTIABLE) | PASS | Auth por cookie httpOnly reusada, sem segredo novo; nenhum dado de autenticação exposto pela API de faturamento |
| II. Isolamento Multi-Tenant por Empresa (NON-NEGOTIABLE) | PASS | `id_empresa` sempre do token; RLS já existente em `FaturamentoLancamento` cobre lista/resumo/export (funções RPC `SECURITY INVOKER` herdam a mesma policy); nenhuma consulta cross-tenant possível por construção |
| III. Contratos de API & Proxy de Cookies | PASS | Endpoints sob `/api/v1/faturamento*`; contrato camelCase declarado (`contracts/faturamento-api.md` + §Convenções de Borda); roundtrip real no quickstart (Cenário 13) |
| IV. Qualidade e Revisão de Mudanças | PASS | Unit-first (DTO, CSV injection, mapeamento RPC); gates doc/security aplicados a este plano; fechamento só em `review-task` (DIARIO + PR) |
| V. Deploy Conteinerizado e Convivência (NON-NEGOTIABLE) | PASS | Só recursos `hub-*` isolados; migrations via `migrate.sh` do hub; nenhuma integração nova com `chatmasterveloz` (feature 100% leitura sobre dado já importado dentro do hub isolado) |

Nenhuma violação de MUST. Prosseguir.

## Project Structure

### Documentação (feature dir)
```
docs/specs/hub-faturamento/
├── spec.md            (existente; clarify integrado — Clarifications + FR-003)
├── plan.md            (este)
├── research.md        (Phase 0 — 11 decisions)
├── data-model.md       (FaturamentoLancamento inalterada + Resumo Agregado + Permissao nova)
├── contracts/
│   └── faturamento-api.md
└── quickstart.md       (15 cenários)
```

### Código (árvore real do projeto)
```
infra/hub/migrations/
├── 0026_seed_permissao_faturamento_listar.sql  (novo — Decision 1)
└── 0027_hub_faturamento_rpc_resumo.sql          (novo — Decisions 2-4)

app_homologacao/backend/
├── routes/hub-faturamento.js           (novo — endpoints do contracts/faturamento-api.md)
├── lib/
│   ├── hub-faturamento-dto.js          (novo — mapper snake_case↔camelCase, parsePaginacao/parseFiltros, export streaming)
│   ├── hub-csv.js                      (novo — extraído de hub-importacoes-dto.js: escaparCelulaCsvInjection/quotarCelulaCsv, Decision 6)
│   ├── hub-importacoes-dto.js          (modificado — passa a importar de hub-csv.js, sem mudança de contrato externo)
│   ├── hub-postgrest.js                (existente — reusar, inclusive `opts.range` para paginação do export)
│   ├── hub-rbac-cache.js               (existente — reusar `obterPermissoesEfetivas` na checagem inline de `faturamento.exportar`)
│   └── hub-auditoria.js                (existente — reusar para `faturamento.csv_exportado`)
├── middleware/hub-require-permission.js (existente — reusar, sem alteração)
└── tests/
    ├── hub-csv.test.js                 (novo — unit, extraído/portado de hub-importacoes-dto.test.js)
    ├── hub-faturamento-dto.test.js      (novo — unit, mapper + filtros + paginação)
    └── hub-faturamento.test.js          (novo — integração, PostgREST hub)

app_homologacao/frontend_v2/
├── app/hub/dashboard/faturamento/
│   └── page.tsx                        (novo — lista + filtros + cards, padrão de .../importacoes/page.tsx)
└── lib/hub/
    ├── faturamento-api.ts              (novo — chamadas ao backend)
    └── faturamento-dto.ts              (novo — tipos + parse defensivo, padrão de motoristas-dto.ts)
```
`server.js` linha ~2634 ganha 1 linha nova:
`app.use('/api/v1/faturamento', hubFaturamentoRoutes.router);` (mesmo
padrão de `hubMotoristasRoutes`/`hubImportacoesRoutes`, já registradas
logo acima).

## Convenções de Borda

| Camada | Case style | Validação | Fonte da verdade |
|--------|------------|-----------|------------------|
| DB columns (PostgreSQL) | snake_case | CHECK/constraint já existentes (`0013`) | `infra/hub/migrations/0013_faturamento_lancamento.sql` |
| PostgREST payload | snake_case | — (espelha DB) | tabela `FaturamentoLancamento` + funções RPC `0027` |
| Backend DTO / API payload (request/response) | **camelCase** | shaping no route + `hub-faturamento-dto.js` | `app_homologacao/backend/routes/hub-faturamento.js` |
| Valor monetário (agregado ou linha) | **string decimal** (não `number`) | `::text` na RPC / no mapper | `contracts/faturamento-api.md` (research.md Decision 7) |
| Frontend DTO (TS) | camelCase | parse defensivo no fetch | `app_homologacao/frontend_v2/lib/hub/faturamento-dto.ts` |
| URL query/path params | camelCase (`pageSize`, `groupBy`, `comEntregador`, `entregadorId`) | router Express | `contracts/faturamento-api.md` |

**Mapper layer (DB ↔ DTO)**: `routes/hub-faturamento.js` + `lib/hub-faturamento-dto.js`
traduzem snake_case do PostgREST → camelCase da API (mesmo padrão de
`hub-me.js`/`hub-motoristas.js`/`hub-importacoes.js`), incluindo o cast
`numeric → text` dos campos monetários (Decision 7 — nunca reinterpretado
como `number` JS antes de chegar ao frontend). ORM auto-mapping: **NÃO**
(PostgREST REST puro + 2 funções RPC parametrizadas). **Validação**: shape
do request validado no backend (enum de `groupBy`, formato de data);
response validada no roundtrip E2E (quickstart Cenário 13) — evita drift
snake↔camel histórico (mesma lição de dec-172/dec-173 citada na skill
`/plan`).

## Plano por fases (ordem do briefing)

1. **Migrations** (`0026`–`0027`) — permissão `faturamento.listar` +
   concessão aos papéis (`admin_plataforma`/`admin_entidade`/`operador`/
   `leitura`); funções `hub_faturamento_totais`/`hub_faturamento_agrupado`
   (`SECURITY INVOKER`, desempate alfabético embutido, bucket
   "agregados/bônus" embutido) + `GRANT EXECUTE`. Aplicar via `migrate.sh`
   no hub-homolog; verificar reload PostgREST (SIGUSR1). Idempotência:
   re-rodar = no-op.
2. **Extração de `lib/hub-csv.js`** — mover `escaparCelulaCsvInjection`/
   `quotarCelulaCsv` de `hub-importacoes-dto.js` sem mudar comportamento;
   `hub-importacoes-dto.test.js` continua verde sem alteração (regressão
   zero).
3. **Lista (leitura)** — `GET /faturamento`: filtros server-side
   (`de`/`ate`/`categoria`/`entregadorId`/`subpraca`/`comEntregador`),
   paginação (`PAGE_SIZE_DEFAULT=20`/`MAX=100`, janela padrão 30 dias —
   mesmas constantes de `importacoes`/`motoristas`), validação de filtro
   contraditório (`entregadorId` + `comEntregador=false`).
4. **Resumo (agregados)** — `GET /faturamento/resumo`: chama
   `hub_faturamento_totais` (sem `groupBy`) ou `hub_faturamento_agrupado`
   (com `groupBy`); resolve `rotulo` via join com `Entregador`/literal
   "Agregados/bônus"; trata período vazio como `200` com zeros (FR-012).
5. **Export CSV** — `?format=csv` no mesmo `GET /faturamento`; checagem
   inline de `faturamento.exportar` (Decision 9) ANTES de qualquer query;
   laço de paginação `Range` em lotes de 1.000 + `res.write()` incremental
   (Decision 5); neutralização via `lib/hub-csv.js`; auditoria
   `faturamento.csv_exportado` só no sucesso (mesmo padrão de
   `importacao.original_baixado`).
6. **Tela** — `/hub/dashboard/faturamento` via `/ui-ux-pro-max` (reusar
   padrões shadcn/hook server-side de `.../importacoes/page.tsx`): cards de
   totais, filtros, tabela paginada, botão de export condicionado à
   permissão, link condicional para detalhe do entregador (`motoristas.consultar`
   já carregado por `GET /me`); estados "período sem dados"/loading/erro.
7. **E2E + evidências** — quickstart 15 cenários no hub-homolog com seeds
   sintéticos; roundtrip real (Cenário 13); permissões independentes
   (Cenário 10); CSV injection (Cenário 8); isolamento multi-tenant
   (Cenário 11); branding claro/escuro (Cenário 14); performance sob
   volume ampliado (Cenário 15, só nesta fase, com seed dedicado).

## Complexity Tracking

Sem violações de constitution que exijam justificativa. Complexidade
deliberadamente contida: nenhuma tabela nova (só 1 permissão de RBAC + 2
funções SQL); nenhuma view materializada (decisão explicitamente adiada até
SC-004 medir com volume real — research.md Decision 8); export CSV reusa
100% a infraestrutura de paginação `Range` já existente, sem introduzir
driver de banco novo (nenhuma exceção ao padrão "hub fala só com
PostgREST").

## Re-check de Constitution (pós-Phase 1)

Design não introduziu complexidade não justificada. As 2 migrations novas
são o mínimo necessário para tornar FR-003/FR-004/FR-008 testáveis: a
permissão `faturamento.listar` fecha uma lacuna real do RBAC seedado
(sem ela, FR-008 seria inobservável); as 2 funções RPC são o único desenho
que satisfaz FR-003 (soma sem ponto flutuante, desempate determinístico) e
FR-006 (export sem buffer total) sem mover a agregação para o backend
Node (o que exigiria carregar linhas em memória — o oposto do que a spec
proíbe). Nenhuma tabela nova, nenhum índice novo (spec FR-002 proíbe
explicitamente índice novo — respeitado). MUST I–V continuam PASS.

**Gate `owasp-security`** (a rodar sobre este plano antes de `create-tasks`,
conforme protocolo de Quality Gates do orquestrador): superfície de ataque
desta fase é estritamente leitura + export — os riscos antecipáveis já
foram endereçados no design: (a) SQL injection nas funções RPC — mitigado
por parametrização nativa (`p_categoria`, `p_entregador_id` etc. como
argumentos tipados da função, nunca concatenação — mesmo padrão validado no
gate de `hub-motoristas`); (b) BOLA entre tenants — estruturalmente
impossível, RLS já cobre `FaturamentoLancamento` e as funções `SECURITY
INVOKER` herdam a mesma policy; (c) bypass de permissão de export via
chamada direta — endereçado por checagem inline explícita ANTES de
qualquer I/O (Decision 9), com Acceptance Scenario dedicado (User Story 2
cenário 4) e Cenário 10 do quickstart cobrindo o teste; (d) CSV
injection — mitigado por reuso do mecanismo já testado em produção
(`lib/hub-csv.js`, extraído de `hub-importacoes-dto.js`), não uma
implementação nova.

**Gate `owasp-security` — resultado** (rodado sobre `plan.md` +
`contracts/faturamento-api.md` + `data-model.md`, checklist API Security
Top 10:2023 + OWASP Top 10:2025): A01 BOLA PASS (RLS + `SECURITY INVOKER`);
A02 Auth Failures PASS (reusa cookie httpOnly + `requirePermission`); API3
BOPLA N/A (superfície é 100% `GET`, nenhum corpo de request a validar
contra mass assignment); A05 Injection PASS (funções RPC parametrizadas,
zero SQL concatenado); API5 BFLA PASS — é exatamente o que a permissão
`faturamento.listar` nova resolve (Decision 1/9); A09 Logging PASS (export
auditado; negação de acesso via `requirePermission` já é comportamento
herdado de toda a plataforma, fora do escopo desta fase alterar); A10
Exception Handling — a implementar seguindo o padrão já estabelecido
(`routes/hub-*.js`: erro genérico `500 { erro: 'ERRO_SERVIDOR' }`, nunca
stack trace ao cliente, log server-side com contexto).

1 finding **informativo** (não crítico/alto, não bloqueia): **API4
Unrestricted Resource Consumption** — o export CSV não tem teto de
linhas/período (decisão de produto já ratificada, dec-011) nem
rate-limiting dedicado por endpoint; um usuário autenticado poderia
disparar exports repetidos de períodos amplos e gerar carga na consulta
RPC. Decisão: **aceitar o risco com justificativa** — (a) a superfície é
autenticada e multi-tenant pequeno (ambiente interno, não público); (b)
todo export bem-sucedido já é auditado (`faturamento.csv_exportado`),
dando rastreabilidade para investigar abuso se ele ocorrer; (c)
rate-limiting é uma preocupação transversal a TODOS os módulos do hub (não
só faturamento) — introduzir um limiter só aqui criaria inconsistência;
melhor candidato a uma feature própria de rate-limiting geral da
plataforma, não uma exceção pontual desta fase. Sem exceção de constitution
necessária (não há princípio MUST sobre rate-limiting).

## Próximos passos

1. `/checklist` — quality gate antes de implementar.
2. `/create-tasks` — decompor este plano em backlog executável (ordem das 7 fases).
3. `/analyze` — validar consistência spec↔plan↔tasks após tasks.
