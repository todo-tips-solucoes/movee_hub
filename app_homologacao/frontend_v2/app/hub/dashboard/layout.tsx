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
import { User } from 'lucide-react';
import { ModuleNav } from '@/components/hub/module-nav';
import { EntitySwitcher } from '@/components/hub/entity-switcher';

export default function HubDashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col lg:flex-row">
      {/* < lg: agrupa o hamburger do ModuleNav numa faixa com borda, em vez de
          deixá-lo "solto" no topo — mesmo tom visual do header que segue. */}
      <div className="border-b border-sidebar-border lg:contents">
        <ModuleNav />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-end gap-2 border-b border-border bg-card/40 px-4 py-2">
          <EntitySwitcher />
          <Link
            href="/hub/dashboard/perfil"
            className="flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <User className="size-4 shrink-0" aria-hidden="true" />
            Meu perfil
          </Link>
        </header>
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
