# Implementation Plan: Envio em Massa como Módulo do Hub

**Feature**: `hub-envio-massa` | **Date**: 2026-07-09 | **Spec**: [spec.md](./spec.md)

## Summary

Re-hospedar o fluxo legado de envio em massa (upload XLSX → processamento →
validação de nota fiscal em lote → edição → fechamento → exportação) dentro do
shell do hub, **sem alterar seu comportamento observável**, colocando
autenticação-ponte e permissões novas na frente dos 11 endpoints legados
existentes. A abordagem técnica (Phase 0, `research.md`) usa três achados
estruturais para minimizar o diff: (1) o cookie `accessToken` já é compartilhado
entre os dois formatos de token (legado `{empresaId,...}` e hub
`{sub,email,entidade_ativa}`), permitindo um único middleware "adaptador de
claims" traduzir hub→legado sem tocar `authenticateToken`; (2) o módulo
`envio_massa` e suas 4 permissões operacionais (`consultar/criar/enviar/aprovar`)
já estão seedados desde S2 (`0007`), e o campo `tipo='envio_massa'` já é aceito
pelo `CHECK` de `ImportacaoArquivo` desde S2/S4 — só falta uma migration pequena
para o 5º nível de permissão (`administrar`) exigido por FR-005; (3) a rota do
módulo no frontend não exige nenhum código novo de roteamento —
`lib/hub/module-nav.ts` já resolve qualquer módulo devolvido por `GET /me` para
`/hub/dashboard/<codigo>` automaticamente.

## Technical Context

**Language/Version**: Node.js 14 (`app_homologacao/backend`, Express) + Node.js
20 (libs `hub-*`, mesmo processo); TypeScript/Next.js App Router
(`app_homologacao/frontend_v2`).
**Primary Dependencies**: Express 4, `jsonwebtoken`, `multer`, PostgREST (via
`fetch`), Next.js, React.
**Storage**: PostgreSQL via PostgREST (`POSTGREST_URL` compartilhada entre
tabelas legadas e tabelas do hub).
**Testing**: `node --test` (unit/integration backend); scripts bash E2E contra
`hub-homolog`.
**Target Platform**: recursos isolados `hub-*` no host VPSTodo (exceção
escopada G1) — nada deployado no ambiente vivo do cliente nesta fase.
**Project Type**: web-service (Express) + web-app (Next.js), monorepo único.
**Performance Goals**: N/A — paridade comportamental com o legado, não
performance nova (SC-001/SC-002).
**Constraints**: diff mínimo nos 11 endpoints legados (FR-015); zero alteração
de schema de `EnvioMassa`/`ProcessControl`; zero envio real fora do ambiente
isolado (SC-006, já garantido pela infra S1).
**Scale/Scope**: 11 endpoints ganham 2 middlewares cada; 1 migration
(`0032`); 1 diretório de página novo no frontend (`app/hub/dashboard/envio_massa/`),
reaproveitando 100% dos componentes/hooks já existentes.

## Constitution Check

*GATE: Deve passar antes do Phase 0. Re-checar apos Phase 1.*

| Princípio | Status | Notas |
|-----------|--------|-------|
| I. Segurança de Autenticação & Segredos | PASS | O adaptador de claims (research.md Decision 2) não introduz novo mecanismo de token — reusa o JWT httpOnly já assinado com `JWT_SECRET`. Nenhum segredo novo; `HUB_RBAC_ENVIO`/`HUB_IMPORT_LOG_ENVIO` são flags booleanas, não segredos. |
| II. Isolamento Multi-Tenant por Empresa | PASS | `req.user.empresaId` continua sendo a ÚNICA fonte de escopo para as queries legadas — o adaptador só o preenche a partir de `entidade_ativa` da sessão (nunca do corpo/query). `resolveEmpresaAlvo`/`mesmoGrupoQue` permanecem intocados e continuam validando server-side qualquer `empresa_id` de query (research.md Decision 8). |
| III. Contratos de API & Proxy de Cookies | PASS | O frontend do módulo reaproveita os mesmos hooks (`use-envio-massa`, `use-process-status`) que já falam com o backend via o proxy `/api/*` existente — nenhuma chamada cross-site nova. |
| IV. Qualidade e Revisão de Mudanças | PASS | Trabalho em branch dedicada; mudança toca autenticação/permissão diretamente — **revisão de segurança OWASP Top 10 é MUST** aqui, não SHOULD-opcional. Gate `owasp-security` rodou nesta onda (onda-003) sobre o adaptador de claims + gate de RBAC: 3 achados (F1 MEDIUM — ordem de discriminação de ramo, corrigido no próprio design, ver research.md Decision 2; F2 INFORMATIVO — janela residual de 15min em `entidade_ativa`, risco aceito/pré-existente no modelo de sessão do hub, ver Decision 6; F3 MEDIUM — cobertura de middleware nas 11 rotas, incorporado como requisito de teste explícito, ver Decision 11), nenhum CRITICAL/HIGH — sem necessidade de bloqueio humano. |
| V. Deploy Conteinerizado e Convivência de Serviços | PASS | Todo o trabalho acontece nos recursos `hub-*` isolados (compose próprio, S1); nada é deployado nos serviços de produção (`envio-massa-homologacao_*`) nesta fase — consistente com o rito de produção do CLAUDE.md e a exceção standing G1. |

## Project Structure

### Documentation (this feature)

```
docs/specs/hub-envio-massa/
├── spec.md
├── plan.md                          # This file
├── research.md                      # Phase 0 output
├── data-model.md                    # Phase 1 output
├── quickstart.md                    # Phase 1 output
└── contracts/
    ├── claims-adapter.md            # Phase 1 output
    └── legacy-endpoints.md          # Phase 1 output
```

### Source Code (repository root)

```
app_homologacao/
├── backend/
│   ├── server.js                     # TOCADO: insere 2 middlewares novos na
│   │                                  # cadeia de cada uma das 11 rotas +
│   │                                  # 1 chamada ao log de importação em
│   │                                  # POST /upload — diff mínimo (FR-015)
│   ├── middleware/
│   │   ├── hub-require-permission.js # existente, intocado (RBAC genérico do hub)
│   │   ├── hub-envio-massa-claims.js       # NOVO (research.md Decision 2)
│   │   └── hub-envio-massa-permission.js   # NOVO (research.md Decision 3/5/6)
│   ├── lib/
│   │   ├── hub-postgrest.js          # existente, intocado (reusado pelo adaptador)
│   │   └── hub-envio-massa-import-log.js   # NOVO (research.md Decision 9)
│   └── tests/
│       ├── hub-envio-massa-claims-unit.test.js       # NOVO
│       └── hub-envio-massa-permission-unit.test.js   # NOVO
│
└── frontend_v2/
    └── app/
        └── hub/
            └── dashboard/
                └── envio_massa/
                    └── page.tsx       # NOVO — monta os componentes JÁ
                                        # EXISTENTES (import-button,
                                        # process-controls,
                                        # xml-validation-card, stats-cards,
                                        # action-bar, filters, data-table,
                                        # pagination-controls) dentro do
                                        # layout do shell `/hub/`; trata
                                        # SEM_ENTIDADE_ATIVA -> redirect

infra/hub/migrations/
└── 0032_seed_permissao_envio_massa_gerenciar.sql   # NOVO (research.md Decision 4)

docs/specs/hub-envio-massa/
└── evidencias/
    └── diff-endpoints-legados.txt    # NOVO — evidência FR-015 (Q2/dec-009):
                                        # `git diff --name-only` + diff completo
                                        # de server.js, revisado linha a linha
```

**Structure Decision**: nenhum diretório novo de "módulo" no backend (ex.: um
`modules/envio-massa/` isolado) — os 11 endpoints continuam vivendo em
`server.js` exatamente onde estão hoje (FR-015 exige middleware/adaptador, não
reorganização de arquivo). Todo código novo do backend é aditivo em
`middleware/` e `lib/`, seguindo a convenção já estabelecida por
`hub-require-permission.js`/`hub-rbac-cache.js`. No frontend, um único diretório
de página novo (`app/hub/dashboard/envio_massa/`) — a convenção
`moduloParaRota(codigo)` já existente resolve a navegação sem tocar
`lib/hub/module-nav.ts` (research.md Decision 7).

## Convenções de Borda

| Camada | Case style | Validação | Fonte da verdade |
|--------|------------|-----------|-------------------|
| Erros novos desta feature (`error.code`) | UPPER_SNAKE_CASE | vocabulário fechado, 4 valores | `contracts/claims-adapter.md` |
| Payloads dos 11 endpoints legados (request/response) | inalterado (o legado já usa nomes mistos, ex.: `mov_fechado`) | inalterado | código-fonte de `server.js` (não redocumentado — FR-015 proíbe alterá-lo) |
| `ImportacaoArquivo` (colunas DB) | snake_case | `CHECK` constraints já existentes | `infra/hub/migrations/0011_importacao_arquivo.sql` |
| `req.user`/`req.hubContext` (contrato de runtime, não serializado) | camelCase | shape validado por testes unit | `data-model.md §req.user / req.hubContext` |

**Mapper layer**: não há mapeamento DB↔DTO novo — o log de importação
(`lib/hub-envio-massa-import-log.js`) grava diretamente nos nomes de coluna
snake_case de `ImportacaoArquivo` via `hubPostgrestRequest` (sem ORM).

**Validação**: nenhuma validação Zod nova — os 11 endpoints legados mantêm sua
validação de entrada já existente (inalterada); os dois middlewares novos não
recebem payload de negócio, só leem `req.user`/`req.cookies`.

## Complexity Tracking

Nenhuma violação de constitution identificada — tabela vazia por design.

| Violação | Por Que Necessário | Alternativa Simples Rejeitada Porque |
|----------|---------------------|----------------------------------------|
| — | — | — |
