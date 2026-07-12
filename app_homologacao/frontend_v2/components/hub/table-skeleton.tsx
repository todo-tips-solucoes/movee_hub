// uiux-hub F2 (P3) — skeletons de carregamento com shape estável, no molde
// do EnvioMassaSkeleton (envio_massa/page.tsx): a tela "desenha" a estrutura
// que vai existir em vez de um spinner centralizado. O texto de status fica
// em sr-only — leitores de tela continuam ouvindo o mesmo anúncio que os
// testes já asseguram (ex.: "Carregando importações...").

import { Skeleton } from '@/components/ui/skeleton';

interface ListSkeletonProps {
  /** Anúncio para leitores de tela (ex.: "Carregando importações..."). */
  label: string;
  /** Quantidade de linhas fantasma (default 6). */
  linhas?: number;
}

/** Skeleton de lista/tabela: barra de cabeçalho + N linhas. */
export function ListSkeleton({ label, linhas = 6 }: ListSkeletonProps) {
  return (
    <div role="status" className="overflow-hidden rounded-lg border">
      <span className="sr-only">{label}</span>
      <div className="border-b bg-muted/40 px-4 py-3">
        <Skeleton className="h-4 w-1/3" />
      </div>
      <div className="flex flex-col gap-3 p-4" aria-hidden="true">
        {Array.from({ length: linhas }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="hidden h-4 w-16 sm:block" />
          </div>
        ))}
      </div>
    </div>
  );
}

interface KpiSkeletonProps {
  /** Anúncio para leitores de tela (ex.: "Carregando indicadores..."). */
  label: string;
  /** Quantidade de cards fantasma (default 3). */
  cards?: number;
}

/** Skeleton dos cards de KPI (faturamento/performance). */
export function KpiSkeleton({ label, cards = 3 }: KpiSkeletonProps) {
  return (
    <div role="status" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <span className="sr-only">{label}</span>
      {Array.from({ length: cards }, (_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-lg border p-4" aria-hidden="true">
          <Skeleton className="size-10 shrink-0 rounded-md" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}
