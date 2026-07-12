// uiux-hub F2 — cabeçalho de página padronizado do hub: h1 em font-heading +
// subtítulo + slot de ação à direita. Antes cada tela duplicava esse bloco
// (com divergências de fonte/peso — P7).

import type { ReactNode } from 'react';

interface PageHeaderProps {
  titulo: string;
  subtitulo?: string;
  /** Ação(ões) à direita (botão primário, badge de status etc.). */
  children?: ReactNode;
}

export function PageHeader({ titulo, subtitulo, children }: PageHeaderProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="font-heading text-xl font-semibold text-foreground sm:text-2xl">{titulo}</h1>
        {subtitulo && <p className="mt-1 text-sm text-muted-foreground">{subtitulo}</p>}
      </div>
      {children}
    </div>
  );
}
