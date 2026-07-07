<!--
Sugestão de título do PR:
S3 — Shell Modular do Hub (nav, auth, EntitySwitcher, dashboard)

Corpo preparado pelo orquestrador feature-00c (hub-shell) para uso do
orquestrador PAI em `gh pr create --title "..." --body "$(cat PR-BODY.md)"`.
NÃO abrir o PR nem fazer push a partir deste subagente.
-->

## Resumo

Entrega a **casca de navegação** do painel do hub sobre as fundações da S2
(`feat/hub-fundacoes`, PR #55): `ModuleNav` data-driven por permissão,
`EntitySwitcher` (troca de entidade ativa sem novo login), `EnvBadge`
(banner de ambiente não-produção), telas de autenticação (login,
recuperar/redefinir senha, perfil com troca de senha, logout) e
`/hub/dashboard` com cards por módulo.

- Namespace de rota `/hub/*` para as telas do shell que colidiriam com o
  legado do envio-massa (`app/login`, `app/dashboard`,
  `app/dashboard/motoristas` já existem) — dec-041.
- `contexts/auth-context.tsx` (legado do envio-massa) **intocado**; auth do
  shell vive em `contexts/hub-auth-context.tsx`, novo — dec-017.
- **Sem DDL**: o `/me` da S2 já cobre 100% dos dados consumidos pelo shell
  (dec-016).
- **Sem telas de módulo de negócio** — motoristas, faturamento,
  performance, importações ficam para S4–S9.

## Como foi testado

Pipeline SDD completo (specify → clarify → plan → checklist → create-tasks
→ execute-task → review-task), 7 fases, ambiente isolado `hub-homolog`
(exceção standing G1, VPSTodo — zero escrita em produção).

- **73 testes unitários (vitest)** verdes — adaptador `me-dto`, telas de
  login/recuperar-senha/redefinir-senha/perfil.
- **11/11 asserts E2E via API/proxy** (`infra/hub/testes/hub-shell-e2e-homolog.sh`):
  403 por acesso direto a rota protegida sem permissão (com contraprova
  200 para quem tem a permissão), troca de entidade refletida em `GET /me`
  sem novo login, `EnvBadge` presente no HTML de todas as telas do shell,
  `entidades: []` roteando para a tela "sem acesso".
- **10/10 testes E2E browser** (Playwright real, `@axe-core/playwright`,
  container oficial `mcr.microsoft.com/playwright`, nunca instalado no
  host): menus por papel (admin_entidade 8 itens vs operador 6), troca de
  entidade em 162ms, sessão corrompida mid-ação redireciona ao login sem
  flash de conteúdo protegido residual.
- **axe: 6/6 telas em 100/100** — 4 achados reais de acessibilidade
  (`landmark-one-main`/`page-has-heading-one`/`region`) encontrados e
  corrigidos nesta mesma onda (landmark `<main>` + `<h1>` em
  login/recuperar-senha/redefinir-senha/selecionar-entidade).
- **Gate de segurança pós-implementação (owasp-security)**: nenhum finding
  critical/high. Cookies `httpOnly`+`sameSite=strict`+`secure`. Nenhum
  `PermissionGate`/`hasPermission` no shell — o menu deriva de
  `me.modulos` (dado do servidor) e a autorização real é 100% backend
  (RLS + `requirePermission`), comprovado empiricamente pelo 403 do
  cenário de acesso direto via URL.
- Build de imagem sob **rito anti-starvation** (`--memory=2g`, swap 8G
  ativo): produção permaneceu 8/8 Up antes/durante/depois do build.

Evidências completas em
`docs/plans/hub-frota/evidencias/S3/` (`fase6-e2e-evidencias.md`, log
bruto Playwright, prints do `ModuleNav` por papel).

## Decisões arquiteturais

- **dec-014**: `/me.modulos[].ativo` (campo real do backend, não
  `.habilitado` como o briefing sugeria) consumido por presença no array —
  sem alterar o contrato da S2.
- **dec-015**: `PermissionGate` é decorativo por design; a autorização real
  é sempre backend, por entidade ativa.
- **dec-017**: provider de auth novo para o shell; zero mudança no auth
  legado do envio-massa (FR-018/SC-007 preservados).
- **dec-019**: gate de segurança arquitetural rodado antes do código —
  A01 (broken access control) mitigado por design; A07/CSRF cobertos por
  TTL curto + `sameSite=strict`.
- **dec-041**: prefixo `/hub/*` para rotas que colidiriam letra-por-letra
  com páginas já existentes do envio-massa legado.

## O que NÃO está incluído

- Telas de módulo de negócio (motoristas, faturamento, performance,
  importações) — ficam para S4–S9.
- Qualquer alteração nas telas do envio-massa existente
  (`app.moveelog.com.br`) até o cutover da S8/S10.
- Migration/DDL nova.
- Endpoint novo de troca de senha autenticada (reusa o fluxo de
  recuperação de senha já existente).
- Deploy/cutover para produção — fora do escopo desta sessão.

## Checklist de evidências

- [x] `docs/specs/hub-shell/spec.md`, `plan.md`, `research.md`,
      `data-model.md`, `tasks.md`, `e2e-plan.md`
- [x] `docs/specs/hub-shell/checklists/requirements.md`
- [x] `docs/plans/hub-frota/evidencias/S3/` (E2E + axe + prints)
- [x] `docs/plans/hub-frota/DIARIO.md` (entrada de fechamento da S3)
- [x] Gates rodados: doc-quality, security (owasp-security), template-fidelity,
      docs-render — sem findings critical/high pendentes

## Nota

Merge e deploy são do **operador**. O cutover para produção (gate **G3**)
só ocorre no fechamento da **S10** do plano mestre do hub — este PR entrega
apenas a casca validada no ambiente isolado `hub-homolog`, sem tocar o
ambiente vivo do cliente.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
