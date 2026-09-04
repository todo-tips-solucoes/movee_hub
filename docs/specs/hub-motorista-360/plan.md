# Implementation Plan: Hub Motorista 360

**Feature**: `hub-motorista-360` | **Date**: 2026-09-04 | **Spec**: [spec.md](./spec.md)

## Summary

Três frentes sobre a tela de detalhe do motorista no hub
(`app/hub/dashboard/motoristas/[id]/page.tsx`): (1) enriquecer com dados
pessoais/documentos/contato de emergência/informações de entrega vindos da
plataforma EntreGô, sob demanda por motorista e com uma rotina semestral de
atualização; (2) exibir o CNPJ hoje só disponível no legado; (3) vincular
automaticamente, sem ação do gestor, a credencial criada pelo motorista no
app do motorista ao `Entregador` correspondente do hub — retroativamente
para os cadastros já existentes (backfill único) e dali para frente.

Abordagem técnica (Phase 0, `research.md`): o hook de vínculo automático
roda **in-process** dentro do handler já existente `POST /motorista/register`
(mesma instância PostgREST que o hub, sem integração de rede nova); o
casamento de identidade é por **similaridade de nome** via uma RPC SQL nova
simétrica à já existente `hub_motoristas_candidatos` (migration 0023), com
threshold mais estrito (>= 0.9, único candidato) do que o piso de sugestão
humana (0.3) — nunca por CNPJ, porque `Entregador` não tem essa coluna. O
CNPJ exibido (FR-008) não exige migração nova: já está espelhado em
`ContaMotorista.cnpj_prestador` no momento do vínculo. A raspagem EntreGô
(sob demanda e semestral) roda em processos separados dentro de
`infra/robo-entrego/` (onde o Playwright já está instalado e a
sessão/backoff/antibot já existem), consumindo uma fila curta gravada em
duas colunas novas de `Entregador`; o endpoint do BFF para os dados de
cadastro da pessoa entregadora não está documentado em
`ACHADOS-PORTAL.md` e fica `[PROPOSTA — a validar na implementação]`, com
os XPaths do briefing como fallback declarado. Acesso aos campos pessoais
sensíveis é restrito por uma permissão RBAC nova (`motoristas.dados_sensiveis`,
mesmo padrão de `motoristas.credencial`), aplicada como máscara de campo no
DTO — a rota continua acessível a `leitura`.

## Technical Context

**Language/Version**: Node.js 20 LTS (backend, `Dockerfile.hub`: "Node 20
LTS... TAMBÉM o build de PRODUÇÃO"), TypeScript/Next.js App Router
(frontend_v2)
**Primary Dependencies**: Express 4.17 (`package.json`), `axios`, `bcrypt`
(backend); Next.js + Base UI (`@base-ui/react`, não Radix) + Tailwind 4
(frontend_v2); Playwright 1.45 (`infra/robo-entrego/package.json`, **não**
instalado no backend — Decision 6 de `research.md`)
**Storage**: PostgreSQL via **PostgREST** (sem ORM, `lib/hub-postgrest.js` /
`lib/hub-postgrest-jwt.js`) — hub e legado compartilham a mesma instância
`POSTGREST_URL` em produção (`chatmasterveloz`); ambiente isolado de teste
`hub_homolog_db`
**Testing**: `node --test` (backend, `npm test` / `npm run test:hub:unit`);
`vitest` (frontend_v2); E2E do hub via Playwright dentro do driver
`infra/hub/testes/hub-shell-e2e-browser.sh`
**Target Platform**: Docker Swarm sob Traefik (VPSTodo) — CLAUDE.md;
`infra/robo-entrego/` roda como `systemd` timer+service no mesmo host, fora
do Swarm
**Project Type**: web-service (backend Express + frontend Next.js) + worker
batch (`infra/robo-entrego/`, Node standalone com Playwright)
**Performance Goals**: sem meta numérica pedida pelo operador; busca sob
demanda tem latência de minutos (fila + timer, não tempo real — FR-005 já
clarificado como "sob demanda, um motorista por vez")
**Constraints**: rito de produção do CLAUDE.md (esta pipeline nunca aplica
DDL/deploy em produção — todo artefato de banco é entregue para o operador
aplicar); dados pessoais sensíveis sujeitos a OWASP/RBAC (gate
`owasp-security` obrigatório após este plano); sem credencial nova para a
EntreGô (reusa sessão persistida do robô já existente)
**Scale/Scope**: escopo observado no domínio já existente — motoristas do
grupo Movee (`EmpresaGrupoMovee`, migration 0023) para as frentes de
credencial/EntreGô; CNPJ (FR-008) não tem essa restrição de grupo

## Constitution Check

*GATE: Deve passar antes do Phase 0. Re-checar após Phase 1.*

| Princípio | Status | Notas |
|-----------|--------|-------|
| I. Segurança de Autenticação & Segredos | PASS | Nenhuma credencial nova (reusa sessão EntreGô já persistida em `/var/lib/hub_secrets/robo-entrego/`, chmod 600, e o usuário de serviço `robo_entrego_servico` já provisionado); senhas continuam bcrypt; nenhum segredo novo em código |
| II. Isolamento Multi-Tenant por Empresa | PASS | Novas RPCs/queries seguem o mesmo padrão RLS + `EmpresaGrupoMovee` já usado em 0023; `id_empresa` sempre do token, nunca do corpo |
| III. Contratos de API & Proxy de Cookies | PASS | Nenhum endpoint novo é chamado direto do browser fora do proxy `/api/*` já existente do frontend_v2; rotas novas do robô (`hub-robo-entrego.js`) usam o padrão de service account já estabelecido |
| IV. Qualidade e Revisão de Mudanças | PASS | Branch dedicada já em uso (`feature/hub-motorista-360`); commits Conventional Commits (`atomic_commit_enabled=true`); gate `owasp-security` obrigatório dado o volume de dados pessoais sensíveis (CPF, RG, nomes dos pais, contato de emergência) — MUST rodar antes de `create-tasks` |
| V. Deploy Conteinerizado e Convivência de Serviços | PASS (com nota) | Os 2 novos `systemd` timers propostos (`entrego-enriquecimento` sob-demanda + semestral) seguem o MESMO padrão já em produção do robô EntreGô (`robo-entrego.timer`, fora do Swarm) — aditivo, não disputa porta/container existente. Nenhuma nova instalação exige rito de produção além do já coberto por CLAUDE.md (aplicação fica com o operador) |

Nenhuma violação de princípio MUST identificado no design. Ver
`research.md` Decision 4 para o esclarecimento de que a nota "sem
sincronização ao vivo com Motorista" da migration 0021 é um invariante do
ambiente de teste isolado, não da produção — logo não é uma violação de
constitution reabrir esse caminho em produção (onde hub e legado já
compartilham a mesma instância PostgREST).

## Project Structure

### Documentation (this feature)

```
docs/specs/hub-motorista-360/
├── spec.md
├── plan.md          # This file
├── research.md      # Phase 0 output
├── data-model.md     # Phase 1 output
├── quickstart.md     # Phase 1 output
└── contracts/
    ├── hub-motoristas-detalhe.md
    ├── entrego-enriquecimento.md
    └── vinculo-automatico.md
```

### Source Code (repository root — paths reais, verificados nesta sessão)

```
app_homologacao/backend/
├── routes/
│   ├── motorista.js            # extensão: hook automático pós-/register (FR-009)
│   ├── hub-motoristas.js       # extensão: GET /:id (CNPJ+EntreGô+RBAC), POST /:id/entrego-enriquecimento [novo]
│   └── hub-robo-entrego.js     # extensão: GET/PATCH fila de enriquecimento [novo]
├── lib/
│   ├── hub-postgrest.js        # reusado, sem alteração de assinatura
│   ├── hub-motoristas-dto.js   # extensão: mapeamento dos campos novos do DTO
│   └── hub-motoristas-similaridade.js  # extensão: wrapper da RPC nova (candidatos_por_conta)
├── middleware/hub-require-permission.js  # reusado, sem alteração
└── scripts/                    # [novo] script de backfill retroativo (FR-012)

infra/hub/migrations/
├── 00NN_entregador_entrego_enriquecimento.sql  # [novo] 3 colunas em Entregador
├── 00NN_seed_permissao_motoristas_dados_sensiveis.sql  # [novo] seed RBAC (padrão 0044)
└── 00NN_rpc_motoristas_candidatos_por_conta.sql  # [novo] RPC simétrica à 0023

infra/robo-entrego/
├── src/
│   └── enriquecimento-entrego.js  # [novo] módulo de busca EntreGô (sob demanda + semestral), reusa entrego-portal.js/taxonomia-erro.js
├── scripts/gerar-timer.sh          # reusado (gera os 2 timers novos a partir de config novo)
├── entrego-enriquecimento-sob-demanda.timer/.service   # [novo]
├── entrego-enriquecimento-semestral.timer/.service     # [novo]
└── sql/00N-permissoes-enriquecimento-robo-entrego.sql  # [novo] artefato p/ operador aplicar (mesmo padrão de 001)

app_homologacao/frontend_v2/app/hub/dashboard/motoristas/[id]/
└── page.tsx                    # extensão: seções novas (Dados pessoais, Documentos, Contato de emergência, Informações de entrega, CNPJ), botão "Buscar dados EntreGô"
```

**Structure Decision**: nenhum diretório/serviço novo no Swarm — tudo é
extensão de arquivos/rotas já existentes ou artefatos novos dentro de
diretórios já existentes (`infra/hub/migrations/`, `infra/robo-entrego/`).
Único par de `systemd` timers novo é aditivo ao host, mesmo padrão já em
produção do robô EntreGô — não introduz um 4º serviço conteinerizado.

## Convenções de Borda

| Camada | Case style | Validação | Fonte da verdade |
|--------|------------|-----------|-------------------|
| DB columns (PostgreSQL) | snake_case | migration + constraint | `infra/hub/migrations/*.sql` |
| Backend DTO (Node/Express) | camelCase | mapeamento manual em `lib/hub-motoristas-dto.js` (já é o padrão existente — ex.: `cnpjPrestadorMascarado`, `idExterno`) | `lib/hub-motoristas-dto.js` |
| Frontend DTO (TS) | camelCase | tipagem TS na própria `page.tsx` (o projeto não usa Zod nas páginas do hub hoje — verificar em `execute-task` se introduzir validação de borda vale a pena para esta feature) | `app/hub/dashboard/motoristas/[id]/page.tsx` |
| API payload (request/response) | camelCase | manual (sem schema compartilhado hoje) | `contracts/*.md` |
| URL query/path params | kebab-case / REST simples | Express router | `routes/hub-motoristas.js`, `routes/hub-robo-entrego.js` |

**Mapper layer (DB ↔ DTO)**: `lib/hub-motoristas-dto.js` (já existente,
função `buscarDetalheMotorista` monta o objeto manualmente — sem ORM,
sem auto-mapping). Extensão desta feature segue o MESMO arquivo/padrão.

**Validação**: nenhuma lib de schema (Zod) em uso hoje nas rotas do hub —
validação de corpo é manual por função (`validarCriacaoMotorista`,
`validarCriacaoCredencialBody`, mesmo padrão para os corpos novos desta
feature, ex.: `validarPatchEnriquecimento`).

## Complexity Tracking

Nenhuma violação de constitution identificada — tabela vazia por desenho.

| Violação | Por Que Necessário | Alternativa Simples Rejeitada Porque |
|----------|---------------------|----------------------------------------|
| — | — | — |

## Re-check pós Phase 1

- Nenhuma complexidade não justificada foi introduzida no design (Phase 1
  reusa mecanismos já existentes em 4 das 5 decisões arquiteturais
  principais: PostgREST compartilhado, RPC de similaridade, worker
  Playwright já existente, service account já provisionado).
- Único componente genuinamente novo é o par de `systemd` timers — mesmo
  padrão operacional já em produção (`robo-entrego.timer`), não um serviço
  de categoria nova.
- Gate `owasp-security` **obrigatório** na próxima etapa do orquestrador
  (dados pessoais sensíveis: CPF, RG, nomes dos pais, e-mail, contato de
  emergência + integração externa com sessão persistida) — não pular.

## Artefatos

| Arquivo | Status |
|---------|--------|
| docs/specs/hub-motorista-360/plan.md | Criado |
| docs/specs/hub-motorista-360/research.md | Criado |
| docs/specs/hub-motorista-360/data-model.md | Criado |
| docs/specs/hub-motorista-360/contracts/hub-motoristas-detalhe.md | Criado |
| docs/specs/hub-motorista-360/contracts/entrego-enriquecimento.md | Criado |
| docs/specs/hub-motorista-360/contracts/vinculo-automatico.md | Criado |
| docs/specs/hub-motorista-360/quickstart.md | Criado |

## Plano Criado

**Feature**: hub-motorista-360
**Diretório**: docs/specs/hub-motorista-360/
**Artefatos**: 7 arquivos gerados
**Constitution**: PASS (5/5 princípios, ver tabela acima)
**NEEDS CLARIFICATION restantes**: 0 (todo unknown técnico resolvido em
`research.md` ou marcado `[PROPOSTA — a validar na implementação]` onde a
fonte real não existe — Constitution VI)

### Próximos Passos

1. `owasp-security` (gate obrigatório desta etapa do orquestrador, dados
   pessoais sensíveis) — deve rodar ANTES de `checklist`/`create-tasks`.
2. `/checklist` — gerar quality gate antes de implementar.
3. `/create-tasks` — decompor este plano em backlog executável (inclui
   resolver o `[PROPOSTA]` do endpoint EntreGô contra `ACHADOS-PORTAL.md`
   ou empiricamente, e confirmar/ajustar o threshold de similaridade 0.9).
