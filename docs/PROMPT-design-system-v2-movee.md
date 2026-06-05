# Prompt — Portar o design system Movee (AppMotorista) para o painel EnvioMassa v2

> Cole este prompt numa sessão fresca do Claude Code (no repo movee_hub) para iniciar o redesign.
> **Use a skill `/ui-ux-pro-max`** para planejar e construir o trabalho.

---

## Contexto do projeto
Você é o Claude Code no repo **movee_hub** (homologação), em `/var/lib/envioMassa_homologacao`
(use worktree para alterações). Responda sempre em **português**. Conventional commits,
terminando com `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

**Invoque a skill `/ui-ux-pro-max`** para conduzir o redesign (inventário, plano de tokens,
plano de background, aplicação página a página).

## Objetivo
Aplicar o **design system Movee** — hoje implementado no `frontend_motorista` (PWA do motorista) —
a **TODAS as páginas e componentes** do `frontend_v2` (painel **EnvioMassa**, "envmass2"),
**incluindo o tratamento de background** (gradiente quente / superfícies glass) e os painéis de
**Aparência** e **Grupo**. Somente mudanças visuais/de estilo — **nenhuma** alteração de
lógica/negócio/rotas/contratos.

## Fonte do design system (NÃO inventar — copiar destes arquivos)
- `app_homologacao/frontend_motorista/app/globals.css` (≈367 linhas): tokens, gradiente, glass,
  animações, bloco `@theme inline`.
  - **Light:** `--background:#ffffff`, `--foreground:#0e1a2b`, `--primary:#1f63eb` (azul royal),
    `--secondary:#eaf1fe`, `--muted:#f2f5fb`, `--accent:#eaf1fe`, `--success:#16a375` (menta),
    `--destructive:#ee3b26`, `--border:#e3e9f4`, `--ring:#1f63eb`, `--radius:0.875rem`.
  - **Dark:** `--background:#0b1220`, `--foreground:#e6ecf6`, `--primary:#4f8bff`,
    `--success:#2bbf92`, `--destructive:#ff5a43`, `--border:#243352`, etc.
  - **Gradiente quente assinatura Movee:** `#FFC020 → #FF7A18 → #F23A20` (warm-1/2/3).
    **É o "background" pedido** — usar nas superfícies/heros de destaque.
  - Glassmorfismo (`backdrop-filter`), skeleton shimmer, stagger animations.
- `app_homologacao/frontend_motorista/app/layout.tsx`: fontes via `next/font/google` —
  **Inter** (`--font-inter`, corpo), **Poppins** (`--font-poppins`, display/títulos),
  **JetBrains Mono** (`--font-jetbrains`, mono).

## Alvo — `frontend_v2` (TODAS as páginas e componentes)
**Páginas/layouts:** `app/page.tsx`, `app/login/page.tsx`, `app/register/page.tsx`,
`app/dashboard/page.tsx`, `app/dashboard/validacao-xml/page.tsx`,
`app/dashboard/configuracoes/aparencia/page.tsx`, `app/dashboard/configuracoes/grupo/page.tsx`,
`app/layout.tsx`, `app/dashboard/layout.tsx`.
**Componentes:** `header`, `stats-cards`, `action-bar`, `filters`, `data-table`,
`pagination-controls`, `process-controls`, `import-button`, `xml-validation-card`,
`close-movement-dialog`, `edit-dialog`, `delete-dialog`, `theme-toggle`; e os primitives shadcn em
`components/ui/*` (button, card, dialog, table, input, select, badge, checkbox, dropdown, etc.).
> Hoje o v2 usa a fonte **Geist** e um `globals.css` de ≈150 linhas (tokens shadcn neutros).

## RESTRIÇÕES CRÍTICAS (não quebrar)
1. **White-label / TenantThemeProvider** — `frontend_v2/contexts/tenant-theme-context.tsx` injeta em
   runtime, no `:root`, as CSS vars: `--primary`, `--ring`, `--sidebar-primary`, `--accent`,
   `--sidebar-accent` (a partir da branding do grupo, convertendo HEX→oklch).
   - Os valores Movee viram os **DEFAULTS** no `globals.css`; a branding do tenant **continua
     sobrescrevendo** em runtime. NÃO hardcode de forma que impeça o override.
   - **Alinhe o `MOVEE_DEFAULTS`** (no `tenant-theme-context.tsx`): hoje está laranja
     (`#E97316`/`#F59E0B`); deve refletir a identidade Movee real — **primária azul `#1F63EB`** e
     destaque vindo do **gradiente quente**. Garanta consistência entre o fallback do provider e os
     defaults do CSS.
2. **Dark/light (next-themes)** deve continuar funcionando (`ThemeProvider attribute="class"`).
   Fornecer tokens **light E dark** (como no motorista).
3. **`@theme inline`**: mapear os tokens para utilitárias Tailwind 4 (`--color-*`), como no motorista,
   para `bg-primary`, `text-foreground`, etc. seguirem funcionando.
4. **Fontes**: trocar Geist por **Inter + Poppins + JetBrains** via `next/font/google` no
   `app/layout.tsx` (variáveis `--font-inter`/`--font-poppins`/`--font-jetbrains`); aplicar
   `font-display` (Poppins) nos títulos.
5. **NENHUMA** mudança de lógica/dados/rotas/contratos — só classes, estilos, tokens, fontes,
   backgrounds e microinterações.
6. **Acessibilidade**: manter contraste; respeitar o warning de contraste já existente no provider.

## Tratamento de background (pedido explícito)
Aplicar o background Movee em **todas** as páginas: superfície base (light `#ffffff` / dark `#0b1220`)
+ uso do **gradiente quente assinatura** em pontos de destaque (heros de `login`/`register`, headers de
seção, cards de ação, cabeçalho do dashboard), e **superfícies glass** (`backdrop-filter`) onde fizer
sentido. `login` e `register` devem ganhar o tratamento "hero" com gradiente, no espírito do PWA.

## Fluxo de trabalho sugerido
1. **`/ui-ux-pro-max`**: revisar o design system do motorista e planejar a aplicação no v2
   (inventário de páginas/componentes, mapa de tokens, plano de background/heros).
2. Portar `globals.css` (tokens light/dark + `@theme` + gradiente + glass + animações) e as fontes no
   `app/layout.tsx`.
3. Refatorar **página a página + componente a componente**, aplicando tokens/classes Movee e
   backgrounds. Cobrir **todas** as páginas, incluindo `aparencia` e `grupo`.
4. Garantir o white-label: sem branding → painel com identidade Movee; com branding → cores do tenant
   sobrescrevem em runtime.
5. `cd app_homologacao/frontend_v2 && npm run build` — corrigir qualquer erro de type/lint.
6. Deploy (swarm aditivo) + validar no ar.

## Ambiente / deploy (CRÍTICO)
- Deploy **Docker Swarm** (NÃO compose; **nunca** `docker stack deploy` do compose completo).
- **frontend_v2:** imagem `registry.todo-tips.com/envio-massa-frontend-v2:homologacao`; serviço
  `envio-massa-homologacao_frontend_v2_homologacao`; host `envmassv2.todo-tips.com` (porta interna 3000).
- **Ciclo:** `npm run build` → `docker build -t registry.todo-tips.com/envio-massa-frontend-v2:homologacao app_homologacao/frontend_v2`
  → `docker push ...` → `docker service update --with-registry-auth --force --image registry.todo-tips.com/envio-massa-frontend-v2@sha256:<digest> envio-massa-homologacao_frontend_v2_homologacao`.
  Validar com `curl` HTTP 200 nas rotas — **re-sondar após a convergência** (o rollover dá `502`/`404`
  transitório por alguns segundos).
- O **classifier** pode bloquear push/registry/swarm: se bloquear, **entregue comandos prontos**
  (prefixo `!`) ao operador.
- `.claude/` é gitignored; use `$CLAUDE_JOB_DIR/tmp` p/ temporários; commits com caracteres especiais
  via `git commit -F`.

## Critérios de aceite
- Todas as páginas e componentes do `frontend_v2` com a identidade Movee (cores, fontes
  Inter/Poppins/JetBrains, `radius`, glass, gradiente de background).
- `login` e `register` com tratamento hero/gradiente.
- Painéis de **Aparência** e **Grupo** restilizados.
- **Dark/light** funcionando; **white-label** do tenant ainda sobrescreve as cores em runtime.
- `next build` limpo; deploy no ar validado (HTTP 200).
