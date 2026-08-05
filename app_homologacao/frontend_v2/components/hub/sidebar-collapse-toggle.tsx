'use client';

// hub-uiux-refresh FASE 2 (task 2.2.1) — botão de colapso da sidebar, na
// barra superior do hub (app/hub/dashboard/layout.tsx). Visível só em telas
// >= lg (onde a sidebar fixa existe); abaixo disso o ModuleNav usa drawer,
// sem noção de colapso (FR-005) — mesma classe `lg:` já usada em
// components/header.tsx para esconder ações só-desktop.
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSidebarCollapse } from '@/contexts/sidebar-collapse-context';

export function SidebarCollapseToggle() {
  const { colapsada, alternar } = useSidebarCollapse();
  const Icon = colapsada ? PanelLeftOpen : PanelLeftClose;

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={alternar}
      aria-expanded={!colapsada}
      aria-label={colapsada ? 'Expandir navegação' : 'Colapsar navegação'}
      className="hidden lg:inline-flex"
    >
      <Icon className="size-5" />
    </Button>
  );
}
