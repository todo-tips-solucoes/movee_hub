# Plano de melhoria UX/UI — Hub de Frota (EntreGô)

> Elaborado em 2026-07-11 a partir de auditoria completa das 16 telas do hub
> (`app_homologacao/frontend_v2/app/hub/**`) com a metodologia da skill
> ui-ux-pro-max (design system "Data-Dense Dashboard", checklists WCAG AA).
> Escopo: **apenas frontend do hub** — sem DDL, sem mudança de API, sem deploy.

---

## 1. Contexto e diagnóstico geral

**Stack**: Next.js App Router · Tailwind v4 · tokens shadcn (`components/ui/`) ·
`lucide-react` · `sonner` (toast) · Base UI (Select/Dialog/Sheet) · white-label
via `TenantThemeProvider` (nunca hardcodar cor que impeça o override).

**Identidade EntreGô**: azul `#2C67EA` (primary) · marinho `#0F1849` · menta
`#2CEABC` (accent) · amarelo `#FFB72A` · fundo creme `#F9F2E8` · Plus Jakarta Sans.

**O que já está bom (preservar como referência)**:
- Disciplina de tokens: praticamente zero hex cru nas telas; paleta de sidebar isolada.
- Acessibilidade acima da média: `main`/`h1` por tela, `role="alert|status"`,
  `aria-live`, `aria-current`, touch targets 44px, dropzone do wizard exemplar.
- Empty state da home (`dashboard/page.tsx:61-77`) e item ativo do `ModuleNav`
  (barra + cor + `aria-current`) são os padrões-modelo do produto.
- `AlertDialog` de desvínculo de motorista (`motoristas/[id]:373-395`) é o
  modelo de confirmação destrutiva.
- Tratamento de 409 no wizard com link para a importação original.

**Os 7 problemas sistêmicos** (cada um se repete em 3+ telas):

| # | Problema | Impacto | Telas afetadas |
|---|----------|---------|----------------|
| P1 | Badges de status **só com cor** (sem ícone) — WCAG 1.4.1 | CRÍTICO | importações lista/detalhe, motoristas lista/detalhe |
| P2 | **Silêncio após sucesso** — sonner instalado mas só envio_massa usa toast | ALTO | usuários, papéis, admin, faturamento, performance, importações, motoristas, wizard, vínculo |
| P3 | Loading por **spinner** (`RotateCw`) em vez de skeleton — só envio_massa tem skeleton | ALTO | todas as listas e detalhes |
| P4 | `amber-*` **hardcoded** por falta de token `--warning` | MÉDIO | papéis:118, importações/[id]:253, vinculo-dialog:183/313 |
| P5 | Sidebar com **todos os módulos no mesmo ícone** (`LayoutGrid`) — `Modulo.icone` chega `null` e o fallback não usa o `codigo` | ALTO | navegação inteira |
| P6 | Ações de **alto impacto sem confirmação** (cancelar importação, desabilitar módulo) | ALTO | importações/[id]:281, admin:173-180 |
| P7 | Tipografia de título divergente: `font-display` (login, envio_massa) vs `font-heading` (demais) | MÉDIO | transversal |

---

## 2. Design system — ajustes de fundação

### 2.1 Tokens novos em `app/globals.css`

Aproveitar o **amarelo da marca `#FFB72A`** como warning (já é `--chart-4`):

```css
:root {
  --warning: #b45309;             /* amber-700 — texto/ícone em fundo claro */
  --warning-foreground: #431407;
  --warning-soft: #ffb72a1a;      /* fundo 10% do amarelo EntreGô */
  --warning-border: #ffb72a4d;
}
.dark {
  --warning: #fbbf24;
  --warning-soft: #ffb72a14;
  --warning-border: #ffb72a33;
}
```

E expor no `@theme inline` (`--color-warning`, etc.). O token `--success` já
existe (usado em envio_massa) — só padronizar o uso.

### 2.2 Variantes semânticas no `Badge`

`ui/badge.tsx` já suporta ícone inline (`has-data-[icon=inline-start]`), mas não
tem variantes `success`/`warning`. Adicionar:

- `success` → `border-success/30 bg-success/10 text-success`
- `warning` → `border-warning-border bg-warning-soft text-warning`
- `destructive-soft` → `border-destructive/30 bg-destructive/10 text-destructive`

### 2.3 Tipografia

Unificar títulos de página em **uma** utility (`font-heading`); reservar
`font-display` apenas para a Wordmark/telas de marketing (login). Corrigir
`envio_massa/page.tsx:178` (`font-display` → `font-heading`).

### 2.4 Primitivos shadcn faltantes

Adicionar a `components/ui/`: **`skeleton.tsx`**, **`switch.tsx`** (para o
toggle de módulo do admin) e opcionalmente `breadcrumb.tsx`. `command.tsx` já
existe (usar no combobox de entidade do admin).

---

## 3. Componentes compartilhados novos (`components/hub/`)

| Componente | Substitui | Especificação |
|------------|-----------|---------------|
| **`status-badge.tsx`** | `StatusBadge` local (importações:159), `AtivoBadge`/`VinculoBadge` (motoristas:100-108) | Badge com **cor + ícone lucide + label**, mapeado por domínio (ver §5.2). Nunca só cor. |
| **`page-header.tsx`** | headers duplicados/divergentes | `h1 font-heading` + subtítulo `text-muted-foreground` + slot de ação à direita. Todas as telas passam a ter subtítulo (envio_massa hoje não tem). |
| **`table-skeleton.tsx`** | spinners `RotateCw` de loading | Generalização do `EnvioMassaSkeleton` (envio_massa:59-89): N linhas fantasma + cabeçalho, shape estável (CLS ≈ 0). Variante `kpi-skeleton` para os cards de faturamento/performance. |
| **`empty-state.tsx`** | blocos ad-hoc por tela | Padrão da home (ícone em círculo, borda tracejada, mensagem + **ação opcional**). Empty de importações ganha botão "Nova importação" que abre o wizard. |
| **`account-menu.tsx`** | link "Meu perfil" solto no header | `DropdownMenu` no header: avatar com inicial (fundo `bg-primary/10 text-primary`), nome/email truncados, itens **Meu perfil**, **Trocar senha** e **Sair** (`LogOut`, separado e em `text-destructive`). Resolve logout inacessível fora do perfil. |
| **`data-table-wrapper`** (ou patch em `ui/table.tsx`) | wrappers manuais de overflow | Container com `overflow-x-auto` por padrão; cabeçalhos com `scope="col"` e suporte futuro a `aria-sort`. |

Migrar também todos os `<select>` nativos (usuarios:179/336/365, faturamento:353)
para o `Select` do design system — corrige estilo, foco e touch target (o
select do dialog de edição hoje tem ~32px).

---

## 4. Modais — o que entra, o que sai, o que se confirma

### 4.1 Novos modais/diálogos (entrar em modal)

| Ação | Hoje | Proposta | Justificativa |
|------|------|----------|---------------|
| **Cancelar importação** (`importacoes/[id]:281`) | dispara direto | `AlertDialog` "Cancelar importação?" com consequência explícita + botão destrutivo com loader | Ação irreversível sem confirmação; espelhar o modelo do desvínculo de motorista |
| **Reprocessar importação** | dispara direto | `AlertDialog` leve (ou manter direto + toast com "Desfazer" se a API permitir) | Médio impacto |
| **Habilitar/desabilitar módulo** (`admin:173-180`) | botão ambíguo que mostra estado | `Switch` com label + `AlertDialog` ao **desabilitar** ("usuários desta entidade perdem acesso imediatamente") | Alto impacto; o botão atual não diz se o clique habilita ou desabilita |
| **Buscar entidade no admin** (`admin:118-133`) | input numérico de ID decorado | Combobox `Command` em popover/modal: digita ID, mostra últimas entidades consultadas (localStorage) | Admin não deveria decorar IDs |
| **Conta do usuário** | página `/perfil` inteira | `DropdownMenu` no header (§3) — a página `/perfil` pode permanecer como destino de "Meu perfil", mas as 2 ações rápidas (trocar senha, sair) ficam a 1 clique de qualquer tela | Página inteira para 2 ações é navegação desnecessária |

### 4.2 Modais que devem DEIXAR de ser modal

| Hoje | Problema | Proposta |
|------|----------|----------|
| **`EditarUsuarioDialog`** (usuarios:220-403) | Dialog gigante com `max-h-[60vh] overflow-y-auto` gerenciando dados + vínculos + papéis | Migrar para **`Sheet` lateral largo** (padrão já validado no detalhe de auditoria) ou página `/hub/dashboard/usuarios/[id]`. Sheet é o caminho de menor atrito. |

### 4.3 Manter como está (decisões corretas já tomadas)

- Detalhe de auditoria em `Sheet` lateral — manter (leitura de payload).
- `CriarUsuarioDialog` — form curto, cabe em Dialog.
- `ImportWizard` e `VinculoMotoristaDialog` em Dialog — manter, com os ajustes:
  - vínculo: indicador **"Passo 1 de 2 / 2 de 2"** no header do dialog;
  - wizard: confirmar descarte apenas se houver arquivo selecionado
    (senão Escape fecha direto);
  - ambos: `toast.success` ao concluir.
- Recuperar/redefinir senha como **páginas** (deep-link por e-mail) — nunca modal.
- Detalhes de importação/motorista como **páginas** (volume de dados + polling).
  Opcional fase 4: quick-peek em `Sheet` a partir da lista.

---

## 5. Ícones — mapa definitivo (lucide-react)

### 5.1 Correção estrutural da sidebar (P5)

`resolveModuleIcon` (`lib/hub/module-nav.ts`) recebe `icone` que hoje chega
`null` → tudo vira `LayoutGrid`. **Fallback em cascata**: `icone` explícito →
mapa por `codigo` → `LayoutGrid`. O `ICON_MAP` já existe; é ligar o fio.

### 5.2 Mapa por módulo (sidebar + home + PageHeader)

| Módulo | Ícone | Por quê |
|--------|-------|---------|
| Dashboard | `LayoutDashboard` | canônico, distinto do fallback `LayoutGrid` |
| Motoristas | `Truck` | já usado no empty; identidade de frota |
| Importações | `FileUp` | upload de arquivo — mais específico que `Upload` |
| Envio em Massa | `Send` | disparo/mensageria |
| Faturamento | `Receipt` | já usado no KPI; manter |
| Performance | `Gauge` | "medidor" comunica desempenho melhor que `TrendingUp` (que fica nos KPIs) |
| Usuários | `Users` | canônico |
| Papéis/Permissões | `ShieldCheck` | segurança/autorização |
| Auditoria | `ScrollText` | trilha/registro (diferencia de papéis, que fica com shield) |
| Admin | `Settings2` | já usado; manter |
| Perfil/Conta | `CircleUser` | mais forte que `User` solto no header |

### 5.3 Mapa por status (usar no `status-badge.tsx`)

| Status | Ícone | Variante |
|--------|-------|----------|
| Concluída | `CheckCircle2` | `success` |
| Concluída com erros | `AlertTriangle` | `warning` (**hoje é `outline`, igual a pendente — corrigir**) |
| Falhou | `XCircle` | `destructive-soft` |
| Processando | `RotateCw` c/ `animate-spin` (respeitar `prefers-reduced-motion`) | `default` |
| Pendente | `Clock` | `outline` |
| Cancelada | `Ban` | `secondary` |
| Ativo / Inativo | `CheckCircle2` / `CircleOff` | `success` / `secondary` |
| Vinculado / Sem vínculo | `Link2` / `Link2Off` | `default` / `outline` (hoje Vinculado e Ativo usam o mesmo azul lado a lado) |

### 5.4 Correções pontuais de ícone

- `importacoes/page.tsx:364` — link "Detalhes" usa **`UploadIcon` (errado)** → `ChevronRight` (padrão das outras listas).
- `entity-switcher` — adicionar `Building2` no trigger.
- Toggle de módulo no admin — `Power` (ou nenhum, se virar `Switch`).
- Botões de export (faturamento/performance) — já têm `Download`; adicionar `Loader2` no estado exportando (hoje só muda o texto).
- Regra geral: todo botão async troca o ícone por `Loader2 animate-spin` (padrão já usado no vinculo-dialog; os dialogs de usuários só trocam texto).

---

## 6. Backlog por fase

### Fase 1 — Quick wins (baixo risco, alto retorno; ~1 entrada de trabalho)

1. Fallback de ícone por `codigo` na sidebar (§5.1). *(1 linha + teste)*
2. Ícone do link "Detalhes" de importações → `ChevronRight`.
3. Tokens `--warning*` + variantes de Badge; substituir `amber-*` nos 3 pontos (P4).
4. `toast.success`/`toast.error` (sonner) em: wizard, vínculo/desvínculo, salvar
   motorista, criar/editar usuário, toggle papel×permissão, toggle módulo,
   reprocessar/cancelar importação, export CSV (P2).
5. `AlertDialog` no "Cancelar importação" (P6a).
6. Retry no erro de tela cheia dos detalhes (`importacoes/[id]:192`,
   `motoristas/[id]:206`) — as listas já têm.
7. Unificar `font-heading` (P7) e `min-h-11` nos botões/paginação de usuários.
8. Separador de milhar pt-BR nos contadores de performance (`:445-450`).

### Fase 2 — Componentes compartilhados (fundação)

9. `status-badge.tsx` com mapa §5.3 e adoção nas 4 telas (P1 — WCAG).
10. `ui/skeleton.tsx` + `table-skeleton.tsx`/`kpi-skeleton` e troca dos spinners (P3).
11. `page-header.tsx` e adoção nas 12 telas do dashboard.
12. `empty-state.tsx` com ação (importações → abre wizard).
13. `account-menu.tsx` no header + Wordmark no shell (marca hoje só existe no login).
14. Header do shell `sticky top-0` + `backdrop-blur`.

### Fase 3 — Telas específicas

15. Usuários: `EditarUsuarioDialog` → `Sheet`; selects nativos → `Select` DS;
    validação inline por campo (erro perto do campo, foco no primeiro inválido).
16. Admin: `Switch` + confirmação no toggle; combobox de entidade com histórico.
17. Vínculo: indicador de passos; wizard: confirmação de descarte com arquivo.
18. Linha inteira clicável nas tabelas desktop (affordance hoje enganosa:
    hover sugere clique mas só o link navega); unificar card mobile
    (motoristas tem `focus-visible:ring`, importações não).
19. Toggle mostrar/ocultar senha em redefinir-senha (existe só no login);
    tratamento visual (glass + orbs + Wordmark) nas 3 telas de auth.
20. EntitySwitcher: `Building2`, spinner durante troca, toast de confirmação.

### Fase 4 — Dataviz e refinamento (opcional, pós-cutover)

21. Faturamento: barras por categoria/período; Performance: tendência das taxas
    (paleta `--chart-*`, tooltips, legenda, alternativa textual, formatação pt-BR).
22. Ordenação de colunas com `aria-sort` nas 6 tabelas.
23. Quick-peek em `Sheet` nas listas de importações/motoristas.
24. `prefers-reduced-motion` no fade do envio_massa e nos `animate-spin`.

---

## 7. Critérios de aceite (checklist de PR)

- [ ] Nenhum status distinguível apenas por cor (ícone + texto sempre).
- [ ] Toda mutação bem-sucedida emite toast; toda destrutiva confirma antes.
- [ ] Nenhum `amber-*`/hex cru fora de `globals.css`; white-label continua
      funcionando (tokens sobrescritos pelo `TenantThemeProvider`).
- [ ] Loading de lista/KPI = skeleton com shape estável (CLS < 0.1).
- [ ] Sidebar com ícone distinto por módulo; `aria-current` preservado.
- [ ] Logout alcançável de qualquer tela em ≤ 2 cliques.
- [ ] Touch targets ≥ 44px em mobile (inclusive selects em dialogs).
- [ ] `pnpm test` (suites `page.test.tsx` existentes) verde; a11y-smoke
      (`infra/hub/testes/hub-*-a11y-smoke.sh`) verde.
- [ ] Testado em 375px, dark mode e com `prefers-reduced-motion`.

## 8. Riscos e observações

- **G3 (cutover) está agendado**: nada deste plano entra nas imagens `hub-g3-1`.
  Executar em branch própria (`feat/uiux-hub-fase1` …) **após** o cutover, ou
  claramente separado dele.
- Fase 1 e 2 não mudam contrato de API nem schema — só frontend.
- `EditarUsuarioDialog` → Sheet muda testes existentes (`usuarios/page.test.tsx`);
  prever ajuste de testes na estimativa.
- O rótulo "Empresa #id — papel" do EntitySwitcher é limitação do `/me`
  (sem nome amigável) — fora de escopo aqui; registrar como follow-up de API.
