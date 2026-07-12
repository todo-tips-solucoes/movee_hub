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
import { EntitySwitcher } from '@/components/hub/entity-switcher';
import { AccountMenu } from '@/components/hub/account-menu';
import { Wordmark } from '@/components/brand/wordmark';

export default function HubDashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col lg:flex-row">
      {/* < lg: agrupa o hamburger do ModuleNav numa faixa com borda, em vez de
          deixá-lo "solto" no topo — mesmo tom visual do header que segue. */}
      <div className="border-b border-sidebar-border lg:contents">
        <ModuleNav />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {/* uiux-hub F2: sticky (EntitySwitcher/conta sempre à mão em telas
            longas) + Wordmark à esquerda — a marca antes só existia no login. */}
        <header className="sticky top-0 z-40 flex flex-wrap items-center justify-between gap-2 border-b border-border bg-card/80 px-4 py-2 backdrop-blur">
          <Link
            href="/hub/dashboard"
            aria-label="Ir para o painel de módulos"
            className="flex min-h-11 items-center rounded-md px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Wordmark className="h-6" />
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <EntitySwitcher />
            <AccountMenu />
          </div>
        </header>
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
