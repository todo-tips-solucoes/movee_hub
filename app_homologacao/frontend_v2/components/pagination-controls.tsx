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
  onRecordsPerPageChange: (value: number | 'all') => void;
}

const PAGE_SIZE_OPTIONS: { label: string; value: number | 'all' }[] = [
  { label: '10', value: 10 },
  { label: '30', value: 30 },
  { label: '50', value: 50 },
  { label: '100', value: 100 },
  { label: 'Todas', value: 'all' },
];

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

  const pages: number[] = [];
  const maxVisible = 5;
  let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
  const endPage = Math.min(totalPages, startPage + maxVisible - 1);
  if (endPage - startPage + 1 < maxVisible) {
    startPage = Math.max(1, endPage - maxVisible + 1);
  }
  for (let i = startPage; i <= endPage; i++) pages.push(i);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">
        {totalRecords > 0 ? `Mostrando ${start}-${end} de ${totalRecords}` : 'Nenhum registro'}
      </span>

      {/* R011: gaps de toque ≥8px no mobile; permite wrap p/ não estourar <400px */}
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="h-11 sm:h-7" />}>
            {recordsPerPage === 'all' ? 'Todas' : recordsPerPage} por pagina
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {PAGE_SIZE_OPTIONS.map((opt) => (
              <DropdownMenuItem key={String(opt.value)} onClick={() => onRecordsPerPageChange(opt.value)}>
                {opt.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

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
