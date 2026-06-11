# Plano — Responsividade do header no mobile (painel envmassv2)

> **Como usar:** este é um briefing autocontido para rodar numa **sessão fresca pelo cstk**
> (rito igual aos planos anteriores). A sessão fresca deve usar a skill **`/ui-ux-pro-max`**
> para conduzir o design e a implementação. Trabalho de UI/código → fluxo normal; **deploy
> no ambiente do cliente exige RITO DE PRODUÇÃO** (ver §8).

## 1. Objetivo

No celular, a barra de navegação do topo do painel **envmassv2** fica **comprimida**: os
itens **Envio, Validação XML, Motoristas, Aparência, Grupo** espremem-se numa única linha.
Trazer responsividade para que a navegação fique legível e confortável no mobile, sem
prejudicar o desktop.

## 2. Diagnóstico (estado atual)

Arquivo: `app_homologacao/frontend_v2/components/header.tsx`

- Header de altura fixa `h-14`. À esquerda: logo (white-label do tenant) + `<nav>` horizontal.
  À direita: badge da empresa + `ThemeToggle` + botão de logout.
- A `<nav>` (`header.tsx:55`) tem 5 links, cada um com ícone (lucide) **sempre visível** e o
  rótulo em `<span className="hidden sm:inline">` — ou seja, **abaixo de 640px (`sm`) o texto
  some e sobram só os ícones**, todos espremidos numa linha junto com logo + badge + 2 botões.
- Itens **Aparência** e **Grupo** só aparecem para `user?.is_grupo_pai` (`header.tsx:92`):
  3 itens para usuário comum, **5 para o admin do grupo** (pior caso de espaço).
- Há muita repetição de `className` por link (oportunidade de extrair um array `NAV_ITEMS`).
- Branding white-label (logo do tenant com fallback EntreGô) e o gating `is_grupo_pai` **devem
  ser preservados**.

**Por que está ruim (regras `/ui-ux-pro-max`):**
- `nav-label-icon` (§9): navegação só com ícone prejudica descoberta — no mobile hoje é
  icon-only.
- `touch-density` / `touch-target-size` (§2/§5): ícones espremidos viram alvos de toque
  pequenos e próximos (< 44px, < 8px de gap) → mis-taps.
- `adaptive-navigation` (§9): em telas pequenas a navegação deveria virar menu (drawer/top),
  não uma régua horizontal apertada.
- `content-priority` (§5): no mobile, priorizar conteúdo; navegação secundária recolhe.

## 3. Decisão de design (recomendada)

**Navegação adaptativa por breakpoint** (`adaptive-navigation`, `navigation-consistency`):

- **`≥ lg` (≥1024px):** mantém a `<nav>` horizontal atual, com **ícone + rótulo** (rótulos
  passam a aparecer a partir de `lg`, não de `sm`). Confortável porque há largura para os 5
  itens + logo + badge + botões.
- **`< lg` (mobile/tablet):** esconde a nav horizontal e mostra um **botão hambúrguer**
  (`Menu` do lucide, alvo ≥44×44px, `aria-label="Abrir menu"`) que abre um **menu vertical**
  com os itens em lista — **cada item com ícone + rótulo sempre visível**, alvo ≥44px, item
  ativo destacado (`nav-state-active`).

Alternância via **classes Tailwind** (`hidden lg:flex` / `lg:hidden`), renderizando os dois
modos e deixando o CSS decidir — **sem** hook de detecção de dispositivo (evita CLS e
problemas de hidratação; não há `use-mobile` no projeto).

### Escolha do componente do menu mobile (decidir na sessão fresca)

| Opção | Como | Prós | Contras |
|---|---|---|---|
| **A — Sheet (drawer lateral) [recomendada]** | Adicionar `components/ui/sheet.tsx` (shadcn, sobre Radix Dialog — `dialog.tsx` já existe) | Mais espaço, rótulos grandes, toque confortável, animação de entrada pela borda (`modal-motion`) | Adiciona 1 componente |
| **B — DropdownMenu (mínima)** | Reusar `components/ui/dropdown-menu.tsx` (já existe) acionado pelo hambúrguer | Zero dependência nova, rápido | Menos espaço, menos "premium" |

Recomendação: **Opção A (Sheet)**. Confirmar disponibilidade do componente shadcn na sessão
fresca; se inviável, cair para **B** sem reabrir o plano.

### Itens de navegação (extrair para um array — DRY)

```
NAV_ITEMS = [
  { href: '/dashboard',                       label: 'Envio',        icon: Send,      match: 'exact' },
  { href: '/dashboard/validacao-xml',         label: 'Validação XML', icon: FileCheck },
  { href: '/dashboard/motoristas',            label: 'Motoristas',   icon: Truck },
  // só is_grupo_pai:
  { href: '/dashboard/configuracoes/aparencia', label: 'Aparência',  icon: Palette, grupoPai: true },
  { href: '/dashboard/configuracoes/grupo',     label: 'Grupo',      icon: Users,   grupoPai: true },
]
```
Renderizar a partir do array tanto no desktop (horizontal) quanto no menu mobile, aplicando o
filtro `is_grupo_pai`. Corrigir de passagem o rótulo "Validacao XML" → **"Validação XML"**.

### À direita do header (badge/tema/logout) no mobile

- Manter `ThemeToggle` e logout sempre acessíveis. No mobile, **compactar**: badge da empresa
  pode reduzir para só o avatar com iniciais (nome via tooltip), e o logout pode ficar como
  ícone no header **ou** migrar para dentro do menu mobile (separado dos itens de navegação —
  `destructive-nav-separation`). Decidir na sessão fresca priorizando não reespremer a barra.

### Acessibilidade e movimento (gates da skill)

- Botão hambúrguer: `aria-label`, `aria-expanded`, foco visível (`focus-states`).
- Fechar o menu ao navegar; permitir fechar por ESC / clique fora / swipe-down (Sheet).
- Item ativo destacado por mais que cor (peso/indicador) — `color-not-only`, `nav-state-active`.
- Respeitar `prefers-reduced-motion`; transição do menu 150–300ms (`state-transition`,
  `modal-motion`).
- Alvos ≥44×44px e gap ≥8px (`touch-target-size`, `touch-spacing`).

## 4. Escopo

**Muda:** apenas `app_homologacao/frontend_v2/components/header.tsx` (e, se Opção A,
adicionar `components/ui/sheet.tsx`). Possível ajuste cosmético do badge à direita.

**NÃO muda:** rotas, autenticação, gating `is_grupo_pai`, white-label/branding, layout do
`dashboard/layout.tsx` (o fix de scroll já está aplicado), back-end, banco. Sem nova
dependência além do componente shadcn (Opção A).

## 5. Passos de implementação (na sessão fresca)

1. Invocar `/ui-ux-pro-max` e rodar o design-system / domínios de apoio (ver §6).
2. (Opção A) adicionar `components/ui/sheet.tsx`.
3. Refatorar `header.tsx`: extrair `NAV_ITEMS`; criar componente de link reutilizável
   (estado ativo via `usePathname`); render desktop `hidden lg:flex` + menu mobile `lg:hidden`.
4. Corrigir rótulo "Validação XML".
5. Compactar bloco à direita no mobile conforme §3.
6. `npm run build` (ou `tsc --noEmit` + lint) no `frontend_v2` — verificar sem erros.
7. Revisão visual local (§7) antes de qualquer deploy.

## 6. Como usar a skill `/ui-ux-pro-max` (sessão fresca)

A skill já traz no contexto as regras necessárias (§5 Layout/Responsive, §9 Navigation, §1/§2
a11y/touch, §7 Animation). **Nota:** o classifier bloqueia executar os scripts Python da skill
(`search.py`) — conduzir pelo conhecimento das regras carregadas, não tentar rodar os scripts.
Regras-âncora a aplicar: `adaptive-navigation`, `nav-label-icon`, `nav-state-active`,
`drawer-usage`, `overflow-menu`, `mobile-first`, `breakpoint-consistency`, `touch-target-size`,
`reduced-motion`, `modal-motion`.

## 7. Critérios de aceite (revisão visual)

- **375px (celular pequeno):** sem scroll horizontal; navegação acessível via hambúrguer;
  cada item com ícone + rótulo legível; alvos ≥44px; nada escondido sob safe-area.
- **768px (tablet):** continua no modo menu (ou horizontal se a sessão decidir `md`), sem
  espremer.
- **1024px+ (desktop):** nav horizontal com ícone + rótulo, item ativo destacado, igual/melhor
  que hoje.
- **Landscape** e **dark mode:** legíveis; contraste do item ativo e divisórias OK nos dois temas.
- `is_grupo_pai` true/false: 5 vs 3 itens corretos nos dois modos.
- White-label: logo do tenant e fallback EntreGô intactos.
- Build/lint limpos.

## 8. Governança — RITO DE PRODUÇÃO ⚠️

**O painel envmassv2 é o que o cliente usa em produção** (host `VPSTodo`, serviço
`envio-massa-homologacao_frontend_v2_homologacao`). Ver `docs/RITO-PRODUCAO.md` e `CLAUDE.md`.

- Código, PR e build de imagem → **fluxo normal**.
- **Deploy** (`docker service update --image`) no serviço do cliente → **somente com os 5
  gates**: (1) autorização explícita e específica do operador, (2) janela combinada,
  (3) rollback à mão (imagem anterior anotada), (4) `docker service update --image` —
  **nunca** `stack deploy`, (5) smoke test depois. Em dúvida, **parar e devolver ao operador**.
- Mudança é **frontend-only**: sem DDL, sem backend. Rollback = voltar a imagem anterior do
  serviço de frontend.

## 9. Referências de código

- `app_homologacao/frontend_v2/components/header.tsx` — alvo principal.
- `app_homologacao/frontend_v2/app/dashboard/layout.tsx` — app-shell (scroll já resolvido).
- `app_homologacao/frontend_v2/components/ui/` — `dialog.tsx`, `dropdown-menu.tsx`,
  `popover.tsx` disponíveis; `sheet.tsx` a adicionar se Opção A.
- Padrão de paginação client-side já aplicado em `app/dashboard/motoristas/page.tsx`
  (referência de estilo/idioma do projeto).
