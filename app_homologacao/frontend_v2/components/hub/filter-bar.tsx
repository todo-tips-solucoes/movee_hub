// uiux-hub F4 (task 4.2) — padrão único de barra de filtros (FR-015):
// campos + ação de limpar, dentro de um cartão visualmente destacado do
// restante do conteúdo. Extrai o wrapper `rounded-lg bg-card p-3 shadow-sm`
// + grid + "Limpar filtros" que hoje se repete, duplicado, em
// `motoristas/page.tsx`, `importacoes/page.tsx` e `usuarios/page.tsx`.
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface FilterBarProps {
  /** Campos de filtro (cada um já rotulado pelo chamador — Input/select/Select). */
  children: ReactNode;
  /** Grid dos campos — varia por página conforme a quantidade de filtros. */
  gridClassName?: string;
  /** Omitido: nenhum botão de limpar é renderizado (ex.: busca única sem estado extra). */
  onClear?: () => void;
  clearLabel?: string;
  /** Nº de filtros preenchidos (impeccable polish 2026-08-06): com 0 o botão
   * desabilita (não há o que limpar); com N>0 mostra a contagem no rótulo.
   * Omitido: comportamento antigo (botão sempre ativo). */
  filtrosAtivos?: number;
  className?: string;
}

export function FilterBar({
  children,
  gridClassName = 'grid-cols-1 xs:grid-cols-2 lg:grid-cols-4',
  onClear,
  clearLabel = 'Limpar filtros',
  filtrosAtivos,
  className,
}: FilterBarProps) {
  return (
    <div className={cn('rounded-lg bg-card p-3 shadow-sm', className)}>
      <div className={cn('grid gap-3', gridClassName)}>{children}</div>
      {onClear && (
        <div className="mt-2 flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            className="min-h-11 sm:min-h-8"
            onClick={onClear}
            disabled={filtrosAtivos === 0}
          >
            {filtrosAtivos ? `${clearLabel} (${filtrosAtivos})` : clearLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
