// uiux-hub F2 — empty state padrão do hub, no molde do EstadoVazio da home
// (app/hub/dashboard/page.tsx, referência do plano): ícone em círculo, borda
// tracejada, mensagem + dica e AÇÃO opcional (um empty state sem próximo
// passo é um beco sem saída).

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icone: LucideIcon;
  titulo: string;
  dica?: string;
  /** Ação opcional (ex.: botão "Nova importação"). */
  children?: ReactNode;
}

export function EmptyState({ icone: Icon, titulo, dica, children }: EmptyStateProps) {
  return (
    <div
      role="status"
      className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-10 text-center text-muted-foreground"
    >
      <span className="flex size-14 items-center justify-center rounded-full bg-muted/60">
        <Icon className="size-7 opacity-60" aria-hidden="true" />
      </span>
      <p className="font-medium text-foreground">{titulo}</p>
      {dica && <p className="text-xs">{dica}</p>}
      {children && <div className="mt-2">{children}</div>}
    </div>
  );
}
