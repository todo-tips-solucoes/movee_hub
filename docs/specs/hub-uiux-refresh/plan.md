# Implementation Plan: Refresh de UI/UX do Hub de Frota

**Feature**: `hub-uiux-refresh` | **Date**: 2026-08-05 | **Spec**: [spec.md](./spec.md)

## Summary

Refinamento puramente visual das telas autenticadas do hub de frota
(`app_homologacao/frontend_v2/app/hub/dashboard/**`): sidebar colapsável com
persistência local, theme toggle exposto na topbar do hub, superfícies mais
leves em cards/tabelas e dois componentes compartilhados novos (indicador
numérico e área de busca/filtros) para consistência entre telas. Nenhum
comportamento funcional, contrato de API ou dado exibido muda — só aparência
(FR-018).

A investigação do código existente (não do zero) mostrou que boa parte da
infraestrutura já existe e só precisa ser **reaproveitada**, não recriada:

- `next-themes` (`^0.4.6`) já provê o `ThemeProvider` (`app/layout.tsx:44`,
  `attribute="class" defaultTheme="dark" enableSystem={false}`) para o app
  inteiro, incluindo o hub. `components/theme-toggle.tsx` já existe e já é
  usado em `/login`, `/register` e `components/hub/auth-shell.tsx` — falta
  apenas **montá-lo** no header do hub autenticado
  (`app/hub/dashboard/layout.tsx`), que hoje só tem `EntitySwitcher` +
  `AccountMenu`.
- `components/hub/status-badge.tsx` já implementa o padrão único de badge
  (cor + ícone + texto) exigido por FR-016 e já é reusado em importações,
  motoristas e atividades — **nenhuma mudança necessária** aqui.
- `components/ui/tooltip.tsx` (Base UI) já existe para a dica dos itens
  colapsados (FR-002).
- `components/hub/module-nav.tsx` tem a sidebar fixa (`nav` com `w-60`,
  `lg:flex`) mas **sem** estado de colapso — é o único ponto que precisa de
  lógica nova (estado + persistência).
- `components/ui/card.tsx` (`ring-1 ring-foreground/10`) e
  `components/ui/table.tsx` (`border-b` default) são a base compartilhada de
  TODAS as telas — ajustar aqui (nível de token, não por página) satisfaz
  FR-011/012/013/017 em uma única mudança, cobrindo as telas de US5
  automaticamente.
- Não existe hoje um componente compartilhado de indicador numérico (KPI)
  nem de área de busca/filtros — cada tela (`page.tsx` de dashboard,
  performance, faturamento, usuários, motoristas) resolve isso ad hoc.
  FR-014/FR-015 exigem criar esses dois componentes novos e migrar as telas
  existentes para usá-los.

## Technical Context

**Language/Version**: TypeScript 5.x, Next.js 16.2.3 (App Router)
**Primary Dependencies**: React 19.2.4, `next-themes` 0.4.6, `@base-ui/react`
1.3.0 (Tooltip/Sheet/Select — **não** Radix), Tailwind CSS 4, `lucide-react`
1.8.0
**Storage**: `localStorage` (preferências de UI puramente client-side —
colapso da sidebar e tema); nenhuma tabela/coluna nova no PostgREST
**Testing**: `vitest` (jsdom) para componentes/hooks; Playwright via drivers
`infra/hub/testes/*.sh` (`hub-shell-e2e-browser.sh`) para E2E do hub,
sempre dentro do container oficial `mcr.microsoft.com/playwright`
**Target Platform**: Next.js standalone (mesmo container Docker do hub já em
produção — nenhum serviço novo)
**Project Type**: web — frontend-only (Next.js App Router), sem mudança de
backend
**Performance Goals**: transição de colapso/tema perceptível como "instantânea"
(sem jank); nenhum orçamento de performance novo além do já existente
**Constraints**: WCAG contraste mínimo (SC-003) nos dois temas; respeitar
`prefers-reduced-motion` nas transições (edge case da spec); zero regressão
funcional (FR-018/SC-007)
**Scale/Scope**: ~13 telas autenticadas do hub (dashboard, performance,
faturamento, motoristas + detalhe, importações + detalhe, usuários,
auditoria, admin, perfil) + diálogos/assistentes embutidos

## Constitution Check

*GATE: Deve passar antes do Phase 0. Re-checar apos Phase 1.*

| Principio | Status | Notas |
|-----------|--------|-------|
| I. Segurança de Autenticação & Segredos | N/A | Preferência de UI (colapso/tema) em `localStorage` **não é token de autenticação** — o princípio proíbe JWT em localStorage, não preferências de aparência. Nenhum cookie/token é tocado por esta feature. |
| II. Isolamento Multi-Tenant por Empresa | N/A | Nenhuma query, escopo de dados ou `empresaId` é alterado — mudança é só de apresentação. |
| III. Contratos de API & Proxy de Cookies | N/A | Nenhum endpoint novo, alterado ou chamado diretamente — a navegação já é 100% data-driven via `GET /me` (`useHubAuth().modulos`), inalterado. |
| IV. Qualidade e Revisão de Mudanças | PASS | Trabalho em branch dedicada (`feature/hub-uiux-refresh`), commits Conventional Commits, PR pequeno e focado — aplicado nas fases de execução. |
| V. Deploy Conteinerizado e Convivência de Serviços | PASS | Nenhum serviço/porta novo; mesmo container Next.js standalone já em produção. |

## Project Structure

### Documentation (this feature)

```
docs/specs/hub-uiux-refresh/
├── spec.md
├── plan.md          # This file
├── research.md      # Phase 0 output
├── data-model.md    # Phase 1 output
├── quickstart.md     # Phase 1 output
└── contracts/        # N/A — ver nota abaixo (sem contrato de API novo)

docs/plans/hub-uiux-refresh/
├── BRIEFING.md
└── screenshots/      # evidência antes/depois (Q5, versionada no branch local)
```

### Source Code (repository root)

```
app_homologacao/frontend_v2/
├── app/hub/dashboard/
│   ├── layout.tsx              # header do hub — MONTAR <ThemeToggle /> aqui
│   ├── page.tsx                # dashboard (cards KPI) — migrar p/ kpi-card
│   ├── performance/page.tsx    # tabela + KPIs — migrar p/ kpi-card + filter-bar
│   ├── faturamento/page.tsx    # KPIs + badges
│   ├── motoristas/page.tsx     # tabela + busca/filtros — migrar p/ filter-bar
│   ├── motoristas/[id]/page.tsx
│   ├── importacoes/page.tsx    # tabela + busca/filtros
│   ├── importacoes/[id]/page.tsx
│   ├── usuarios/page.tsx       # busca/filtros
│   ├── auditoria/, admin/, perfil/
├── components/
│   ├── theme-toggle.tsx        # REUSO — já existe, só falta montar no hub
│   ├── hub/
│   │   ├── module-nav.tsx      # sidebar — ADICIONAR estado de colapso (FR-001..004)
│   │   ├── status-badge.tsx    # REUSO — já satisfaz FR-016, sem mudança
│   │   ├── kpi-card.tsx        # NOVO — padrão de indicador (FR-014)
│   │   └── filter-bar.tsx      # NOVO — padrão de busca/filtros (FR-015)
│   └── ui/
│       ├── card.tsx            # ajustar ring→shadow (FR-012/013), base compartilhada
│       ├── table.tsx           # ajustar borda de linha/header (FR-011/013), base compartilhada
│       └── tooltip.tsx         # REUSO — dica dos itens colapsados (FR-002)
└── lib/hub/
    └── sidebar-preference.ts   # NOVO — hook/helper de leitura+escrita do localStorage (mesmo padrão do next-themes)
```

**Structure Decision**: nenhum diretório novo de alto nível — a feature vive
inteiramente dentro de `app_homologacao/frontend_v2/{app/hub,components,lib/hub}`,
seguindo a árvore já existente do hub (`hub-shell` S3). Dois componentes
novos (`kpi-card.tsx`, `filter-bar.tsx`) entram em `components/hub/` junto
dos demais componentes compartilhados do hub; um helper novo
(`sidebar-preference.ts`) entra em `lib/hub/` junto dos demais utilitários
data-driven do hub (`me-dto.ts`, `module-nav.ts`).

**Contratos de API**: N/A — esta feature não introduz, altera nem depende de
nenhum endpoint novo do backend (`/me`, `/importacoes`, `/motoristas` etc.
continuam exatamente como estão). `docs/specs/hub-uiux-refresh/contracts/`
fica sem arquivos (diretório mantido vazio por paridade de layout, mas o
Phase 1 não produz contrato — item explicitamente pulado, ver ETAPA 5.2 da
skill `plan`: "Pular se projeto é puramente interno").

## Convenções de Borda

N/A — single-layer (mudança inteiramente dentro do frontend_v2; nenhuma
borda DB↔backend↔frontend nova é introduzida ou alterada por esta feature).

## Complexity Tracking

Nenhuma violação de constitution — tabela vazia.
