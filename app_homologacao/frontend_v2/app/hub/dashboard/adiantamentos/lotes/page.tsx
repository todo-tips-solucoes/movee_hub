'use client';

// adiantamento-motorista — app/hub/dashboard/adiantamentos/lotes/page.tsx
// (tasks.md 7.7.1, H13): histórico de lotes de pagamento, com filtros reais
// do backend (`GET /lotes` aceita `de`/`ate`/`status`, routes/hub-adiantamentos.js
// :829-852). Mesmo molde de `contas/page.tsx` (lista + filtros + paginação),
// sem seleção em massa — cada lote tem sua própria tela de ação (H12/H15).
//
// Ref: docs/specs/adiantamento-motorista/contracts/hub-api.md §Pagamentos e
// lotes; spec.md US5; prototipo H13.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PaginationControls } from '@/components/pagination-controls';
import { ListSkeleton } from '@/components/hub/table-skeleton';
import { EmptyState } from '@/components/hub/empty-state';
import { PageHeader } from '@/components/hub/page-header';
import { FilterBar } from '@/components/hub/filter-bar';
import { SelectFiltro } from '@/components/hub/select-filtro';
import { AdiantamentosAbas } from '@/components/hub/adiantamentos-abas';
import { LoteStatusBadge, STATUS_LOTE_OPCOES } from '@/components/hub/status-badge';
import { LARGURA_LISTA } from '@/lib/hub/larguras';
import { AdiantamentosApiError, listarLotes, type Lote } from '@/lib/hub/adiantamentos-api';
import { formatBRL, formatDateBR } from '@/lib/utils';

const PAGE_SIZE = 20;

interface Filtros {
  de: string;
  ate: string;
  status: string;
}

const FILTROS_INICIAIS: Filtros = { de: '', ate: '', status: '' };

function rotuloResponsavel(criadoPor: Lote['criadoPor']): string {
  if (criadoPor === null) return '—';
  if (typeof criadoPor === 'number') return `Usuário #${criadoPor}`;
  return criadoPor.nome;
}

/** Lógica isolada do JSX (mesmo padrão de `useContasLista`). */
export function useLotesLista() {
  const [filtros, setFiltrosState] = useState<Filtros>(FILTROS_INICIAIS);
  const [page, setPage] = useState(1);
  const [itens, setItens] = useState<Lote[]>([]);
  const [total, setTotal] = useState(0);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const setFiltros = useCallback((parcial: Partial<Filtros>) => {
    setFiltrosState((atual) => ({ ...atual, ...parcial }));
    setPage(1);
  }, []);

  const resetFiltros = useCallback(() => {
    setFiltrosState(FILTROS_INICIAIS);
    setPage(1);
  }, []);

  const buscar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const resposta = await listarLotes({
        de: filtros.de || undefined,
        ate: filtros.ate || undefined,
        status: filtros.status || undefined,
        page,
        pageSize: PAGE_SIZE,
      });
      setItens(resposta.itens);
      setTotal(resposta.total);
    } catch (e) {
      setErro(e instanceof AdiantamentosApiError ? e.message : 'Não foi possível carregar o histórico de lotes.');
      setItens([]);
      setTotal(0);
    } finally {
      setCarregando(false);
    }
  }, [filtros, page]);

  useEffect(() => {
    buscar();
  }, [buscar]);

  const totalPaginas = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtrosAtivos = Object.values(filtros).filter((v) => v !== '').length;

  return {
    filtros, setFiltros, resetFiltros, filtrosAtivos,
    itens, total, page, setPage, totalPaginas, carregando, erro, refetch: buscar,
  };
}

export default function AdiantamentosLotesPage() {
  const h = useLotesLista();

  return (
    <div className={`mx-auto flex w-full ${LARGURA_LISTA} flex-col gap-4 p-4 sm:p-6 lg:p-8`}>
      <PageHeader titulo="Histórico de lotes" subtitulo="Lotes gerados para a Transfeera." />
      <AdiantamentosAbas />

      <FilterBar
        gridClassName="grid-cols-1 xs:grid-cols-2 lg:grid-cols-3"
        onClear={h.resetFiltros}
        filtrosAtivos={h.filtrosAtivos}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="lotes-filtro-de">Criado de</Label>
          <Input id="lotes-filtro-de" type="date" className="h-11 sm:h-9" value={h.filtros.de} onChange={(e) => h.setFiltros({ de: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="lotes-filtro-ate">até</Label>
          <Input id="lotes-filtro-ate" type="date" className="h-11 sm:h-9" value={h.filtros.ate} onChange={(e) => h.setFiltros({ ate: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Status</span>
          <SelectFiltro
            ariaLabel="Status"
            value={h.filtros.status}
            onChange={(v) => h.setFiltros({ status: v })}
            opcoes={[
              { value: '', label: 'Todos' },
              ...STATUS_LOTE_OPCOES.map((s) => ({ value: s, label: s })),
            ]}
          />
        </div>
      </FilterBar>

      {h.carregando ? (
        <ListSkeleton label="Carregando histórico de lotes..." />
      ) : h.erro ? (
        <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-10 text-center">
          <AlertCircle className="size-8 text-destructive" aria-hidden="true" />
          <p className="text-sm font-medium text-destructive">{h.erro}</p>
          <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={h.refetch}>
            Tentar novamente
          </Button>
        </div>
      ) : h.itens.length === 0 ? (
        <EmptyState icone={Inbox} titulo="Nenhum lote encontrado" dica="Ajuste os filtros ou monte um novo lote em Pagamentos." />
      ) : (
        <>
          {/* Mobile card layout */}
          <div className="flex flex-col gap-2 md:hidden">
            {h.itens.map((lote) => (
              <Link
                key={lote.id}
                href={`/hub/dashboard/adiantamentos/lotes/${lote.id}`}
                className="rounded-lg border p-3 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm font-medium">#{lote.numero}</span>
                  <LoteStatusBadge status={lote.status} />
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>{formatDateBR(lote.criadoEm)}</span>
                  <span>{lote.quantidade} pagamento(s)</span>
                  <span className="font-mono">{formatBRL(lote.valorTotal)}</span>
                </div>
              </Link>
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden rounded-lg border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lote</TableHead>
                  <TableHead>Data</TableHead>
                  <TableHead className="text-right">Pagamentos</TableHead>
                  <TableHead className="text-right">Valor</TableHead>
                  <TableHead>Responsável</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Downloads</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {h.itens.map((lote) => (
                  <TableRow key={lote.id}>
                    <TableCell className="font-mono font-medium">#{lote.numero}</TableCell>
                    <TableCell>{formatDateBR(lote.criadoEm)}</TableCell>
                    <TableCell className="text-right font-mono">{lote.quantidade}</TableCell>
                    <TableCell className="text-right font-mono">{formatBRL(lote.valorTotal)}</TableCell>
                    <TableCell>{rotuloResponsavel(lote.criadoPor)}</TableCell>
                    <TableCell>
                      <LoteStatusBadge status={lote.status} />
                    </TableCell>
                    <TableCell className="text-right font-mono">{lote.downloads}</TableCell>
                    <TableCell>
                      <Link href={`/hub/dashboard/adiantamentos/lotes/${lote.id}`} className="text-primary hover:underline">
                        Detalhes
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <PaginationControls
            currentPage={h.page}
            totalPages={h.totalPaginas}
            recordsPerPage={PAGE_SIZE}
            totalRecords={h.total}
            onPageChange={h.setPage}
          />
        </>
      )}
    </div>
  );
}
