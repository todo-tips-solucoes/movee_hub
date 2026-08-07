'use client';

import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface PaginationControlsProps {
  currentPage: number;
  totalPages: number;
  recordsPerPage: number | 'all';
  totalRecords: number;
  onPageChange: (page: number) => void;
  /** Omitido: nenhum seletor de "N por página" é renderizado.
   *
   * impeccable rodada 4 (h4 "Consistência", critique #2: "dois modelos de
   * paginação"). As telas do hub paginam SERVER-SIDE com `PAGE_SIZE` fixo —
   * não têm como honrar a troca de tamanho sem mudar o hook de cada uma. Antes
   * disso, cada uma reimplementava um rodapé próprio ("Página X de Y" +
   * Anterior/Próxima em texto), e o operador via dois idiomas de paginação
   * conforme o módulo. Tornando esta prop opcional, as 7 telas do hub passam a
   * usar ESTE componente — o idioma vira um só de verdade, em vez de um
   * segundo componente "igualzinho". */
  onRecordsPerPageChange?: (value: number | 'all') => void;
}

const PAGE_SIZE_OPTIONS: { label: string; value: number | 'all' }[] = [
  { label: '10', value: 10 },
  { label: '30', value: 30 },
  { label: '50', value: 50 },
  { label: '100', value: 100 },
  { label: 'Todas', value: 'all' },
];

/**
 * Janela deslizante de números de página em torno da atual — extraída para
 * fora do componente na rodada 4 do impeccable, quando ela deixou de servir 2
 * telas legadas e passou a servir também as 7 do hub. É a única lógica
 * não-trivial daqui: o segundo `Math.max` existe para que a janela continue
 * cheia perto das BORDAS (na página 1 de 20, mostrar 1..5 e não 1..3).
 */
export function janelaDePaginas(currentPage: number, totalPages: number, maxVisible = 5): number[] {
  const pages: number[] = [];
  let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
  const endPage = Math.min(totalPages, startPage + maxVisible - 1);
  if (endPage - startPage + 1 < maxVisible) {
    startPage = Math.max(1, endPage - maxVisible + 1);
  }
  for (let i = startPage; i <= endPage; i++) pages.push(i);
  return pages;
}

export function PaginationControls({
  currentPage,
  totalPages,
  recordsPerPage,
  totalRecords,
  onPageChange,
  onRecordsPerPageChange,
}: PaginationControlsProps) {
  const start = recordsPerPage === 'all' ? 1 : (currentPage - 1) * recordsPerPage + 1;
  const end = recordsPerPage === 'all' ? totalRecords : Math.min(currentPage * recordsPerPage, totalRecords);

  const pages = janelaDePaginas(currentPage, totalPages);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">
        {totalRecords > 0 ? `Mostrando ${start}-${end} de ${totalRecords}` : 'Nenhum registro'}
      </span>

      {/* R011: gaps de toque ≥8px no mobile; permite wrap p/ não estourar <400px */}
      <div className="flex flex-wrap items-center gap-2">
        {onRecordsPerPageChange && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="h-11 sm:h-7" />}>
              {recordsPerPage === 'all' ? 'Todas' : recordsPerPage} por página
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {PAGE_SIZE_OPTIONS.map((opt) => (
                <DropdownMenuItem key={String(opt.value)} onClick={() => onRecordsPerPageChange(opt.value)}>
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {/* R011: alvos 44×44px no mobile (densidade 32px no desktop); wrap centralizado */}
        <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-11 w-11 sm:h-8 sm:w-8"
            onClick={() => onPageChange(currentPage - 1)}
            disabled={currentPage <= 1}
            aria-label="Página anterior"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          {pages.map((page) => (
            <Button
              key={page}
              variant={page === currentPage ? 'default' : 'outline'}
              size="icon"
              className="h-11 w-11 sm:h-8 sm:w-8"
              onClick={() => onPageChange(page)}
              aria-label={`Página ${page}`}
              aria-current={page === currentPage ? 'page' : undefined}
            >
              {page}
            </Button>
          ))}
          <Button
            variant="outline"
            size="icon"
            className="h-11 w-11 sm:h-8 sm:w-8"
            onClick={() => onPageChange(currentPage + 1)}
            disabled={currentPage >= totalPages}
            aria-label="Próxima página"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  );
}
