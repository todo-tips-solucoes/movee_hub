# Implementation Plan: Cadastro de Filiais

**Feature**: `cadastro-filiais`
**Branch**: `feat/cadastro-filiais`
**Spec**: [spec.md](./spec.md)
**Plano de referência**: [docs/plans/cadastro-filiais-envmass2.md](../../plans/cadastro-filiais-envmass2.md)
**Created**: 2026-06-09

## Summary

Substituir o fluxo de "vincular filial por ID numérico" por um **cadastro
completo de filial** de dentro do painel. O admin do grupo (`is_grupo_pai`)
preenche um formulário (nome, e-mail, senha, CNPJ + campos fiscais opcionais),
e a empresa filial nasce **já vinculada ao grupo do admin** — o `id_grupo` é
sempre derivado do token JWT (Princípio II, NON-NEGOTIABLE), nunca do corpo da
requisição.

**Abordagem técnica**: um novo endpoint `POST /grupo/empresas` em
`routes/grupo.js` reaproveita a lógica de resolução/criação preguiçosa do
`Grupo` já existente no `POST /grupo/filhos` (extraída para um helper
`resolveOrCreateGrupo(user)`), injeta `bcrypt` via `init()`, valida unicidade
de e-mail (400) e CNPJ (409), respeita o limite de 100 filiais (422) e cria a
`Empresa` num único `POST` com `id_grupo` do token. O frontend troca o card de
vínculo-por-ID por um formulário (reaproveitando o `PasswordStrength` do
`register/page.tsx`), mantendo lista, desvincular e gate de admin intactos. Uma
nova coluna `cnpj` (com UNIQUE) é adicionada via DDL `004` aplicado pelo
operador.

## Technical Context

| Campo | Valor |
|-------|-------|
| **Linguagem (backend)** | Node.js + Express (CommonJS) |
| **Linguagem (frontend)** | TypeScript + Next.js (App Router), React client components |
| **Acesso a dados** | PostgREST via `postgrestRequest(endpoint, method, body)` — sem ORM, sem transação |
| **Auth** | JWT em cookie httpOnly; middleware `authenticateToken`; `req.user = { empresaId, id_grupo, is_grupo_pai, ... }` |
| **Hash de senha** | `bcrypt.hash(senha, 10)` (já usado em `POST /register`) |
| **Storage** | PostgreSQL (atrás do PostgREST), role `authenticated` |
| **Proxy frontend↔backend** | `app/api/[...path]/route.ts` repassa `/api/grupo/*` sem mudança (Princípio III) |
| **Deploy** | Docker Swarm + Traefik (frontend_v2 + backend); DDL aplicado pelo operador |
| **UI design** | EntreGô 2.0 (Plus Jakarta Sans, tokens shadcn, white-label) via `/ui-ux-pro-max` |
| **NEEDS CLARIFICATION** | 0 (resolvidos em research.md e na fase clarify) |

### Fatos do codebase (inspecionados empiricamente)

- `routes/grupo.js`: `init({ postgrestRequest })` nas linhas 26-28 — **bcrypt NÃO injetado** (gap).
- `requireGrupoPai` na linha 85: `403` se `req.user.is_grupo_pai !== true`.
- `POST /grupo/filhos`: resolução/criação preguiçosa do `Grupo`
  (`Grupo?id_empresa_pai=eq.{empresaId}`, cria via `POST Grupo` se ausente),
  limite de 100 filhos (`422`), e `PATCH Empresa SET id_grupo`.
- `GET /grupo/filhos` e `DELETE /grupo/filhos/:id` existem e devem permanecer intactos.
- `Empresa` (colunas reais): `id, nome_empresa, email, pass, id_grupo, workflow_id,
  sender, tk, connection_id, endereco, numero, cep, email_nota, observacao`.
  **Não existe coluna `cnpj`** — será adicionada pelo DDL 004.
- `server.js`: `POST /register` (~1775), mount `grupoRoutes.init(...)` + `app.use('/grupo', ...)` (~1825).
- `register/page.tsx`: `PasswordStrength` (regra: `length >= 6 && /[A-Z]/ && /\d/`).
- DDL 003 estabeleceu o padrão: `GRANT SELECT,INSERT,UPDATE,DELETE ... TO authenticated` +
  `GRANT USAGE,SELECT ON SEQUENCE` + `NOTIFY pgrst, 'reload schema'`.

## Constitution Check

*GATE: Deve passar antes do Phase 0. Re-checado após Phase 1 (ver §Re-check).*

| Princípio | Status | Notas |
|-----------|--------|-------|
| I. Segurança de Auth & Segredos (NON-NEGOTIABLE) | PASS | Senha via `bcrypt.hash(senha, 10)` (MUST §I); endpoint exige `authenticateToken`; nenhum segredo no payload/log. |
| II. Isolamento Multi-Tenant (NON-NEGOTIABLE) | PASS | `id_grupo` resolvido server-side via `resolveOrCreateGrupo(req.user)`, **nunca do body** (SC-004). Endpoint exige `authenticateToken` + `requireGrupoPai`. |
| III. Contratos de API & Proxy de Cookies | PASS | Endpoint sob `/grupo/*`, acessado via proxy `/api/grupo/empresas` com `credentials: 'include'`; README do backend a atualizar (SHOULD). |
| IV. Qualidade e Revisão de Mudanças | PASS | Trabalho em `feat/cadastro-filiais`; Conventional Commits; toca auth → revisão OWASP (SHOULD); validação de entrada explícita (CNPJ, e-mail, senha). |
| V. Deploy Conteinerizado (NON-NEGOTIABLE) | PASS | Deploy aditivo via Swarm (frontend_v2 + backend); DDL aplicado pelo operador; nenhuma porta nova. |

**Resultado**: PASS em todos os princípios MUST. Prosseguir.

## Project Structure

### Documentação (feature dir)

```
docs/specs/cadastro-filiais/
├── spec.md              # já existente (US, FR, SC, Clarifications)
├── plan.md              # este arquivo
├── research.md          # decisões técnicas (Phase 0)
├── data-model.md        # entidades Empresa(+cnpj), Grupo
├── contracts/
│   └── grupo-empresas-api.md   # contrato do POST /grupo/empresas + endpoints mantidos
└── quickstart.md        # cenários de teste (happy path + errors + roundtrip E2E)

docs/sql/
└── 004-cadastro-filiais-cnpj.sql   # DDL: ADD COLUMN cnpj + UNIQUE + GRANT + NOTIFY (operador aplica)
```

### Source code (árvore real do projeto, alvos de mudança)

```
app_homologacao/
├── backend/
│   ├── server.js                        # ALTERAR: injetar bcrypt no grupoRoutes.init (~linha 1825)
│   ├── README.md                        # ATUALIZAR: documentar POST /grupo/empresas (Princípio III SHOULD)
│   └── routes/
│       └── grupo.js                      # ALTERAR: init({postgrestRequest, bcrypt});
│                                         #   extrair resolveOrCreateGrupo(user);
│                                         #   novo POST /grupo/empresas; manter filhos
└── frontend_v2/
    └── app/
        ├── dashboard/configuracoes/grupo/
        │   └── page.tsx                  # ALTERAR: trocar card vincular-por-ID por
        │                                  #   formulário "Cadastrar filial"; manter lista/DELETE/gate
        └── api/[...path]/route.ts         # SEM MUDANÇA (proxy já encaminha /api/grupo/*)
```

## Convenções de Borda

Feature atravessa 3 camadas (PostgreSQL ↔ backend Express ↔ frontend Next/TS).
Convenções declaradas upfront para evitar drift snake_case/camelCase:

| Camada | Case style | Validação | Fonte da verdade |
|--------|------------|-----------|------------------|
| DB columns (PostgreSQL) | snake_case (`nome_empresa`, `id_grupo`, `email_nota`, `cnpj`) | constraint UNIQUE + DDL | `docs/sql/004-cadastro-filiais-cnpj.sql` |
| Backend ↔ PostgREST | snake_case (PostgREST espelha colunas) | nenhuma camada de mapper | nomes de coluna reais da `Empresa` |
| API payload — **request** (frontend → backend) | snake_case | validação manual no handler Express | `contracts/grupo-empresas-api.md` |
| API payload — **response** | snake_case (`{ id, nome_empresa, email, id_grupo }`) | — | `contracts/grupo-empresas-api.md` |
| URL path | kebab/flat (`/grupo/empresas`) | Express router | `routes/grupo.js` |

**Decisão de borda (dec-borda)**: este projeto usa **snake_case em todas as
camadas** (DB, PostgREST, payload da API e estado do frontend). NÃO há mapper
snake↔camel. Confirmado empiricamente: `POST /grupo/filhos` e `GET /grupo/filhos`
já retornam `nome_empresa`/`id_grupo` em snake_case, e o `register/page.tsx`
envia `{ nomeEmpresa, email, senha }` em camelCase APENAS porque o `POST /register`
faz a tradução interna. Para a borda nova (`/grupo/empresas`), padronizar
**snake_case no body** alinha com os outros endpoints de grupo e elimina a
necessidade de mapper. O `id_grupo` NUNCA aparece no body de request (Princípio II).

**Mapper layer (DB ↔ DTO)**: N/A — PostgREST expõe colunas diretamente; sem ORM.

**Validação**: manual no handler (sem Zod no backend Express); frontend valida
inline antes de submeter (espelha a regra do backend).

## Phase 0 — Research

Ver [research.md](./research.md). Decisões resolvidas:

1. Injeção de `bcrypt` em `grupo.js` (vs helper compartilhado no `server.js`).
2. Coluna `cnpj`: tipo, UNIQUE com múltiplos NULL, gating de degradação.
3. Idempotência sem transação (criar Grupo + criar Empresa).
4. Mapeamento de erros PostgREST → códigos HTTP (400/409/422).
5. Case style da borda (snake_case em todas as camadas).
6. Regra de senha reaproveitada do `register`.

## Phase 1 — Design

- [data-model.md](./data-model.md) — entidades `Empresa` (+ `cnpj`) e `Grupo`.
- [contracts/grupo-empresas-api.md](./contracts/grupo-empresas-api.md) — contrato do
  novo endpoint + endpoints mantidos (filhos GET/DELETE).
- [quickstart.md](./quickstart.md) — cenários de teste, incluindo roundtrip E2E real.

## Re-check de Constitution (pós-design)

| Princípio | Status pós-design | Notas |
|-----------|-------------------|-------|
| I | PASS | Design mantém `bcrypt.hash(senha, 10)`; senha nunca retornada no response 201. |
| II | PASS | Contrato declara `id_grupo` ausente do body; handler deriva via `resolveOrCreateGrupo(req.user)`. Nenhuma complexidade nova viola escopo. |
| III | PASS | Proxy inalterado; payload documentado em contracts/. |
| IV | PASS | Sem complexidade extra (reaproveita helper + padrão DDL existente). |
| V | PASS | Sem serviço novo, sem porta nova. |

Design **não** introduziu complexidade não justificada. Nenhum novo serviço,
nenhuma camada extra: o endpoint reusa o helper de resolução de Grupo, o
PostgREST existente e o padrão de DDL/GRANT de `003`. Constitution mantida.

## Complexity Tracking

N/A — nenhuma violação de constitution; nenhuma justificativa de complexidade necessária.

## Riscos

| Risco | Mitigação |
|-------|-----------|
| Sem transação entre criar `Grupo` (1ª filial) e criar `Empresa` | Idempotência via `Grupo.id_empresa_pai UNIQUE`: resolução é "get-or-create"; `id_grupo` já vai no `POST Empresa` (evita o 2-passos create+PATCH do fluxo de vínculo). |
| Coluna `cnpj` ausente até o operador aplicar DDL 004 | **Decisão (research D2/D3)**: assumir DDL 004 aplicado ANTES do deploy do backend (alinhado ao plano de deploy §8: operador aplica DDL antes de subir o backend). Sem gate de feature no runtime. |
| `id_grupo` vazar do body | Contrato proíbe `id_grupo` no body; handler ignora qualquer `id_grupo`/`id_empresa` recebido e deriva do token (SC-004). |
| Drift snake/camel na borda | Padronizado snake_case em todas as camadas (ver §Convenções de Borda); roundtrip E2E no quickstart valida o shape real. |
| Quebrar o contrato de `POST /grupo/filhos` | Refactor extrai `resolveOrCreateGrupo` SEM mudar o contrato de `/filhos`; teste de regressão do vínculo-por-ID. |

## Próximos Passos

1. `/checklist` — quality gate de requisitos antes de implementar.
2. `/create-tasks` — decompor em backlog executável.
3. `/analyze` — validar consistência cross-artifact após tasks.
