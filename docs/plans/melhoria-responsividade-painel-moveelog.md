# Plano — Melhoria de responsividade (mobile + desktop) do painel `app.moveelog.com.br`

> Briefing para rodar via `/ui-ux-pro-max` em **sessão fresca** (cstk). Padrão dos planos em
> `docs/plans/`. Elaborado com apoio da skill `/ui-ux-pro-max` (guidelines de responsividade,
> touch e acessibilidade) + audit do código.

## 1. Objetivo

Melhorar a **responsividade mobile (≤640px)** e o **aproveitamento de desktop (≥1280px)** do
painel web (`app_homologacao/frontend_v2`, domínio `app.moveelog.com.br`). É **polish de
layout/UX**, **NÃO um re-skin**: o design system **EntreGô 2.0** já existe e deve ser
**preservado** (paleta, tipografia, glassmorphism, aurora, dark/light).

## 2. Stack e design system (preservar)

- **Stack**: Next.js 16.2.3 · React 19.2 · **Tailwind v4** (config em CSS `@theme`, **não**
  `tailwind.config.js`) · shadcn/ui 4.2.0 · framer-motion 12.38 · lucide · sonner · base-ui ·
  next-themes.
- **Design system EntreGô 2.0** (não alterar):
  - Tipografia: **Plus Jakarta Sans** (400/500/600/700/800); `font-display` para títulos.
  - Paleta: primário `#2c67ea` (azul) · accent `#2ceabc` (menta) · verde `#009b7f` ·
    amarelo `#ffb72a`. Light: bg `#f9f2e8` (creme) / fg `#0f1849` (marinho). Dark: bg
    `#0a1130` / fg `#e9eefb`.
  - Efeitos: glassmorphism (`blur(18px) saturate(1.4)`), aurora orbs, shimmer skeletons,
    `prefers-reduced-motion` respeitado.

## 3. Estado atual (audit)

8 telas: `/login`, `/register`, `/dashboard` (5 stats cards + tabela movimentos + filtros +
action bar), `/dashboard/validacao-xml`, `/dashboard/motoristas` (CRUD), `…/configuracoes/
aparencia` (white-label), `…/configuracoes/grupo` (filiais).

**Bom hoje**: base mobile-first; header com **Sheet drawer** no mobile (PR #16) + nav
horizontal no desktop; padrão **cards (mobile) vs `<table>` (desktop)** no `data-table`;
dark/light com tokens; `tabular` em colunas numéricas.

**Fraco hoje** (cada item com `arquivo:linha`):

| ID | Problema | Arquivo:linha | Impacto |
|----|----------|---------------|---------|
| R001 | Filtros `grid-cols-2 sm:grid-cols-4` quebram <400px; inputs de data espremidos | `components/filters.tsx:61` | 🔴 alto |
| R002 | Action bar `flex flex-wrap gap-3` fixo; botões com texto longo quebram <400px | `components/action-bar.tsx:48` | 🔴 alto |
| R003 | Dialogs `sm:max-w-md` sem padding lateral mobile <480px | `components/edit-dialog.tsx:77`, `components/import-button.tsx:134` | 🟠 médio |
| R004 | Logo do header `h-8 max-w-32` espremido/some <320px | `components/header.tsx:145` | 🟠 médio |
| R005 | Login/Register `px-4` fixo, `max-w-sm` ocupa 100% no mobile | `app/login/page.tsx:52`, `app/register/page.tsx` | 🟠 médio |
| R006 | Stats cards saltam `sm:grid-cols-3 → lg:grid-cols-5` sem `md:grid-cols-4` | `components/stats-cards.tsx:30` | 🟠 médio |
| R007 | `data-table` desktop sem `overflow-x-auto` explícito; headers sem `aria-sort` | `components/data-table.tsx:124` | 🟠 médio |
| R008 | `EmpresaSelector` popover `max-w-[calc(100vw-2rem)]` sem teto no desktop | `components/empresa-selector.tsx:211` | 🟡 baixo |
| R009 | Layout `max-w-7xl` desperdiça >40% em ultrawide (≥2560px) | `app/dashboard/layout.tsx:40` | 🟡 baixo |
| R010 | Tipografia mobile: labels `text-xs`; garantir body ≥16px (evita zoom iOS) | global / vários | 🟡 baixo |
| R011 | Paginação botões `h-8 w-8` (32px) < 44px (WCAG touch) | `components/pagination-controls.tsx` | 🟡 baixo |
| R012 | Gaps fixos (`gap-3`/`gap-4`) não fluidos entre breakpoints | vários componentes | 🟡 baixo |

## 4. Princípios de design (guidelines `/ui-ux-pro-max` aplicáveis a web)

- **§5 Layout & Responsive**: mobile-first; breakpoints sistemáticos (375/768/1024/1440 →
  `sm/md/lg/xl`); **sem scroll horizontal** no mobile; **spacing scale 4/8** (gaps fluidos);
  `readable-font-size` body **≥16px** no mobile; `container-width` consistente e ajustado por
  device; `content-priority` (core primeiro no mobile); hierarquia por tamanho/spacing/contraste.
- **§2 Touch & Interaction**: alvos **≥44×44px**; espaçamento ≥8px entre alvos.
- **§1 Accessibility**: contraste 4.5:1; focus rings visíveis; `dynamic-type`/zoom; reduced-motion
  (já ok). Cor nunca como único indicador.
- **§6 Typography & Color**: `line-height` 1.5; `number-tabular` em dados (já usa); truncar com
  tooltip/expand em vez de cortar cru.
- **§8 Forms & Feedback**: input **≥44px** de altura no mobile; `input-type` semântico
  (date/email/tel/number) para o teclado certo; validação on-blur; helper text persistente.
- **§10 Charts & Data**: `sortable-table` com `aria-sort`; tabela responsiva (cards no mobile —
  já feito); densidade de dados controlada no desktop.

## 5. Escopo das melhorias — por fase

> Cada item indica o(s) `R###` e a(s) guideline(s). **Só Tailwind classes + componentes
> existentes.** Se precisar de breakpoint `xs` (<640px), criar via `@theme` do Tailwind v4
> (CSS), não `tailwind.config.js`.

### Fase 1 — Mobile crítico (alto impacto)
1. **Filtros fluidos (R001)** — `grid-cols-1 xs:grid-cols-2 lg:grid-cols-4`; inputs (inclusive
   `type="date"`) com altura ≥44px; sem espremer <400px. [§5, §8]
2. **Action bar fluida (R002)** — `gap-2 sm:gap-3 md:gap-4`; botões `size="sm"` no mobile;
   quando estourar, **overflow/“mais”** em vez de quebrar; `truncate` em rótulos longos. [§5, §9]
3. **Dialogs mobile (R003)** — largura `w-[calc(100vw-2rem)] sm:max-w-md`, padding lateral,
   scroll interno; nunca causar scroll horizontal. [§5]
4. **Logo do header (R004)** — `h-6 sm:h-8`, `min-w`/`shrink-0`, garantir visibilidade ≥320px. [§4]
5. **Login/Register (R005)** — `max-w-[95vw] sm:max-w-sm`, `px-4 sm:px-6`, inputs ≥44px. [§5, §8]

### Fase 2 — Densidade tablet/desktop (médio impacto)
6. **Stats cards (R006)** — `grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5` (suaviza
   o salto 3→5; menos espaço morto em 768–1024px). [§5]
7. **Data-table (R007)** — `overflow-x-auto` explícito no wrapper desktop; considerar 1ª coluna
   sticky; `aria-sort` nos headers ordenáveis. [§5, §10]
8. **EmpresaSelector (R008)** — teto `max-w-md md:max-w-lg` no popover. [§5]
9. **Spacing scale (R012)** — padronizar gaps fluidos (`gap-2 sm:gap-3 md:gap-4`) e ritmo
   vertical (16/24/32) entre seções. [§5]

### Fase 3 — Desktop wide + polish (baixo impacto)
10. **Container ultrawide (R009)** — em `≥xl/2xl`, subir o teto (ex.: `xl:max-w-[96rem]
    2xl:max-w-[110rem]`) e/ou aumentar gutters; sem virar sidebar full. [§5]
11. **Paginação touch (R011)** — botões `min-h-11 min-w-11` (44px) e `gap-2`. [§2]
12. **Tipografia mobile (R010)** — body ≥16px (evita auto-zoom iOS); revisar labels `text-xs`
    críticos para `text-sm` no mobile; `line-height` ≥1.5. [§5, §6]
13. **Micro-interações** — durações 150–300ms; stagger de listas 30–50ms; manter reduced-motion.

## 6. Restrições (não-fazer)

- **NÃO re-skin**: preservar paleta/tipografia/efeitos EntreGô 2.0.
- **NÃO adicionar dependências**: usar shadcn/ui, Tailwind, framer-motion, base-ui já presentes.
- **NÃO tocar** lógica de negócio, hooks de dados, backend, contratos de API.
- **Tailwind v4**: customizações de tema/breakpoint via `@theme` em CSS (`app/globals.css`),
  não `tailwind.config.js`.
- Manter dark/light em paridade (testar os dois).

## 7. Critérios de aceite / teste

- **Viewports**: 320, 375 (iPhone SE), 414, 768 (iPad), 1024, 1440, 1920, 2560.
- **Sem scroll horizontal** em nenhuma tela ≤640px.
- **Touch targets ≥44px** (filtros, inputs, paginação, botões de ação).
- Filtros, stats e tabela **legíveis e operáveis em 320–414px**.
- Desktop ultrawide (≥2560px) não desperdiça >35% de largura.
- **Dark + light** validados; contraste AA (4.5:1).
- **Sem regressão funcional** (login, upload com range, validação XML, CRUD motoristas/grupo,
  white-label).
- Build do `frontend_v2` passa (`next build`).

## 8. Deploy (rito de produção — operador)

Host `VPSTodo` = produção. Build do `frontend_v2` é `next build` (pesado) → **swap temporário
4G + `DOCKER_BUILDKIT=0 docker build --memory=2g`** (lição starvation), tag específica, `docker
push`, `docker service update --with-registry-auth --image …
envio-massa-homologacao_frontend_v2_homologacao`. **Sem DDL.** Rollback = imagem anterior
anotada via `docker service inspect`. Smoke `app.moveelog.com.br/login` = 200 + validação
visual nos breakpoints.

## 9. Como rodar (sessão fresca)

`cwd` na raiz do repo, branch `main`. Use o prompt da seção **§10** invocando `/ui-ux-pro-max`.
Sugestão: **uma fase por vez** (Fase 1 → revisar/testar → Fase 2 → Fase 3), commits/PR por fase
para revisão incremental. Não buildar/deployar até o operador autorizar (rito).

## 10. Prompt para sessão fresca

```
/ui-ux-pro-max improve — Melhorar a responsividade mobile (≤640px) e o aproveitamento de
desktop (≥1280px) do painel web em app_homologacao/frontend_v2 (Next.js 16, React 19,
Tailwind v4, shadcn/ui, framer-motion). Siga o plano em
docs/plans/melhoria-responsividade-painel-moveelog.md.

REGRAS DURAS:
- NÃO é re-skin: preserve o design system EntreGô 2.0 (Plus Jakarta Sans; azul #2c67ea /
  menta #2ceabc / creme #f9f2e8 / marinho #0f1849; glassmorphism, aurora, dark/light).
- NÃO adicione dependências novas (use shadcn/ui, Tailwind v4, framer-motion, base-ui).
- NÃO toque backend/hooks de dados/lógica de negócio.
- Tailwind v4: customizações de tema/breakpoint via @theme em app/globals.css, não
  tailwind.config.js.
- Mobile-first; sem scroll horizontal; touch targets ≥44px; body ≥16px no mobile;
  spacing scale 4/8; dark+light em paridade.

EXECUTE POR FASE (commit/PR por fase, revisão incremental):
- Fase 1 (mobile crítico): R001 filtros fluidos (filters.tsx); R002 action bar
  (action-bar.tsx); R003 dialogs mobile (edit-dialog.tsx, import-button.tsx); R004 logo
  header (header.tsx); R005 login/register (app/login, app/register).
- Fase 2 (densidade): R006 stats md:grid-cols-4 (stats-cards.tsx); R007 data-table
  overflow-x + aria-sort (data-table.tsx); R008 empresa-selector teto; R012 gaps fluidos.
- Fase 3 (desktop wide + polish): R009 container ultrawide (dashboard/layout.tsx); R011
  paginação 44px (pagination-controls.tsx); R010 tipografia mobile; micro-interações.

Para cada arquivo, rode /ui-ux-pro-max para as diretrizes específicas, aplique só classes
Tailwind/composição de componentes existentes, e valide nos viewports 320/375/414/768/1024/
1440/1920/2560 em dark e light. Critérios de aceite na §7 do plano. NÃO buildar/deployar:
ao final, entregue os PRs e peça ao operador o deploy (rito: swap 4G + docker build
--memory=2g, service update do frontend_v2, sem DDL).
```
