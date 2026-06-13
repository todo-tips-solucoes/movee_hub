# Plano — Melhoria de UI/UX da visão DESKTOP do app `app.motorista.moveelog.com.br`

> Briefing para rodar via `/ui-ux-pro-max` em **sessão fresca** (cstk). Mesmo padrão do plano
> `docs/plans/melhoria-responsividade-painel-moveelog.md` (já concluído). Elaborado com a skill
> `/ui-ux-pro-max` (guidelines §5 Layout & Responsive, §6 Typography, §9 Navigation) + audit
> profundo do código (subagente Explore).

## 1. Objetivo

Melhorar a **visão DESKTOP (≥1024px)** do PWA do motorista (`app_homologacao/frontend_motorista`,
domínio `app.motorista.moveelog.com.br`). Hoje o app é **mobile-first bem executado**, mas a visão
desktop está **negligenciada**: conteúdo travado em `max-w-md` (28rem), **zero breakpoints**
`md:`/`lg:`/`xl:`, grids fixos e tipografia que não escala → em 1920px ~90% da tela fica vazia.

É **polish de layout/UX responsivo**, **NÃO um re-skin** nem reescrita: o design system **EntreGô
2.0** já existe e deve ser **preservado** (paleta, Plus Jakarta Sans, Material Symbols, glass,
gradientes assinatura, dark/light). **Mobile-first é mantido**: todas as melhorias desktop são
**aditivas** via breakpoints (`lg:`/`xl:`), sem regredir o mobile.

> Princípio-guia: aproveitar a tela grande **sem virar outro app**. O motorista usa o celular; o
> desktop é uso secundário (ex.: conferência no escritório). Melhorar densidade e aproveitamento,
> mantendo a mesma identidade e os mesmos fluxos.

## 2. Stack e design system (preservar)

- **Stack**: Next.js 16.2.3 · React 19.2 · **Tailwind v4** (config via `@theme` inline em
  `app/globals.css`, **não** `tailwind.config.js`) · shadcn/ui 4.2 · ícones **Material Symbols
  Rounded** (Google Fonts) · animações **`tw-animate-css`** + keyframes próprias (`mv-fade-up`,
  `mv-scale-in`, `mv-float`, `mv-shimmer`) · next-themes (dark/light) · sonner · **Serwist** (PWA).
  ⚠️ **NÃO há framer-motion** aqui (diferente do painel) — usar `tw-animate-css`/CSS para animação.
- **Design system EntreGô 2.0** (não alterar — tokens em `app/globals.css`):
  - Tipografia: **Plus Jakarta Sans** (400/500/600/700/800); `--font-display`.
  - Paleta: primário `#2c67ea` (azul) · `--warm-1/--warm-2` menta `#2ceabc` · `--warm-3` laranja
    `#ffa726` · success `#10b981`. Light: bg `#f9f2e8` (creme) / card `#fefdfb` / fg `#0f1849`
    (marinho). Tokens dinâmicos por tenant via `TenantThemeProvider` (sobrescreve `--primary`,
    `--ring`, `--warm-2` em runtime — **não tocar**).
  - Efeitos: `.glass` (`backdrop-blur` + `bg-card/60`), `.bg-gradient-blue`,
    `.bg-gradient-warm-rich`, `.glow-warm`, shimmer/shine/pulse-ring, `.tabular`.

## 3. Estado atual (audit)

4 telas: `/login`, `/cadastro` (`app/(auth)/`), `/movimento` (dashboard do motorista) e `/validar`
(upload/validação de XML) (`app/(app)/`). Layout raiz `app/layout.tsx`; auth-guard em
`app/(app)/layout.tsx`. Splash em `app/page.tsx` (redireciona p/ `/movimento` ou `/login`).

**Bom hoje**: mobile-first sólido; design system EntreGô 2.0 completo (tokens, glass, gradientes,
Material Symbols); `min-h-dvh` + safe-area insets; dark/light com tokens; `.tabular` em valores.

**Fraco hoje (visão desktop)** — cada item com `arquivo:linha` (caminhos relativos a
`app_homologacao/frontend_motorista/`):

| ID | Problema | Arquivo:linha | Impacto |
|----|----------|---------------|---------|
| D001 | Conteúdo travado em `max-w-md` (28rem) sem expansão; ~90% da tela vazia em ≥1440px | `app/(app)/movimento/page.tsx:152`, `app/(app)/validar/page.tsx:138` | 🔴 alto |
| D002 | **Zero breakpoints** `md:`/`lg:`/`xl:` em todo o TSX — app idêntico mobile↔4K | todo o `app/` | 🔴 alto |
| D003 | Grid de dados fiscais sempre `grid-cols-2` (cards `col-span-2` viram 1 coluna); não vira 3–4 col no desktop | `app/(app)/movimento/page.tsx:255` | 🔴 alto |
| D004 | Botões/CTAs sempre `w-full` empilhados; sem layout lado-a-lado nem hierarquia no desktop | `app/(app)/movimento/page.tsx:381-405` | 🟠 médio |
| D005 | Shell/header com `px-4` fixo (cramped no desktop); gutters não adaptativos | `app/(app)/movimento/page.tsx:136` | 🟠 médio |
| D006 | Logo `h-7` (28px) some no desktop; sem escala | `app/(app)/movimento/page.tsx:137` | 🟠 médio |
| D007 | Hero do valor `text-[2.7rem]` fixo; sem escala desktop; subtítulos `text-xs` | `app/(app)/movimento/page.tsx:207` | 🟠 médio |
| D008 | Sem navegação adaptativa no desktop (sem topbar/nav estável — só ações inline empilhadas) | shell (`movimento`/`validar`) | 🟠 médio |
| D009 | Login/cadastro `max-w-sm` ok, mas sem respiro/escala no desktop (inputs `h-10` fixos) | `app/(auth)/login/page.tsx:95,122-149` | 🟡 baixo |
| D010 | Sticky header `z-20` sempre ativo (desnecessário no desktop alto) | `app/(app)/movimento/page.tsx:136` | 🟡 baixo |
| D011 | Spacing fixo (`gap-2/3`, `p-6`, `space-y-2.5`) não escala entre breakpoints | vários | 🟡 baixo |
| D012 | Ícones/badges com tamanho fixo (`h-4/h-5`) — ok, sem urgência | vários | 🟡 baixo |

## 4. Princípios de design (guidelines `/ui-ux-pro-max` aplicáveis)

- **§5 Layout & Responsive**: `container-width` consistente e **ajustado por device** (subir o teto
  no desktop em vez de travar em 28rem); `breakpoint-consistency` (375/768/1024/1440); `mobile-first`
  (base mobile + `lg:` aditivo); `content-priority`/`visual-hierarchy`; **adaptive gutters** por
  breakpoint; sem scroll horizontal; `spacing-scale` 4/8.
- **§6 Typography & Color**: `line-length` 60–75 chars no desktop (não esticar texto edge-to-edge);
  `font-scale` consistente (hero escala no desktop); `number-tabular` (já usa); `line-height` 1.5.
- **§9 Navigation Patterns**: `adaptive-navigation` (telas grandes preferem nav estável —
  topbar/nav horizontal; **sidebar full é exagero p/ app de 2 telas**, manter leve);
  `nav-state-active`; `navigation-consistency` (mesma posição em todas as telas).
- **§2 Touch & Interaction / §1 Accessibility**: preservar alvos ≥44px (já mobile-ok); manter
  `cursor-pointer` e foco visível no desktop; contraste AA em dark/light.
- **Common Rules — Layout & Spacing**: `consistent content width` por classe de device; ritmo
  vertical 16/24/32; `adaptive gutters by breakpoint`; texto longo legível em telas grandes.

## 5. Escopo das melhorias — por fase

> Cada item indica o(s) `D###` e a(s) guideline(s). **Só classes Tailwind + composição de
> componentes existentes.** Tailwind v4: qualquer breakpoint/token novo via `@theme` em
> `app/globals.css` (não `tailwind.config.js`). Mobile-first: **não remover** classes base; **somar**
> `lg:`/`xl:`. Validar que o mobile não regrediu.

### Fase 1 — Fundação responsiva (alto impacto) — destrava tudo
1. **Container responsivo (D001, D002)** — nas telas `/movimento` e `/validar`, trocar `max-w-md`
   por escada: `max-w-md lg:max-w-3xl xl:max-w-5xl` (ou `2xl:max-w-6xl`), mantendo `mx-auto`.
   Introduzir os breakpoints `lg:`/`xl:` como padrão do projeto. [§5]
2. **Gutters adaptativos do shell/header (D005)** — `px-4` → `px-4 md:px-8 lg:px-12`; aplicar no
   header e no `<main>`/container das telas, de forma consistente. [§5]
3. **Wrapper de página consistente** — garantir o mesmo container central (largura + gutters) em
   `/movimento`, `/validar` e nas telas de auth, para coesão entre telas. [§5, §9]

### Fase 2 — Layout desktop das telas (médio-alto impacto)
4. **Grid de dados fiscais multi-coluna (D003)** — `grid-cols-2` → `grid-cols-2 lg:grid-cols-3
   xl:grid-cols-4`; revisar os `col-span-2` para que no desktop os cards distribuam (ex.:
   `lg:col-span-1`). Densidade melhor sem esticar. [§5]
5. **Hero do movimento em 2 colunas no desktop** — no `/movimento`, no desktop, dispor o **hero do
   valor** ao lado do **bloco de dados/ações** (ex.: `lg:grid lg:grid-cols-[minmax(0,28rem)_1fr]
   lg:gap-8`) em vez de tudo empilhado; mobile permanece em coluna única. [§5, content-priority]
6. **Botões/CTAs lado a lado + hierarquia (D004)** — no desktop, agrupar ações
   (`lg:flex lg:flex-wrap lg:w-auto`), CTA primária destacada e secundárias subordinadas; manter
   `w-full` no mobile. [§5, primary-action]
7. **Login/cadastro no desktop (D009)** — manter card centralizado, dar respiro vertical e leve
   escala (`lg:p-8`); inputs `h-10 lg:h-11`; sem esticar o card. [§5, §8]

### Fase 3 — Polish desktop + navegação (médio-baixo impacto)
8. **Navegação adaptativa leve (D008)** — no desktop, transformar o header numa **topbar com nav
   horizontal** (Movimento · Validar) + ações (tema/logout) à direita, com `nav-state-active`;
   manter o comportamento mobile atual. **Sem sidebar full.** [§9 adaptive-navigation]
9. **Tipografia/escala desktop (D007)** — hero `text-[2.7rem] lg:text-6xl`; subtítulos
   `text-xs lg:text-sm`; títulos de seção escalam; `line-length` controlado. [§6]
10. **Logo + header desktop (D006, D010)** — logo `h-7 lg:h-9`; rever sticky (`sticky` no mobile,
    avaliar `lg:static`) e espaçamento dos controles do header. [§5, §9]
11. **Spacing fluido (D011)** — padronizar `p-6 lg:p-8`, `gap-3 lg:gap-6`, ritmo vertical
    `space-y-* lg:space-y-*` entre seções. [§5]
12. **Micro-interações/QA** — manter durações 150–300ms (`tw-animate-css`), `prefers-reduced-motion`
    respeitado; conferir hover/cursor no desktop. [§7]

## 6. Restrições (não-fazer)

- **NÃO re-skin**: preservar paleta/tipografia/efeitos/ícones EntreGô 2.0 e o branding dinâmico por
  tenant (`TenantThemeProvider`).
- **NÃO adicionar dependências**: usar Tailwind v4, shadcn/ui, `tw-animate-css` já presentes.
- **NÃO tocar lógica/dados**: `contexts/auth-context.tsx`, `contexts/tenant-theme-context.tsx`,
  `lib/api-client.ts`; lógica de validação de nota (`movimento/page.tsx:102-131`,
  `validar/page.tsx:82-119`), gorjeta (FR-006) e fluxo de login (`login/page.tsx:47-80`).
- **NÃO regredir o mobile**: mudanças são aditivas (`lg:`/`xl:`); a base mobile permanece.
- **Tailwind v4**: customizações de tema/breakpoint via `@theme` em `app/globals.css`.
- Manter dark/light em paridade; PWA/Serwist intactos; safe-areas preservadas.

## 7. Critérios de aceite / teste

- **Viewports**: 360, 390 (mobile — **sem regressão**), 768 (tablet), 1024, 1280, 1440, 1920, 2560.
- **Desktop ≥1280px**: conteúdo aproveita a largura (container expandido), **sem desperdiçar >40%**;
  dados fiscais em ≥3 colunas; hero/ações com layout desktop; **sem scroll horizontal**.
- **Mobile (≤414px)**: idêntico ao atual (pixel-parity de comportamento) — nada quebrado.
- **Texto**: linhas 60–75 chars no desktop; tipografia escala; contraste AA (4.5:1) em dark+light.
- **Navegação**: topbar/nav desktop consistente entre `/movimento` e `/validar`; estado ativo claro.
- **Sem regressão funcional**: login, movimento (valor + status da nota + gorjeta), validação XML.
- **Dark + light** validados. Build do `frontend_motorista` passa (`next build`).

## 8. Deploy (rito de produção — operador)

Host `VPSTodo` = produção. Serviço Swarm `envio-massa-homologacao_frontend_motorista_homologacao`;
registry `registry.todo-tips.com/app-motorista-frontend`; domínio `app.motorista.moveelog.com.br`.
Build é `next build` (pesado) → **swap temporário 4G + `DOCKER_BUILDKIT=0 docker build --memory=2g`**
(lição starvation), tag específica, `docker push`, `docker service update --with-registry-auth
--image … envio-massa-homologacao_frontend_motorista_homologacao`. **Sem DDL** (só frontend).
⚠️ Conferir `ENV BACKEND_URL` do Dockerfile antes de buildar. Rollback = imagem anterior anotada via
`docker service inspect`. Smoke `app.motorista.moveelog.com.br` = 200 + validação visual nos
breakpoints. `swapoff` ao final.

## 9. Como rodar (sessão fresca)

`cwd` na raiz do repo, branch `main`. Use o prompt da seção **§10** invocando `/ui-ux-pro-max`.
Sugestão: **uma fase por vez** (Fase 1 → revisar/testar → Fase 2 → Fase 3), **1 PR por fase** para
revisão incremental. Validar por **inspeção de classes** nos viewports do §7 (mobile-first: conferir
que o mobile não regrediu). **Não buildar/deployar** até o operador autorizar (rito §8).
⚠️ **Gotcha do ciclo anterior:** nunca pôr comentário JSX `{/* */}` logo após `return (` antes do
elemento/fragment raiz — quebra o build (turbopack). Usar `//` acima do `return` ou comentário como
filho; grepar `return ($` + `{/*` antes de cada build.

## 10. Prompt para sessão fresca

```
/ui-ux-pro-max improve — Melhorar a VISÃO DESKTOP (≥1024px) do PWA do motorista em
app_homologacao/frontend_motorista (Next.js 16, React 19, Tailwind v4 @theme, shadcn/ui,
tw-animate-css, Material Symbols). O app é mobile-first; a visão desktop está negligenciada
(conteúdo travado em max-w-md, zero breakpoints). Siga o plano em
docs/plans/melhoria-ui-ux-desktop-app-motorista.md.

REGRAS DURAS:
- NÃO é re-skin: preserve o design system EntreGô 2.0 (Plus Jakarta Sans; azul #2c67ea /
  menta #2ceabc / creme #f9f2e8 / marinho #0f1849; glass, gradientes assinatura, Material
  Symbols, dark/light, branding dinâmico por tenant).
- NÃO adicione dependências (use Tailwind v4, shadcn/ui, tw-animate-css). NÃO há framer-motion.
- NÃO toque backend/hooks de dados/lógica (auth-context, tenant-theme-context, api-client,
  validação de nota, gorjeta, login).
- Mobile-first: mudanças são ADITIVAS via lg:/xl:; NÃO regredir o mobile. Sem scroll horizontal.
- Tailwind v4: breakpoint/token novo via @theme em app/globals.css, não tailwind.config.js.

EXECUTE POR FASE (1 PR por fase, revisão incremental):
- Fase 1 (fundação responsiva): D001 container responsivo (movimento/page.tsx, validar/page.tsx:
  max-w-md lg:max-w-3xl xl:max-w-5xl); D002 introduzir breakpoints; D005 gutters adaptativos
  (px-4 md:px-8 lg:px-12) no header e container; wrapper consistente entre telas.
- Fase 2 (layout desktop): D003 grid dados fiscais lg:grid-cols-3 xl:grid-cols-4
  (movimento/page.tsx); hero do valor em 2 colunas no desktop; D004 botões lado a lado +
  hierarquia; D009 login/cadastro respiro/escala (inputs h-10 lg:h-11).
- Fase 3 (polish + nav): D008 topbar/nav horizontal no desktop (sem sidebar full); D007
  tipografia/escala (hero lg:text-6xl); D006/D010 logo lg:h-9 + sticky; D011 spacing fluido;
  micro-interações/QA.

Para cada arquivo, rode /ui-ux-pro-max para as diretrizes, aplique só classes Tailwind/composição
de componentes existentes, e valide nos viewports 360/390/768/1024/1280/1440/1920/2560 em dark e
light (conferindo que o MOBILE não regrediu). Critérios de aceite na §7. NÃO buildar/deployar: ao
final de cada fase, entregue o PR e peça ao operador o deploy (rito §8: swap 4G + docker build
--memory=2g, service update do frontend_motorista, sem DDL).
```
