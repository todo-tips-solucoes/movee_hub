# Plano — Melhoria de UI/UX do painel `app.moveelog.com.br` (frontend_v2)

> Briefing para rodar via `/ui-ux-pro-max` em **sessão fresca** (cstk). Mesmo padrão dos planos em
> `docs/plans/`. Elaborado com a skill `/ui-ux-pro-max` (guidelines §1 Accessibility, §8 Forms &
> Feedback, §6 Typography, §7 Animation, §9 Navigation) + audit profundo do código (subagente
> Explore, todas as telas).

## 1. Objetivo

Elevar a **qualidade de UI/UX** do painel web (`app_homologacao/frontend_v2`, domínio
`app.moveelog.com.br`). A **responsividade** já foi tratada e validada (plano
`melhoria-responsividade-painel-moveelog.md`, 3 fases no ar) — **este plano NÃO mexe em
responsividade**. Foco em **acessibilidade, estados de UI, forms & feedback, hierarquia/clareza,
navegação e microinterações**.

É **polish de UI/UX**, **NÃO um re-skin** nem reescrita: o design system **EntreGô 2.0** já existe e
deve ser **preservado** (paleta, Plus Jakarta Sans, glass/aurora/shimmer, dark/light, white-label
por tenant). A base é sólida (audit não achou nada de alta severidade) — são refinamentos de alto
valor e baixo risco.

## 2. Stack e design system (preservar)

- **Stack**: Next.js 16.2.3 · React 19.2 · **Tailwind v4** (`@theme` em `app/globals.css`, **não**
  `tailwind.config.js`) · shadcn/ui · **framer-motion 12.38** · base-ui · next-themes · sonner.
- **Design system EntreGô 2.0** (não alterar — tokens em `app/globals.css`):
  - Tipografia: **Plus Jakarta Sans** (única em sans/display/heading/mono).
  - Paleta: primário `#2c67ea` · marinho `#0f1849` · menta `#2ceabc` · amarelo `#ffb72a` · creme
    `#f9f2e8`. Dark/light via `:is(.dark *)`. White-label em runtime (`TenantThemeProvider`
    HEX→oklch) — **não tocar a lógica**.
  - Efeitos: glass, aurora, shimmer; breakpoint `xs` (25rem) já existe.

## 3. Estado atual (audit) — qualidade ÓTIMA, com gaps pontuais

7 telas + shell. **Fortes hoje:** design system coerente; loading states com skeleton (sem CLS);
empty states excelentes (`data-table`); `configuracoes/grupo` é referência de a11y de form
(`aria-required`/`aria-invalid`/`aria-describedby` + foco no 1º inválido); animações framer-motion
significativas; `useReducedMotion` respeitado.

**Gaps (cada um com `arquivo:linha`; caminhos relativos a `app_homologacao/frontend_v2/`):**

| ID | Problema | Arquivo:linha | Categoria | Sev. |
|----|----------|---------------|-----------|------|
| U001 | Botões só-ícone (excluir/editar) na tabela **sem `aria-label`** | `components/data-table.tsx:155` | a11y | 🟠 |
| U002 | Páginas sem `<h1>` / heading hierarchy (validacao-xml; aparencia/grupo só implícito) | `app/dashboard/validacao-xml/page.tsx`, `…/configuracoes/aparencia/page.tsx` | a11y | 🟠 |
| U003 | `erro_validacao` só visível em tooltip (hover) — color/hover-only; teclado/touch não veem | `components/data-table.tsx:180` | a11y/color-not-only | 🟠 |
| U004 | Contraste de `--warning`/`--destructive` no **dark** não verificado (pode falhar AA) | `app/globals.css` | a11y/contraste | 🟠 |
| U005 | Dialog de edição com título genérico "Editar Registro" (sem entidade/id) | `components/edit-dialog.tsx:67` | hierarquia/a11y | 🟠 |
| U006 | Login/register sem **validação on-blur** (erro só no submit); required indicator inconsistente | `app/login/page.tsx`, `app/register/page.tsx` | forms | 🟠 |
| U007 | Mensagens de erro genéricas (ex.: motoristas) sem causa/recuperação | `app/dashboard/motoristas/page.tsx:60` | forms/feedback | 🟠 |
| U008 | Estado de processamento (ativo/parado) **não destacado** na dashboard | `app/dashboard/page.tsx:50-65` | clareza/feedback | 🟠 |
| U009 | Sem **breadcrumb / título de página** — desorientação em subnav (configurações) | shell `app/dashboard/layout.tsx`, `header.tsx` | navegação | 🟠 |
| U010 | `configuracoes/grupo` muito densa (cadastro+editar+reset+desvincular sem separação clara) | `app/dashboard/configuracoes/grupo/page.tsx` | hierarquia/fluxo | 🟠 |
| U011 | Success feedback fraco (só toast; sem confirmação visual no dialog antes de fechar) | `components/edit-dialog.tsx`, dialogs | microinteração | 🟡 |
| U012 | CTAs primárias sem press/spring; alguns botões `inline-flex` ad-hoc em vez de `Button` | `components/ui/button.tsx`, `…/grupo/page.tsx` | microinteração/consistência | 🟡 |

## 4. Princípios de design (guidelines `/ui-ux-pro-max` aplicáveis)

- **§1 Accessibility**: `aria-labels` em botões só-ícone; `heading-hierarchy` (um `h1` por página);
  `color-not-only` (status/erro nunca só por cor/hover); `color-accessible-pairs` (4.5:1 em dark e
  light); `focus-states` visíveis; `aria-live` em erros/toasts; `keyboard-nav`.
- **§8 Forms & Feedback**: `inline-validation` on-blur; `error-clarity` (causa+correção);
  `error-recovery` (retry); `required-indicators` consistentes; `success-feedback`;
  `focus-management` (1º campo inválido — já é referência no grupo, replicar).
- **§6 Typography**: `weight-hierarchy` e `font-scale` consistentes; ação primária clara por tela.
- **§9 Navigation**: `breadcrumb-web` para hierarquias 3+ níveis; `nav-state-active`;
  `navigation-consistency`; `progressive-disclosure` (densidade de `grupo`).
- **§7 Animation**: `scale-feedback`/`spring-physics` em CTAs; `duration-timing` 150–300ms;
  `reduced-motion` (já respeitado) — manter.

## 5. Escopo das melhorias — por fase

> Cada item indica o(s) `U###` e a(s) guideline(s). **Só apresentação** (classes Tailwind, props de
> componentes, markup semântico, framer-motion já presente). **Não** tocar lógica/dados. Tailwind v4
> via `@theme`. **Não regredir** a responsividade já entregue.

### Fase 1 — Acessibilidade & clareza (alto valor, baixo risco)
1. **`aria-label` em botões só-ícone (U001)** — excluir/editar/ações na `data-table` (e onde faltar):
   `aria-label="Excluir movimento #${id}"`, etc. Conferir todos os `size="icon"`. [§1]
2. **Heading hierarchy / `<h1>` por página (U002)** — adicionar `<h1>` semântico em
   `validacao-xml`, `aparencia`, `grupo` (e garantir 1 `h1` nas demais); seções com `<section>`. [§1]
3. **Erro de validação acessível (U003)** — no `data-table`, além do ícone+tooltip, expor o
   `erro_validacao` de forma perceptível sem hover (texto curto/badge "Erro" + acessível por
   teclado/`aria`), sem poluir a densidade. [§1 color-not-only]
4. **Contraste dark de warning/destructive (U004)** — verificar `--warning`/`--destructive` vs
   foreground no dark (alvo ≥4.5:1); se falhar, ajustar o **token** (tonal desaturado), sem mudar a
   identidade. [§1]
5. **Título de dialog contextual (U005)** — `edit-dialog` recebe entidade/rótulo e renderiza
   `Editar <entidade> #<id>`; melhora orientação e leitura por screen reader. [§1, hierarquia]

### Fase 2 — Forms & feedback
6. **Validação on-blur + inline (U006)** — login/register validam e-mail (formato) e campos
   on-blur, com erro inline; padronizar `required-indicator` (`*` com `aria-hidden`) entre as telas;
   replicar o padrão de a11y de form do `grupo`. [§8]
7. **Mensagens de erro claras + recuperação (U007)** — propagar a causa real da API (distinguir
   negócio vs infra) e oferecer caminho (retry); evitar "Tente novamente" genérico. [§8 error-clarity/recovery]
8. **Success feedback reforçado (U011)** — confirmação visual breve nos dialogs (checkmark animado
   framer-motion ~200ms) antes de fechar, complementando o toast. [§8, §7]

### Fase 3 — Navegação, densidade & microinterações
9. **Breadcrumb / título de página (U009)** — componente reutilizável no shell do dashboard
   (`Dashboard › Configurações › Aparência`) ou page-title dinâmico; orientação consistente. [§9]
10. **Estado de processamento destacado (U008)** — badge/realce na dashboard indicando
    ATIVO/PARADO (cor + ícone + texto), com transição suave. [§9, §1 color-not-only]
11. **Densidade da página grupo (U010)** — separar concerns (abas/colapsáveis/seções com títulos)
    para reduzir poluição; `progressive-disclosure`. [§9]
12. **Microinterações & consistência (U012)** — `scale-feedback`/spring leve em CTAs primárias
    (respeitando reduced-motion); padronizar botões ad-hoc `inline-flex` para o `Button` shadcn;
    ritmo de whitespace entre seções. [§7, consistência]

## 6. Restrições (não-fazer)

- **NÃO re-skin**: preservar paleta/tipografia/efeitos EntreGô 2.0 e o white-label por tenant.
- **NÃO adicionar dependências**: usar Tailwind v4, shadcn/ui, framer-motion, base-ui, sonner já
  presentes.
- **NÃO tocar lógica/dados**: `lib/api-client.ts`, `contexts/auth-context.tsx`,
  `contexts/tenant-theme-context.tsx`, `hooks/use-envio-massa.ts`, `hooks/use-process-status.ts`,
  `hooks/use-grupo-escopo.ts`, `types/index.ts`. (Pode-se *passar props* novas de apresentação aos
  componentes, sem alterar a lógica subjacente.)
- **NÃO regredir a responsividade** já entregue nem o comportamento mobile.
- **Tailwind v4**: customizações de tema/token via `@theme` em `app/globals.css`.
- Manter dark/light em paridade.

## 7. Critérios de aceite / teste

- **Acessibilidade**: cada página com **um `<h1>`** e hierarquia coerente; todos os botões só-ícone
  com `aria-label`; status/erros **não só por cor/hover**; foco visível e navegação por teclado
  completas; `aria-live` em erros/toasts; contraste **AA (4.5:1)** verificado em **dark E light**
  (warning/destructive incluídos). (Validar com axe/Lighthouse a11y; meta ≥95.)
- **Forms**: validação on-blur com erro inline e foco no 1º inválido; mensagens com causa+correção;
  required indicators consistentes; success feedback visível.
- **Navegação/clareza**: breadcrumb/título de página presente nas subrotas; estado de processamento
  óbvio; `grupo` menos densa.
- **Microinterações**: durações 150–300ms; `prefers-reduced-motion` respeitado; CTAs com feedback.
- **Sem regressão**: funcional (login, envio/processo, import, validação XML, CRUD motoristas,
  white-label, grupo) e responsiva. Build `frontend_v2` passa (`next build`). Dark+light OK.

## 8. Deploy (rito de produção — operador)

Host `VPSTodo` = produção. Serviço Swarm `envio-massa-homologacao_frontend_v2_homologacao`; registry
`registry.todo-tips.com/envio-massa-frontend-v2`; domínio `app.moveelog.com.br`. Build `next build`
(pesado) → **swap temporário 4G + `DOCKER_BUILDKIT=0 docker build --memory=2g`** (lição starvation),
tag específica, `docker push`, `docker service update --with-registry-auth --image …
envio-massa-homologacao_frontend_v2_homologacao`. **Sem DDL.** Conferir `ENV BACKEND_URL` do
Dockerfile antes. Rollback = imagem anterior via `docker service inspect`. Smoke
`app.moveelog.com.br/login` = 200 + validação visual. `swapoff` ao final.

## 9. Como rodar (sessão fresca)

`cwd` na raiz do repo, branch `main`. Use o prompt da §10 invocando `/ui-ux-pro-max`. **Uma fase por
vez**, **1 PR por fase** (revisão incremental). Validar por inspeção de classes/markup + ferramentas
de a11y (axe/Lighthouse) nos modos dark/light. **Não buildar/deployar** até o operador autorizar
(rito §8).
⚠️ **Gotcha do ciclo anterior:** nunca pôr comentário JSX `{/* */}` logo após `return (` antes do
elemento/fragment raiz — quebra o build (turbopack). Usar `//` acima do `return` ou comentário como
filho; grepar `return ($` + `{/*` antes de cada build.

## 10. Prompt para sessão fresca

```
/ui-ux-pro-max improve — Melhorar a QUALIDADE de UI/UX do painel web em
app_homologacao/frontend_v2 (app.moveelog.com.br; Next.js 16, React 19, Tailwind v4 @theme,
shadcn/ui, framer-motion). A RESPONSIVIDADE já foi feita — NÃO mexer nela. Foco: acessibilidade,
estados de UI, forms & feedback, hierarquia/clareza, navegação e microinterações. Siga o plano em
docs/plans/melhoria-ui-ux-painel-moveelog.md.

REGRAS DURAS:
- NÃO é re-skin: preserve o design system EntreGô 2.0 (Plus Jakarta Sans; azul #2c67ea /
  menta #2ceabc / creme #f9f2e8 / marinho #0f1849; glass, aurora, dark/light, white-label).
- NÃO adicione dependências (use Tailwind v4, shadcn/ui, framer-motion, base-ui, sonner).
- NÃO toque lógica/dados (api-client, contexts, hooks, types). Pode passar props de apresentação.
- NÃO regredir a responsividade nem o comportamento mobile. Tailwind v4: @theme em globals.css.

EXECUTE POR FASE (1 PR por fase, revisão incremental):
- Fase 1 (a11y & clareza): U001 aria-label em botões só-ícone (data-table); U002 <h1>/heading
  hierarchy (validacao-xml, aparencia, grupo); U003 erro_validacao acessível (sem hover-only);
  U004 contraste dark de warning/destructive (ajustar token se <4.5:1); U005 título de dialog
  contextual (edit-dialog).
- Fase 2 (forms & feedback): U006 validação on-blur + inline + required indicators (login/register);
  U007 mensagens de erro com causa+recuperação (motoristas e geral); U011 success feedback com
  checkmark animado nos dialogs.
- Fase 3 (navegação/densidade/microinterações): U009 breadcrumb/título de página no shell; U008
  estado de processamento destacado (dashboard); U010 reduzir densidade de configuracoes/grupo
  (abas/colapsáveis); U012 spring/press em CTAs + padronizar botões ad-hoc para Button shadcn.

Para cada arquivo, rode /ui-ux-pro-max para as diretrizes, aplique só apresentação (classes/markup/
props/framer-motion), e valide com axe/Lighthouse a11y em dark e light, conferindo que nada
funcional nem a responsividade regrediu. Critérios de aceite na §7. NÃO buildar/deployar: ao final
de cada fase, entregue o PR e peça ao operador o deploy (rito §8: swap 4G + docker build
--memory=2g, service update do frontend_v2, sem DDL).
```
