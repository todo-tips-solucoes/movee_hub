# Briefing — hub-uiux-refresh

> Feature individual para pipeline `/feature-00c` (short-name: `hub-uiux-refresh`).
> Refinamento de UI/UX das telas do hub de frota (`app/hub/dashboard/*`) rumo ao
> padrão visual das referências aprovadas pelo operador (2026-08-05).

## 1. Problema

As telas do hub estão funcionais mas com experiência visual pesada (print de
referência do estado atual: `arquivos_complementares/print_exemplo_hub.png`):

- **Linhas de divisão muito marcadas** — tabelas com `border-b` visível em toda
  linha, cards delimitados por borda dura (`--border` no dark = `#283566`, muito
  contrastado), filtros dentro de caixas com contorno forte.
- **Sidebar fixa** (`w-60`, sem colapso) — rouba espaço horizontal de telas
  densas (Performance tem 11 colunas de tabela).
- **Topbar cru** — só Wordmark + EntitySwitcher + AccountMenu; sem theme toggle
  (o componente `components/theme-toggle.tsx` existe e é usado no painel legado,
  mas não no hub).
- **Hierarquia visual fraca** — KPI cards, filtros e tabela têm o mesmo peso
  visual; tudo compete pela atenção.

## 2. Referências visuais (aprovadas pelo operador)

Arquivos em `arquivos_complementares/`:

| Arquivo | O que extrair |
|---|---|
| `print_exemplo_hub.png` | Estado ATUAL (tela Performance) — baseline do problema |
| `referencia1.png` | Lista/tabela: fundo claro neutro, cards flutuando com sombra suave SEM borda, linhas de tabela separadas por divisor sutil (~1px em cinza claríssimo), avatar+nome+email na célula, badges de status pill coloridos suaves, toolbar de busca+filtros num card próprio, toggle "Table View / Card View" |
| `referencia2.png` | Dashboard: hero de boas-vindas com gradiente, KPI cards (label muted pequeno em cima + valor grande + ícone à direita + delta/mini-barra embaixo), colunas de conteúdo (atividades recentes / ranking) |
| `referencia3.png` | Página de ações: KPI row + grade de botões de ação grandes; sidebar clara com item ativo em pill suave com borda fina |

Elementos comuns às 3 referências: **sidebar colapsável** (botão de colapso no
topbar, canto esquerdo), topbar com busca global + theme toggle + sino + avatar,
superfícies `bg-card` com `shadow-sm/md` suaves e **sem borda dura**, densidade
confortável, cantos arredondados generosos.

## 3. Estado atual do código (mapeado 2026-08-05)

- **Chrome do hub**: `app/hub/dashboard/layout.tsx` (header sticky descontando
  `--env-badge-h`; sidebar via `<ModuleNav/>`) + `components/hub/module-nav.tsx`
  (sidebar `w-60` fixa ≥lg; Sheet drawer <lg; 100% data-driven de
  `HubAuthProvider.modulos` — **nenhum item hardcoded, FR-001/SC-001 do
  hub-shell continua valendo**).
- **Design system**: `app/globals.css` — tokens EntreGô (light creme + dark
  navy), tokens `--sidebar-*`, `@custom-variant dark`, utilitários (`.glass`,
  `.skeleton`, animações com `prefers-reduced-motion`). **White-label**:
  `contexts/tenant-theme-context.tsx` sobrescreve `--primary/--ring/
  --sidebar-primary/--accent/--sidebar-accent` em runtime — os ajustes NÃO
  podem hardcodear cor que impeça esse override.
- **Tema**: `ThemeProvider attribute="class" defaultTheme="dark"
  enableSystem={false}` em `app/layout.tsx`; `components/theme-toggle.tsx`
  pronto (usado só no painel legado).
- **Primitives**: `components/ui/{table,card,sheet,select,dialog,...}.tsx`
  (shadcn sobre **Base UI — não Radix**; gotcha: `Select` exige `items` no
  Root). `TableRow` hoje = `border-b` em toda linha; `Card` com borda.
- **Componentes hub**: `page-header.tsx`, `status-badge.tsx`, `empty-state.tsx`,
  `table-skeleton.tsx`, `bar-chart.tsx`, `entity-switcher.tsx`,
  `account-menu.tsx`, `env-badge.tsx` (sticky global, expõe `--env-badge-h`).
- **Telas** (`app/hub/dashboard/`): `page.tsx` (home de módulos),
  `performance/` (638 l), `usuarios/` (+`papeis/`), `faturamento/` (634 l),
  `motoristas/` (+`[id]/`), `importacoes/` (+`[id]/`), `auditoria/`,
  `envio_massa/`, `admin/`, `perfil/`.
- **Testes**: vitest jsdom colado nas telas (`page.test.tsx`,
  `module-nav.test.tsx`…); E2E Playwright via drivers `infra/hub/testes/*.sh`
  (container oficial — nunca instalar browser no host).

## 4. Direção de design (consolidada com ui-ux-pro-max)

Consulta `--design-system` (query "fleet management admin dashboard clean light
data-dense", density 8, motion 3) → estilo **Data-Dense Dashboard**, motion
sutil (fade 300–400ms, y ≤ 16px), anti-patterns: ornamento, ausência de filtro.
Decisões adaptadas ao contexto (o que a skill sugerir na execução NÃO
sobrepõe estes pontos):

1. **Tipografia permanece Plus Jakarta Sans** — mandato do Guia de Marca
   EntreGô 2.0 (a sugestão Fira Code/Fira Sans da skill fica descartada).
2. **Paleta permanece a do design system EntreGô** (tokens existentes +
   white-label). O refresh mexe em *pesos e superfícies*, não em identidade:
   - `--border` do dark suavizado (hoje `#283566` grita; alvo ≈ mistura de
     `--card` com foreground a ~10–14%; validar contraste não-textual).
   - Cards: `border` → `shadow-sm`/`shadow-md` suaves (dark: sombra escura +
     `ring-1 ring-white/5` sutil para não "sumir" no fundo).
   - Tabelas: header `bg-muted/40` sem borda pesada; linhas com divisor a
     `border-border/50` (ou zebra sutil) + `hover:bg-muted/50` mantido.
3. **Light mode como cidadão de primeira classe** (as referências são claras),
   mantendo dark como default atual — o usuário escolhe pelo toggle. Ambos os
   temas precisam passar em contraste AA (4.5:1 texto; 3:1 não-textual).
4. **Motion**: reusar utilitários existentes (`animate-fade-up`, `.stagger`);
   150–300ms; `prefers-reduced-motion` já coberto em globals.css — manter.

## 5. Escopo funcional (FRs de partida para o specify)

### FR-A — Sidebar colapsável (desktop ≥ lg)
- Botão de colapso no topbar (ícone painel, como nas referências), à esquerda
  do Wordmark.
- Estados: expandida (`w-60`, ícone+rótulo) ↔ colapsada (~`w-16`, só ícone
  centralizado + tooltip com o nome do módulo no hover/focus).
- Persistência da preferência (localStorage ou cookie) sobrevivendo a reload e
  navegação; sem flash de estado errado (ler antes do paint ou aceitar default
  expandida + transição suave).
- Transição de largura 200–300ms; conteúdo principal reflui.
- Mobile (<lg) permanece com o Sheet drawer atual — sem mudança de comportamento.
- Acessibilidade: `aria-expanded`/`aria-label` no botão; itens colapsados
  continuam alcançáveis por teclado com tooltip visível no focus.

### FR-B — Topbar do hub
- Incluir `ThemeToggle` (reuso do componente existente) no grupo à direita.
- Botão de colapso da sidebar (FR-A) à esquerda.
- Manter EntitySwitcher + AccountMenu; altura/espaçamento alinhados às
  referências (topbar ~56–64px, itens com respiro).
- (Opcional, decidir no clarify) busca global central — só se houver endpoint
  aproveitável; NÃO criar backend novo para isso.

### FR-C — Suavização de superfícies (tokens + primitives)
- Ajustes em `globals.css` (tokens de borda/sombra, dark e light) e nos
  primitives `ui/table.tsx`, `ui/card.tsx` — ganho automático em todas as telas.
- Tabelas: linhas menos marcadas (divisor sutil), header destacado por fundo,
  não por borda; densidade de célula levemente maior que a atual (`py-2.5~3`).
- Cards: sombra suave no lugar de borda; raio existente (`--radius`) mantido.
- Nada de borda dupla (card com borda + tabela com borda dentro).

### FR-D — Padrões de página (componentes compartilhados)
- **KPI card** padrão (novo componente `components/hub/stat-card.tsx` ou
  evolução do que existir): label muted pequeno + valor grande + ícone à
  direita + slot opcional de delta/tendência — layout das referências 2/3.
- **Toolbar de filtros** em card próprio suave (busca + selects + limpar),
  padrão único para todas as listas.
- `PageHeader` mantido como está (título + subtítulo + ação à direita) —
  auditar consistência de uso em todas as telas.
- `StatusBadge`: conferir estilo pill suave (fundo a ~10–15% da cor semântica +
  texto AA) nos dois temas.

### FR-E — Aplicação tela a tela
Aplicar FR-C/FR-D em TODAS as telas autenticadas, sem mudar comportamento nem
contratos de dados: home (`page.tsx`), performance, faturamento, motoristas
(lista + detalhe), importações (lista + detalhe), envio_massa, usuários
(+papéis), auditoria, admin, perfil. Dialogs/wizards (`import-wizard`,
`credencial-motorista-dialog`, `vinculo-motorista-dialog`, `perfil-dialog`)
herdam os primitives — só ajustar onde houver estilo local conflitante.

### Fora de escopo (explícito)
- Painel legado (`app/{login,dashboard,...}`) e app motorista — intocados.
- Backend, contratos de API, migrations — zero mudança.
- Rebrand/identidade (cores de marca, logo, tipografia).
- Busca global com backend novo.

## 6. Critérios de sucesso

- SC-1: sidebar colapsa/expande com persistência; tabela de Performance ganha
  ≥ 176px úteis com sidebar colapsada; zero regressão no drawer mobile.
- SC-2: theme toggle funcional no hub; dark e light AA (texto 4.5:1; UI 3:1) —
  verificado com axe/da ferramenta do checklist ux.
- SC-3: nenhuma tela com card "borda dura + tabela com linhas fortes";
  screenshot antes/depois por tela anexado na review.
- SC-4: suítes vitest existentes verdes (ajustadas onde assertavam classe
  visual); E2E hub (driver `hub-shell-e2e-browser.sh`) verde; `npm run build`
  ok (rito anti-starvation se no VPS: swap ativa + `--memory=2g`).
- SC-5: white-label preservado — smoke com tenant de branding custom
  confirmando que `--primary/--accent` sobrescritos continuam refletindo.
- SC-6: navegação data-driven intacta (FR-001 do hub-shell): módulos continuam
  vindo de `/me`, nada hardcoded.

## 7. Restrições e gotchas obrigatórios (para o plan/tasks)

1. **Base UI, não Radix** — `Select` exige `items` no Root; `SheetTrigger`/
   `SheetClose` usam prop `render`.
2. **Turbopack**: comentário JSX `{/* */}` logo após `return (` quebra build —
   usar `//` acima do return; grepar antes de buildar.
3. **`--env-badge-h`**: header e sidebar sticky descontam a altura do EnvBadge —
   qualquer mudança no chrome precisa manter esse desconto.
4. **Tenant theme**: só variar cor via tokens CSS já sobrescritíveis; nunca
   hex direto em componente para cores de marca.
5. **Sidebar data-driven**: colapso não pode introduzir item estático.
6. **E2E sempre via drivers** `infra/hub/testes/*.sh` (container Playwright
   oficial); validação manual no hub-homolog `https://localhost:8443/hub/login`
   (QA: `qa.importacoes@moveelog.local` / empresa 9001).
7. **Produção intocada** — feature é 100% frontend_v2; entrega termina em
   branch + PR; deploy é do operador (rito 5 gates).
8. Testes jsdom existentes assertam estrutura das telas — rodar `npm test`
   após cada fase, não só no fim.

## 8. Faseamento sugerido (insumo para create-tasks)

| Fase | Conteúdo | Depende de |
|---|---|---|
| F1 | Tokens + primitives (FR-C): globals.css, `ui/table.tsx`, `ui/card.tsx` | — |
| F2 | Shell (FR-A + FR-B): sidebar colapsável, topbar com toggle | F1 |
| F3 | Componentes de padrão (FR-D): stat-card, filter toolbar, badge audit | F1 |
| F4 | Aplicação tela a tela (FR-E), em lotes (listas → detalhes → dialogs) | F2, F3 |
| F5 | QA: dark/light AA, white-label smoke, vitest + E2E + build, screenshots antes/depois | F4 |

## 9. Validação de execução

- Unit: `cd app_homologacao/frontend_v2 && npm test`
- Build: `npm run build` (rito anti-starvation no VPS)
- E2E: `infra/hub/testes/hub-shell-e2e-browser.sh`
- Visual: hub-homolog local + screenshots por tela (medir no DOM com
  `getComputedStyle`/`scrollWidth`, não a olho — lição do fix hub-chrome)
