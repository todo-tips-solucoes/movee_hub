# Implementation Plan: Motorista canônico do hub + correções de navegação e filtros

**Feature**: `hub-motorista-canonico` | **Date**: 2026-07-12 | **Spec**: [spec.md](./spec.md)

> Plano-fonte (briefing): [`docs/plans/hub-frota/PLANO-HUB-MOTORISTA-CANONICO-E-CORRECOES.md`](../../plans/hub-frota/PLANO-HUB-MOTORISTA-CANONICO-E-CORRECOES.md).
> Decisões D-A0..D-C7 já fechadas pelo operador — a pipeline NÃO as reabre.

## Summary

Três workstreams entregues em ordem de risco crescente (A → B → C), cada um
independentemente testável:

- **WS-A (navegação, risco baixo)**: corrigir o 404 de "Painel Geral"
  (`moduloParaRota('dashboard')` gera hoje `/hub/dashboard/dashboard`, rota
  inexistente) com um caso especial que aponta para `/hub/dashboard`, ajustar o
  cálculo de item ativo, e mover "Meu perfil" para um modal (Base UI `Dialog`)
  reusando o miolo da página `/hub/dashboard/perfil` (que permanece viva como
  deep-link). — FR-001..FR-005.
- **WS-B (combobox de entregador, risco baixo)**: substituir o input numérico de
  `entregador_id` no faturamento e na performance por um combobox por nome
  (Popover + Command), alimentado por dois endpoints aditivos server-side com
  busca ILIKE sobre `hub_normaliza_nome(nome)`, escopo `id_empresa`, mínimo 3
  caracteres, limite 20, com degradação para o input numérico atual em falha. —
  FR-006..FR-010.
- **WS-C (motorista canônico, risco alto)**: promover a entidade `Entregador` do
  hub a motorista canônico, usando seu `id_externo uuid` (o uuid da planilha)
  como chave de correlação de todas as atividades. Adicionar CRUD de criação
  (uuid informado obrigatório), gestão de credencial de acesso ao app motorista
  (`ContaMotorista.senha` bcrypt + reset), auditoria, e uma seção "Atividades"
  read-only no detalhe. Migrations idempotentes 0042+ **apenas no
  `hub_homolog_db`**; rotas legadas tocadas só de forma aditiva e inerte em
  produção (espírito do `lib/envio-gate.js`). — FR-011..FR-024, FR-022A.

**Abordagem técnica**: reuso máximo de idiomas já existentes no hub
(`moduloParaRota`, `Dialog` Base UI do `motorista-detalhe-dialog`, Popover+Command
do `EntidadeCombobox` do admin, `requirePermission` + `resolverContextoEntidade` +
`registrarAuditoria`, migrations idempotentes via `migrate.sh`). Nenhuma tabela
nova; nenhuma alteração de produção observável.

## Technical Context

**Language/Version**: TypeScript 5.x (frontend Next.js 14 App Router, `frontend_v2`,
standalone `node:20-alpine`); JavaScript/Node — backend Express (hub-homolog roda em
`node:20` via `Dockerfile.hub`; produção legada em `node:14`).
**Primary Dependencies**: Express + PostgREST (acesso a dados por REST, filtros
`entregador_id=eq.N`); React 18 + Base UI (`Dialog`, `Popover`) + `cmdk`/Command;
`bcrypt` (credencial motorista); helpers de projeto `uuidValido`
(`lib/hub-import-normalizer.js:233`), `termoBuscaValido`
(`lib/hub-motoristas-similaridade.js:90`), `hub_normaliza_nome()` (SQL, migration 0021).
**Storage**: PostgreSQL `hub_homolog_db` acessado via PostgREST; migrations
idempotentes em `infra/hub/migrations/` (última = `0041`; novas = **0042+**). Extensões
`unaccent` + `pg_trgm` e índice trgm já presentes (0021).
**Testing**: `vitest` (frontend), `node --test` (backend), E2E no hub-homolog com
rebuild sob rito anti-starvation.
**Target Platform**: Docker compose hub-homolog no VPSTodo — **somente** recursos
`hub-*` (exceção standing G1). `migrate.sh -f infra/hub/compose.hub.homolog.yml`.
**Project Type**: web (frontend `app_homologacao/frontend_v2` + backend
`app_homologacao/backend`).
**Performance Goals**: busca de entregador por nome retorna em < 3 s após parar de
digitar (SC-003); combobox com debounce 300 ms, limite 20 resultados; histórico de
atividades com paginação técnica (sem limite fixo de período/quantidade — FR-022).
**Constraints**: produção (chatmasterveloz, app motorista em produção) **byte-a-byte
inalterada** (FR-023/SC-007); DDL só em `hub_homolog_db` via migrations idempotentes;
rotas legadas (`routes/motorista.js`, `server.js`) apenas aditivas e inertes em
produção (sem env nova = comportamento idêntico).
**Scale/Scope**: 3 workstreams, 6 User Stories (P1..P5), 25 Functional Requirements.

## Constitution Check

*GATE: Deve passar antes do Phase 0. Re-checar após Phase 1.*

| Princípio | Status | Notas |
|-----------|--------|-------|
| I. Segurança de Autenticação & Segredos (NON-NEGOTIABLE) | PASS | Credencial do motorista é `bcrypt` (nunca texto plano); reset por token, espelhando o legado. Senha anterior invalida imediatamente após reset (FR-019). Token do app motorista reusa o padrão de sessão/JWT já existente (spec §Decisões de infraestrutura); `entregador_uuid` embutido no login é dado de correlação, não segredo. Nenhum segredo novo em `.env` de serviço Swarm de produção. |
| II. Isolamento Multi-Tenant por Empresa (NON-NEGOTIABLE) | PASS | Todo endpoint novo escopa por `id_empresa` via `resolverContextoEntidade`; uuid é único **por empresa**, não global (FR-013, edge case). Busca de entregador retorna só entregadores da empresa do usuário (FR-007). Leitura (lista/detalhe/atividades) escopada à empresa; 404-fora-do-escopo (padrão Decision 11 do S5). |
| III. Contratos de API & Proxy de Cookies | PASS | Endpoints novos são aditivos, seguem o padrão PostgREST + auth por cookie `accessToken` já usado no hub; contratos documentados em `contracts/`. DTOs versionados via `mapMotoristaListItem`/`mapMotoristaDetalhe`. |
| IV. Qualidade e Revisão de Mudanças | PASS | Cada fase fecha com `tsc --noEmit` + `eslint` + `vitest run` (front) + `node --test` (backend) verdes e review-task; ao final, `/code-review` nível alto sobre o diff acumulado antes de PR. review-task **nunca** em haiku. |
| V. Deploy Conteinerizado e Convivência de Serviços (NON-NEGOTIABLE) | PASS | Somente recursos `hub-*`; migrations só no `hub_homolog_db` via `migrate.sh` (registra `SchemaMigration` + SIGUSR1 ao PostgREST); rebuild sob rito anti-starvation; limpeza docker sempre com filtro `hub_*`. Produção intocada; commit/push/PR só com autorização. |

**Resultado**: PASS em todos os 5 princípios. Nenhuma violação → `Complexity Tracking`
não é preenchido (ver abaixo).

## Project Structure

### Documentation (this feature)

```
docs/specs/hub-motorista-canonico/
├── spec.md            # Spec clarificada (6 US, 25 FR + Clarifications 2026-07-12)
├── plan.md            # This file
├── research.md        # Phase 0 output — decisões técnicas ancoradas no código
├── data-model.md      # Phase 1 output — entidades + migrations 0042+
├── quickstart.md      # Phase 1 output — cenários E2E por workstream
└── contracts/
    └── api-motorista-canonico.md   # Phase 1 output — endpoints aditivos
```

### Source Code (repository root)

> A base de código do app vive sob `app_homologacao/`; as migrations do hub vivem
> na raiz do repo em `infra/hub/`. Os anchors do plano-fonte (§7) omitem o prefixo
> `app_homologacao/` — aqui usamos os paths reais do repositório.

```
app_homologacao/
├── frontend_v2/                      # Next.js 14 App Router (TypeScript)
│   ├── lib/hub/module-nav.ts         # WS-A: moduloParaRota() (caso especial 'dashboard')
│   ├── components/hub/
│   │   ├── account-menu.tsx          # WS-A: "Meu perfil" abre modal
│   │   ├── module-nav.tsx            # WS-A: item ativo do nav
│   │   ├── motorista-detalhe-dialog.tsx   # idioma Dialog Base UI (reuso)
│   │   ├── perfil-dialog.tsx         # WS-A: NOVO (usePerfilDialog + Dialog)
│   │   └── entregador-combobox.tsx   # WS-B: NOVO (Popover+Command, debounce 300ms)
│   └── app/hub/dashboard/
│       ├── page.tsx                  # WS-A: card "Painel Geral" da home
│       ├── perfil/page.tsx           # WS-A: renderiza o mesmo miolo (PerfilCard)
│       ├── faturamento/page.tsx      # WS-B: input id → EntregadorCombobox
│       ├── performance/page.tsx      # WS-B: espelho do combobox
│       └── motoristas/page.tsx       # WS-C: criar + credencial + uuid + atividades
├── backend/                          # Express + PostgREST
│   ├── routes/
│   │   ├── hub-faturamento.js        # WS-B: GET /entregadores (aditivo)
│   │   ├── hub-performance.js        # WS-B: GET /entregadores (aditivo)
│   │   ├── hub-motoristas.js         # WS-C: POST /, POST /:id/credencial[...]
│   │   └── motorista.js              # WS-C: login embute entregador_uuid (aditivo/inerte)
│   ├── middleware/hub-require-permission.js   # requirePermission (reuso)
│   └── lib/
│       ├── hub-auditoria.js          # registrarAuditoria (reuso)
│       ├── hub-import-normalizer.js  # uuidValido (reuso, :233)
│       ├── hub-motoristas-similaridade.js     # termoBuscaValido (reuso, :90)
│       ├── envio-gate.js             # template do padrão env-inerte (referência D-C3)
│       └── hub-motoristas-dto.js*    # mapMotoristaListItem/Detalhe/validarPatchMotorista
└── server.js                         # WS-C: gravação de atividade com uuid (aditivo/inerte)

infra/hub/
├── migrations/                       # última = 0041; novas = 0042+
│   ├── 0042_conta_motorista_senha.sql       # WS-C: ContaMotorista.senha bcrypt (D-C5)
│   └── 0043_seed_permissao_motoristas_credencial.sql  # WS-C: nova permissão (D-C1)
└── scripts/migrate.sh                # aplica no hub_homolog_db, SIGUSR1 ao PostgREST
```
> `*` nome do arquivo de DTO a confirmar no Phase 0 (o `require` está em
> `hub-motoristas.js:46-48`).

**Structure Decision**: projeto web já estabelecido — **não** se cria estrutura
nova. Cada workstream toca um subconjunto disjunto de arquivos existentes + poucos
arquivos novos (`perfil-dialog.tsx`, `entregador-combobox.tsx`, migrations 0042/0043),
o que permite entregar e revisar A, B e C de forma independente (ordem obrigatória
A → B → C por risco crescente, não por dependência técnica de A/B em C).

## Complexity Tracking

> Não aplicável: Constitution Check passou sem violações. Reuso de tabelas,
> permissões e idiomas existentes; nenhuma tabela nova; nenhum serviço novo.

## Fases de execução (resumo — detalhe em tasks na próxima etapa)

| Fase | Entregável | Gate de fechamento |
|------|-----------|--------------------|
| A | `moduloParaRota` caso especial + item ativo + card home; `perfil-dialog.tsx` + AccountMenu modal; rota `/perfil` reusa miolo | unit `module-nav` + render nav/home; teste abrir/trocar-senha/fechar modal; smoke sidebar→200 + avatar→modal |
| B | 2 endpoints `GET /entregadores` (≥3 chars, escopo empresa, limite 20); `EntregadorCombobox` nas 2 telas; degradação p/ input numérico | testes DTO/rota; vitest combobox (estados <3, carregando, vazio, erro); smoke buscar→selecionar→filtra |
| C | Migrations 0042/0043; `idExterno` em DTOs; `POST /motoristas` (uuid obrigatório, 409 dup); rotas de credencial; login app embute uuid (inerte prod); front criar/credencial/uuid/atividades | unit backend (dto/validação/uuid/409); vitest front; E2E hub-homolog (criar→credencial→login mock→atividade correlacionada por uuid→detalhe); produção byte-a-byte inalterada |

Encerramento de cada fase: `tsc --noEmit` + `eslint` + testes verdes; rebuild
hub-homolog (`DOCKER_BUILDKIT=0 … --memory=2g`, swap conferido) e smoke autenticado;
migrations via `migrate.sh`. Commit local na branch `feat/hub-motorista-canonico`;
push/PR só com autorização.
