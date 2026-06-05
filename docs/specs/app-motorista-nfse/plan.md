# Implementation Plan: App Motorista (PWA) — Consulta de NF & Validação de XML

**Feature**: `app-motorista-nfse` | **Date**: 2026-06-04 | **Spec**: [./spec.md](./spec.md)

## Summary

App **mobile PWA** para motoristas: (1) login por CNPJ prestador, (2) consulta do
**movimento aberto** (`mov_fechado=false`) com valor/período/dados fiscais, (3) upload
e validação de XML de NFS-e com bloqueio de reenvio quando aprovada. Abordagem técnica:
**reaproveitar a stack do `movee_hub`** — novo frontend Next.js PWA (Serwist) +
**novas rotas `/motorista/*`** no backend Express existente, lendo/escrevendo na
`EnvioMassa` via PostgREST e intermediando a validação NFS-e server-side. Deploy como
**novo serviço no `docker-compose.yml` existente**, atrás do Traefik (aditivo). Detalhes
em [research.md](./research.md), [data-model.md](./data-model.md),
[contracts/motorista-api.md](./contracts/motorista-api.md), [quickstart.md](./quickstart.md).

## Technical Context

**Language/Version**: TypeScript 5.x (frontend) · JavaScript Node 14 (backend existente)
**Primary Dependencies**: Next.js 16 + React 19 + Tailwind 4 + shadcn/ui + **Serwist** (PWA);
Express 4 + jsonwebtoken 8 + bcrypt 5 + axios + multer + xml2js + cookie-parser (backend)
**Storage**: PostgreSQL via **PostgREST** (tabela `EnvioMassa` existente + nova `Motorista`)
**Testing**: testes de cenário do `quickstart.md` (manual + roundtrip real); unit no
backend para mapper e parser de validação
**Target Platform**: PWA mobile (Android/Chrome, iOS/Safari) servido por container Docker
**Project Type**: web (frontend PWA + backend API) — mesma VPS, atrás do Traefik
**Performance Goals**: painel < 5s (SC-001); validação caminho feliz < 15s (SC-002)
**Constraints**: backend stateless (JWT em cookie); sem disputar 80/443; segredos fora do git
**Scale/Scope**: dezenas–centenas de motoristas; 5 user stories; MVP de 1 backend + 1 frontend novo

## Constitution Check

*GATE: passou antes do Phase 0. Re-checado após Phase 1 (sem mudanças).*

| Princípio | Status | Notas |
|-----------|--------|-------|
| I. Auth & Segredos | PASS | JWT cookie httpOnly (15m/7d, SameSite=Strict, Secure prod); bcrypt na `Motorista`; `FASTAPI_VALIDATION_TOKEN`/`JWT_*`/`POSTGREST_API_KEY` em `.env` fora do git; mensagens sem vazar token |
| II. Isolamento Multi-Tenant | PASS | Escopo por `cnpj_prestador` do **token** (`req`), nunca do cliente; toda query PostgREST filtra `cnpj_prestador=eq.{token}` |
| III. Contratos & Proxy de Cookies | PASS | PWA fala só via proxy `/api/motorista/*` (`credentials:'include'`); validação NFS-e intermediada server-side (FR-015); contrato documentado em `contracts/` |
| IV. Qualidade & Revisão | PASS | Branch `feature/app-motorista-nfse`; Conventional Commits; toca auth + XML/upload → **revisão OWASP** antes do merge (SHOULD); validação explícita de upload (rejeita não-XML) |
| V. Deploy Conteinerizado | PASS | Serviço novo aditivo no `docker-compose.yml`, roteado por host no Traefik; sem porta solta; não reinicia containers em produção |

Sem violações → **Complexity Tracking vazio** (nenhuma justificativa necessária).

## Project Structure

### Documentation (this feature)

```
docs/specs/app-motorista-nfse/
├── brief.md         # discovery (entrada)
├── spec.md          # WHAT/WHY (clarificada)
├── plan.md          # este arquivo
├── research.md      # Phase 0 — 7 decisões
├── data-model.md    # Phase 1 — Motorista, EnvioMassa, ResultadoValidacao
├── quickstart.md    # Phase 1 — 10 cenários + roundtrip real
└── contracts/
    └── motorista-api.md   # Phase 1 — rotas /motorista/*
```

### Source Code (repository root)

```
app_homologacao/
├── backend/                      # EXISTENTE — Express Node 14
│   ├── server.js                 # + rotas /motorista/* e middleware authenticateMotorista
│   └── (módulos novos)           # motoristaAuth, validacaoNfse (mapper flag→msg)
├── frontend_v2/                  # EXISTENTE — painel desktop da Empresa (NÃO alterado)
├── frontend_motorista/           # NOVO — Next.js PWA (mobile-first)
│   ├── app/
│   │   ├── api/[...path]/route.ts # proxy de cookies (copiado/adaptado do v2)
│   │   ├── login/page.tsx
│   │   ├── (app)/movimento/page.tsx     # consulta do movimento aberto
│   │   └── (app)/validar/page.tsx       # upload + validação
│   ├── components/ · contexts/auth-context.tsx · lib/api-client.ts  # adaptados do v2
│   ├── public/manifest.json · app/sw.ts # PWA (Serwist)
│   ├── next.config.mjs (output: standalone + withSerwist) · Dockerfile
│   └── .env.example (BACKEND_URL)
└── docker-compose.yml            # + serviço frontend_motorista_homologacao (Traefik)
```

**Structure Decision**: backend **estendido** (não duplicado) + **novo** frontend PWA
isolado, ambos sob `app_homologacao/`. Justificativa em research.md Decisions 1 e 2.

## Convenções de Borda

| Camada | Case style | Validação | Fonte da verdade |
|--------|------------|-----------|------------------|
| DB columns (PostgreSQL/PostgREST) | snake_case | schema PostgREST | tabelas `EnvioMassa`, `Motorista` |
| Backend DTO/response (JS) | camelCase | montado à mão no handler | `backend/server.js` (+ módulos `/motorista`) |
| Frontend DTO (TS) | camelCase | tipos TS em `types/` | `frontend_motorista/types/*.ts` |
| API payload (request/response) | camelCase | shape em `contracts/` | `contracts/motorista-api.md` |
| URL path params | kebab/lowercase | router Express | rotas `/motorista/*` |
| Validação externa (`validade_nfse`) | snake_case (`xml_input`, `valid_*`) | contrato externo | research.md Decision 5 |

**Mapper layer (DB ↔ DTO)**: no backend, dentro dos handlers `/motorista/*`
(snake_case do PostgREST → camelCase da resposta). **ORM auto-mapping: NÃO** — PostgREST
via HTTP (`axios`), mapeamento manual explícito. É o ponto onde o case é convertido —
verificado pelo cenário **Roundtrip R1** do quickstart.

**Validação Zod**: o projeto atual **não** usa Zod (tipos TS manuais). Manter o padrão
existente (tipos TS + checagens manuais) para consistência; não introduzir Zod só nesta
feature. Validação de XML no backend via `xml2js` (parse → rejeita malformado).

## Complexity Tracking

> Sem violações de constituição — nada a justificar.

## Riscos & Pendências (rastreáveis)

- **R-1 (contrato de validação)**: divergência do `xml_input` (brief vs rota existente).
  Mitigação: cenário Roundtrip R2 valida empiricamente antes de fixar o parser.
- **R-2 (provisionamento de Motorista)**: como criar contas de motorista no MVP — a
  confirmar com o solicitante (research.md Decision 3). Não bloqueia consulta+validação.
- **R-3 (DNS/infra)**: criar host `appmotorista.todo-tips.com` → VPS para o Traefik
  emitir TLS. Tarefa de infra fora do código (research.md Decision 7).
