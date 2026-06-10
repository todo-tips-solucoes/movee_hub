# Implementation Plan: Movimento por Empresa/Filial

**Feature**: `movimento-por-filial`
**Branch**: `feat/movimento-por-filial`
**Spec**: [spec.md](./spec.md)
**Constitution**: [docs/constitution.md](../../constitution.md) v1.1.0
**Created**: 2026-06-10

## Summary

Adicionar um **seletor de filial pesquisável** (combobox) no dashboard de
movimento do `frontend_v2` e tornar TODOS os endpoints de movimento
(`EnvioMassa`) capazes de operar sobre uma **empresa-alvo dentro do escopo do
grupo** do usuário autenticado — em vez de ficarem hard-scoped ao
`req.user.empresaId` do token.

Abordagem técnica (mínima invasão, 100% backward-compatible):

1. **Backend** — criar um helper `resolveEmpresaAlvo(user, requestedId)` que
   reaproveita o `resolveScope(user)` já exportado em `routes/grupo.js`
   (config-ui-tenant). Default = `req.user.empresaId` (sem `empresa_id` →
   comportamento idêntico ao atual). `empresa_id` fora do escopo → **403**.
   Thread o `empresa_id` (query / multipart field / body) em GET /envio-massa,
   POST /upload, GET /export-envio-massa, GET /download-xml-movimento,
   POST /close-movimento, DELETE /envio-massa/:id, PATCH /update-envio-massa/:id.
   Novo endpoint `GET /grupo/escopo` (authenticateToken, SEM `requireGrupoPai`)
   alimenta o combobox.

2. **Frontend** — combobox pesquisável (adicionar shadcn `command` + `popover`),
   visibilidade dirigida por `GET /grupo/escopo` (`empresas.length > 1`),
   estado via query param `?empresa_id=N` (`useSearchParams`), threading do
   `empresa_id` em `use-envio-massa.ts` + `api-client.ts`, refetch ao trocar.

3. **Schema** — **nenhuma mudança**. `EnvioMassa.id_empresa` e `Empresa.id_grupo`
   já existem. O escopo do grupo já é resolvido por `resolveScope`.

O **loop de envio / ProcessControl** (validate-xml-batch, processBatchMessages)
está **explicitamente fora do MVP** (FR-EX-001) e permanece operando sobre
`req.user.empresaId`.

## Technical Context

| Campo | Valor |
|-------|-------|
| **Backend** | Node.js + Express (`app_homologacao/backend/server.js`, ~1850 linhas), PostgREST como camada de dados (`postgrestRequest`) |
| **Frontend** | Next.js 16.2.3 + React 19.2.4 (`app_homologacao/frontend_v2`), App Router, Tailwind + shadcn/ui, white-label EntreGô 2.0 |
| **Auth** | JWT em cookie httpOnly; `req.user` carrega `{ empresaId, id_grupo, is_grupo_pai, nome_empresa, ... }` |
| **Proxy** | `frontend_v2/app/api/[...path]/route.ts` repassa cookies; funciona p/ rotas novas e query strings sem alteração |
| **HTTP client** | `frontend_v2/lib/api-client.ts` (`api.get/post/patch/del/uploadFile/downloadBlob`), `BASE='/api'`, `credentials:'include'` |
| **Helper de escopo existente** | `resolveScope(user)` em `routes/grupo.js:50` (exportado), retorna `[empresaId]` ou `[empresaId, ...idsFilhos]` |
| **UI components existentes** | `components/ui/`: alert-dialog, badge, button, card, checkbox, dialog, dropdown-menu, input, label, **select**, separator, sonner, table, tooltip. **NÃO há** `command`/`popover` |
| **Deps a adicionar (frontend)** | `cmdk` + `@radix-ui/react-popover` (para combobox pesquisável shadcn) |
| **Testing** | Backend: testes manuais via curl/E2E operador (não há suite automatizada de unidade no backend hoje). Frontend: `npm run build` (tsc) como gate + E2E manual |
| **Deploy** | Docker (Swarm homologação) via `app_homologacao/docker-compose.yml`; imagens em `registry.todo-tips.com`; Traefik. Mudança aditiva. Apenas com autorização explícita do operador (D9) |
| **NEEDS CLARIFICATION** | 0 — todas as 9 decisões §3 pré-confirmadas pelo operador |

## Constitution Check

*GATE: Deve passar antes do Phase 0. Re-checado após Phase 1 (ETAPA 7).*

| Princípio | Status | Notas |
|-----------|--------|-------|
| **I. Segurança de Autenticação & Segredos** (NON-NEGOTIABLE) | PASS | Nenhum segredo tocado. Todos os endpoints continuam sob `authenticateToken` (cookie httpOnly). `empresa_id` NUNCA dá acesso a token/segredo. |
| **II. Isolamento Multi-Tenant por Empresa** (NON-NEGOTIABLE, v1.1.0) | PASS | **Materializa o amendment v1.1.0**: `empresa_id` é pedido do cliente, mas o **conjunto de IDs acessíveis sai exclusivamente do token** via `resolveScope(req.user)`. `resolveEmpresaAlvo` valida o `empresa_id` requisitado contra esse conjunto; fora do escopo → 403. Default = `req.user.empresaId`. Tokens de filho (`is_grupo_pai=false`) continuam vendo só a própria empresa (escopo `[empresaId]`). |
| **III. Contratos de API & Proxy de Cookies** | PASS | Frontend continua falando só via proxy `/api/*` com `credentials:'include'`. Rotas novas (`GET /grupo/escopo`) e query strings passam pelo proxy sem alteração. READMEs do backend a atualizar no mesmo PR (SHOULD). |
| **IV. Qualidade e Revisão de Mudanças** | PASS | Branch `feat/movimento-por-filial`. Conventional Commits. Toca upload de XML → revisão OWASP (SHOULD) coberta pelo gate `owasp-security` do pipeline. Validação de entrada do `empresa_id` é explícita (`parseInt` + `Number.isInteger` + `includes`). |
| **V. Deploy Conteinerizado e Convivência de Serviços** (NON-NEGOTIABLE) | PASS | Mudança aditiva: novo endpoint + threading em endpoints existentes + deps frontend. Deploy por bump de imagem (`docker service update --image`), sem disputar portas, sem afetar containers vivos. |

**Resultado**: PASS em todos os 5 princípios. Nenhum MUST violado. Prosseguir.

## Project Structure

### Documentation (this feature)

```
docs/specs/movimento-por-filial/
├── spec.md              # WHAT/WHY (já existe)
├── plan.md              # este arquivo (HOW)
├── research.md          # decisões técnicas (Phase 0)
├── data-model.md        # entidades + escopo (Phase 1)
├── quickstart.md        # cenários de teste E2E + roundtrip (Phase 1)
└── contracts/
    ├── grupo-escopo-api.md     # GET /grupo/escopo + helper resolveEmpresaAlvo
    └── movimento-api.md        # threading de empresa_id nos 7 endpoints
```

### Source Code (repository root)

```
app_homologacao/
├── backend/
│   ├── server.js                       # MOD: thread empresa_id em 7 endpoints (276,762,776,1165,1410,1498,1770)
│   ├── routes/grupo.js                 # MOD: + resolveEmpresaAlvo (export) + GET /grupo/escopo
│   └── README.md                       # MOD: documentar empresa_id + GET /grupo/escopo (SHOULD, Princ. III)
└── frontend_v2/
    ├── components/ui/
    │   ├── command.tsx                 # NEW: shadcn command (cmdk)
    │   └── popover.tsx                 # NEW: shadcn popover (@radix-ui/react-popover)
    ├── components/
    │   └── empresa-selector.tsx        # NEW: combobox pesquisável "Filial"
    ├── hooks/use-envio-massa.ts        # MOD: thread empresa_id em todas as chamadas de movimento
    ├── lib/api-client.ts               # MOD: get/del/post/downloadBlob aceitam empresa_id; uploadFile aceita extraFields
    ├── app/dashboard/page.tsx          # MOD: renderizar <EmpresaSelector> no header; useSearchParams
    ├── contexts/                       # (sem mudança — combobox dirigido por GET /grupo/escopo, não por is_grupo_pai do client)
    └── package.json                    # MOD: + cmdk + @radix-ui/react-popover

docs/sql/                               # 006-*.sql APENAS se algo exigir schema (não previsto — placeholder)
```

## Convenções de Borda

A feature atravessa DB ↔ backend ↔ frontend. Fonte da verdade de cada convenção:

| Camada | Case style | Validação | Fonte da verdade |
|--------|------------|-----------|------------------|
| DB columns (PostgREST/`EnvioMassa`, `Empresa`) | snake_case (`id_empresa`, `id_grupo`, `nome_empresa`, `mov_fechado`) | PostgREST schema | tabelas existentes (sem migration) |
| Backend (`req.user`) | camelCase (`empresaId`, `is_grupo_pai`, `id_grupo`) | claims do JWT (assinado server-side) | `generateAccessToken` em `server.js` |
| API payload — request | **`empresa_id`** (snake_case) | `resolveEmpresaAlvo` (parseInt + Number.isInteger + escopo) | `contracts/movimento-api.md` |
| API payload — `GET /grupo/escopo` response | snake_case (`nome_empresa`) + `id`, `default` | shape fixo do endpoint | `contracts/grupo-escopo-api.md` |
| URL query param (frontend) | **`empresa_id`** (snake_case, consistente com o backend) | `useSearchParams` + número | `app/dashboard/page.tsx` |
| Frontend DTO (combobox) | `{ id: number, nome_empresa: string }` | TS interface + consumo direto do JSON do endpoint | `components/empresa-selector.tsx` |

**Decisão de case (dec-borda)**: o parâmetro de cliente é **`empresa_id`**
(snake_case) em TODAS as bordas (query string, multipart field, body JSON, URL
query param do frontend). Razão: consistência com a coluna `id_empresa`/o
vocabulário PostgREST do projeto e com o helper `resolveScope`; evita um mapper
camelCase↔snake_case extra só para este parâmetro. O backend já mistura
`empresaId` (camelCase, interno do token) com `id_empresa` (snake_case, coluna) —
o cliente NUNCA fala `empresaId`, sempre `empresa_id`.

**Mapper layer (DB ↔ DTO)**: não há ORM. As queries PostgREST são montadas à
mão em `server.js` (`EnvioMassa?id_empresa=eq.${idEmp}`). O único "mapper" é o
helper `resolveEmpresaAlvo`, que converte `empresa_id` (string do cliente) →
inteiro validado contra o escopo do token.

**Validação**: NÃO há Zod no projeto. Validação é imperativa
(`parseInt(requestedId,10)` + `Number.isInteger` + `escopo.includes(alvo)`),
centralizada no helper `resolveEmpresaAlvo` — single source of truth para os 7
endpoints (evita validação divergente por endpoint).

## Phase 0 — Research

Ver [research.md](./research.md). Decisões resolvidas:

- **D0.1** — Tipo do combobox: shadcn `command` + `popover` (`cmdk`) vs nativo `<Select>`.
- **D0.2** — Onde mora `resolveEmpresaAlvo`: `routes/grupo.js` (exportado) vs `server.js`.
- **D0.3** — Fonte do `empresa_id` por endpoint (query vs body vs multipart field).
- **D0.4** — Visibilidade do combobox: `GET /grupo/escopo` (`length>1`) vs `is_grupo_pai` no client.
- **D0.5** — Os 3 ramos hardcoded (`id_empresa===6`, `===16`, `Number(empresaId)===6`): impacto.
- **D0.6** — Export (`/export-envio-massa` vs `exportCSV` client-side) — qual realmente importa.
- **D0.7** — PATCH `/update-envio-massa/:id` hoje NÃO valida ownership (gap de segurança pré-existente).

## Phase 1 — Design

- [data-model.md](./data-model.md) — Empresa/Filial, Movimento (EnvioMassa), Grupo, escopo derivado do token.
- [contracts/grupo-escopo-api.md](./contracts/grupo-escopo-api.md) — `GET /grupo/escopo` + helper `resolveEmpresaAlvo`.
- [contracts/movimento-api.md](./contracts/movimento-api.md) — threading de `empresa_id` nos 7 endpoints + contrato dos 403.
- [quickstart.md](./quickstart.md) — cenários de teste backend (default / em-escopo / fora→403 / não-numérico) + E2E + roundtrip.

## Re-check de Constitution (pós-design)

Reavaliado após Phase 1 (ETAPA 7):

- **II (Multi-Tenant)**: o design **centraliza** a validação de escopo em um único
  helper (`resolveEmpresaAlvo`), o que REDUZ a superfície de erro vs. validação
  ad-hoc por endpoint. Reforça o princípio em vez de enfraquecê-lo. **PASS**.
- **Complexidade introduzida**: 1 endpoint novo + 2 componentes UI novos
  (command/popover são primitivas shadcn padrão, não arquitetura ad-hoc) +
  threading de 1 parâmetro. Nenhum novo serviço, camada ou dependência de
  infraestrutura. **Sem violação que exija Complexity Tracking.**
- **V (Deploy aditivo)**: confirmado — bump de imagem, sem nova porta/serviço. **PASS**.

Resultado do re-check: **PASS**. Nenhum MUST violado pelo design.

## Complexity Tracking

N/A — nenhuma violação de constitution que exija justificativa. O design é
minimamente invasivo: reusa `resolveScope`, adiciona 1 helper + 1 endpoint +
combobox padrão shadcn, sem mudança de schema.

## Próximos Passos

1. `/checklist` — quality gate de requisitos antes de implementar.
2. `/create-tasks` — decompor este plano em backlog executável.
3. `/analyze` — validar consistência cross-artifact (após tasks).
4. Acabamento de UI via `/ui-ux-pro-max` (fase própria — não nesta).
