// hub-shell (S3) task 5.1 — chrome persistente da área autenticada do hub:
// `ModuleNav` (sidebar data-driven, task 2.2) + `EntitySwitcher` (task 3.1)
// no topo. Escopado a `/hub/dashboard/*` (não a `/hub/*` inteiro) porque as
// telas de autenticação (`/hub/login`, `/hub/recuperar-senha`,
// `/hub/redefinir-senha`) são pré-sessão e não devem exibir navegação de
// módulos nem troca de entidade — ambos os componentes já são fail-safe
// (retornam `null` sem itens/vínculos), mas o escopo correto evita montá-los
// onde não fazem sentido semântico.
//
// `EnvBadge` NÃO é remontado aqui — já é global via `app/layout.tsx` (task
// 2.1, Fase 2), presente em toda tela da aplicação (shell e legado).
//
// Aplica-se também a `/hub/dashboard/perfil` (já shipped, Fase 4) e às
// futuras `/hub/dashboard/<codigo>` (módulos S4+) sem exigir mudança nelas —
// só passam a renderizar dentro deste chrome.
//
// Ref: docs/specs/hub-shell/plan.md §3.2/§3.4.

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ModuleNav } from '@/components/hub/module-nav';
import { SidebarCollapseToggle } from '@/components/hub/sidebar-collapse-toggle';
import { EntitySwitcher } from '@/components/hub/entity-switcher';
import { AccountMenu } from '@/components/hub/account-menu';
import { ThemeToggle } from '@/components/theme-toggle';
import { Wordmark } from '@/components/brand/wordmark';
import { TituloDaRota } from '@/components/hub/titulo-da-rota';

export default function HubDashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col lg:flex-row">
      <TituloDaRota />
      {/* impeccable rodada 8 (P2): eram 14 Tab fixos de pedágio até o conteúdo,
          medidos em 12 de 13 rotas, sem nenhuma saída — e em /usuarios/papeis,
          que é somente leitura para admin_entidade, o percurso de foco não
          alcançava o conteúdo de jeito nenhum (todos os controles de lá são
          desabilitados por RBAC). Primeiro elemento tabulável da página,
          invisível até receber foco. */}
      <a
        href="#conteudo-principal"
        className="sr-only left-4 top-4 z-50 rounded-md bg-card px-4 py-2 text-sm font-medium text-foreground shadow-lg ring-2 ring-ring focus:not-sr-only focus:absolute"
      >
        Pular para o conteúdo
      </a>
      {/* < lg: agrupa o hamburger do ModuleNav numa faixa com borda, em vez de
          deixá-lo "solto" no topo — mesmo tom visual do header que segue. */}
      <div className="border-b border-sidebar-border lg:contents">
        <ModuleNav />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {/* uiux-hub F2: sticky (EntitySwitcher/conta sempre à mão em telas
            longas) + Wordmark à esquerda — a marca antes só existia no login.
            `top` = altura do EnvBadge (também sticky em top-0, z maior): sem
            isso os dois disputam o topo e o header fica atrás do badge.
            Fundo opaco: com `bg-card/80 + backdrop-blur` o conteúdo passava
            borrado por trás do header e lia como interface quebrada. */}
        <header className="sticky top-[var(--env-badge-h,0px)] z-40 flex flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-4 py-2">
          <div className="flex items-center gap-1">
            {/* task 2.2.1 — botão de colapso, só na sidebar >= lg (FR-005) */}
            <SidebarCollapseToggle />
            <Link
              href="/hub/dashboard"
              aria-label="Ir para o painel de módulos"
              className="flex min-h-11 items-center rounded-md px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Wordmark className="h-6" />
            </Link>
          </div>
          {/* `min-w-0` (impeccable rodada 4): sem ele o item flex não encolhe
              abaixo da largura do próprio conteúdo (min-width:auto), e o
              EntitySwitcher com nome de entidade longo empurrava o header 4px
              além da viewport em 390px — o body do hub rolava na horizontal em
              TODAS as telas. Achado medindo o DOM na verificação viva. */}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {/* task 3.1.1 — alternância de tema (FR-006/FR-007), ao lado de
                EntitySwitcher/AccountMenu; ThemeProvider mantém
                defaultTheme="dark" (FR-008) — este componente só oferece a
                escolha explícita, nunca muda o padrão. */}
            <ThemeToggle />
            <EntitySwitcher />
            <AccountMenu />
          </div>
        </header>
        <main id="conteudo-principal" tabIndex={-1} className="flex-1 focus:outline-none">
          {children}
        </main>
      </div>
    </div>
  );
}
