'use client';

// adiantamento-motorista — app/hub/dashboard/adiantamentos/page.tsx
// (tasks.md 7.3.1, H01): lista de solicitações com os filtros REAIS do
// backend (routes/hub-adiantamentos.js:273-330) — `de`/`ate` (sobre
// `dataSolicitacao`), `busca` (nome ou nº ADV), `status`, `exportado`,
// `pago`. `pendencia` existe no contrato mas não tem controle na tela do
// protótipo (H01) e fica de fora aqui também (YAGNI — sem UI pedida).
//
// Divergência do protótipo H01: as colunas "Produção R$/%/Taxa/Bruto" do
// mock vêm de `calculo`, que só existe em `SolicitacaoDetalhe` (GET /:id) —
// a LISTA (`SolicitacaoResumo`, GET /) nunca devolve isso, e buscar o
// detalhe de cada linha da página seria N+1. A tabela abaixo mostra só os
// campos reais do resumo (Constitution VI — nunca fabricar dado). O botão
// "Exportar CSV" do protótipo também some: `GET /adiantamentos` não aceita
// `format=csv` no backend atual (ao contrário de `hub-faturamento.js`).
//
// Ref: docs/specs/adiantamento-motorista/contracts/hub-api.md §Solicitações;
// prototipo H01.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { PeriodFilter } from '@/components/hub/period-filter';
import { SelectFiltro } from '@/components/hub/select-filtro';
import { AdiantamentoStatusBadge, STATUS_ADIANTAMENTO_OPCOES, rotuloStatusAdiantamento } from '@/components/hub/status-badge';
import { AdiantamentosAbas } from '@/components/hub/adiantamentos-abas';
import { useDebounce } from '@/hooks/use-debounce';
import { LARGURA_LISTA } from '@/lib/hub/larguras';
import { AdiantamentosApiError, listarSolicitacoes, type SolicitacaoResumo } from '@/lib/hub/adiantamentos-api';
import { formatBRL, formatDateBR } from '@/lib/utils';

const PAGE_SIZE = 20;

interface Filtros {
  de: string;
  ate: string;
  busca: string;
  status: string;
  exportado: '' | 'true' | 'false';
  pago: '' | 'true' | 'false';
}

const FILTROS_INICIAIS: Filtros = { de: '', ate: '', busca: '', status: '', exportado: '', pago: '' };

/** Lógica isolada do JSX (mesmo padrão de `useAvisosLista`/`useImportacoesHistorico`). */
export function useSolicitacoesLista() {
  const [filtros, setFiltrosState] = useState<Filtros>(FILTROS_INICIAIS);
  const [page, setPage] = useState(1);
  const [itens, setItens] = useState<SolicitacaoResumo[]>([]);
  const [total, setTotal] = useState(0);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const filtrosDebounced = useDebounce(filtros, 300);

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
      const resposta = await listarSolicitacoes({
        de: filtrosDebounced.de || undefined,
        ate: filtrosDebounced.ate || undefined,
        busca: filtrosDebounced.busca || undefined,
        status: filtrosDebounced.status || undefined,
        exportado: filtrosDebounced.exportado === '' ? undefined : filtrosDebounced.exportado === 'true',
        pago: filtrosDebounced.pago === '' ? undefined : filtrosDebounced.pago === 'true',
        page,
        pageSize: PAGE_SIZE,
      });
      setItens(resposta.itens);
      setTotal(resposta.total);
    } catch (e) {
      setErro(e instanceof AdiantamentosApiError ? e.message : 'Não foi possível carregar as solicitações.');
      setItens([]);
      setTotal(0);
    } finally {
      setCarregando(false);
    }
  }, [filtrosDebounced, page]);

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

export default function AdiantamentosSolicitacoesPage() {
  const h = useSolicitacoesLista();

  return (
    <div className={`mx-auto flex w-full ${LARGURA_LISTA} flex-col gap-4 p-4 sm:p-6 lg:p-8`}>
      <PageHeader titulo="Adiantamentos" subtitulo="Solicitações dos motoristas, cálculo e situação do pagamento." />
      <AdiantamentosAbas />

      <FilterBar
        gridClassName="grid-cols-1 xs:grid-cols-2 lg:grid-cols-4"
        onClear={h.resetFiltros}
        filtrosAtivos={h.filtrosAtivos}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="adiantamentos-filtro-busca">Motorista</Label>
          <Input
            id="adiantamentos-filtro-busca"
            placeholder="Nome ou nº ADV"
            className="h-11 sm:h-9"
            value={h.filtros.busca}
            onChange={(e) => h.setFiltros({ busca: e.target.value })}
          />
        </div>

        <div className="flex flex-col gap-1">
          <span id="adiantamentos-filtro-status-label" className="text-xs text-muted-foreground">
            Status
          </span>
          <SelectFiltro
            id="adiantamentos-filtro-status"
            ariaLabel="Status"
            value={h.filtros.status}
            onChange={(v) => h.setFiltros({ status: v })}
            opcoes={[
              { value: '', label: 'Todos' },
              ...STATUS_ADIANTAMENTO_OPCOES.map((s) => ({ value: s, label: rotuloStatusAdiantamento(s) })),
            ]}
          />
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Exportação</span>
          <SelectFiltro
            ariaLabel="Exportação"
            value={h.filtros.exportado}
            onChange={(v) => h.setFiltros({ exportado: v as Filtros['exportado'] })}
            opcoes={[
              { value: '', label: 'Todas' },
              { value: 'true', label: 'Exportadas' },
              { value: 'false', label: 'Não exportadas' },
            ]}
          />
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Pagamento</span>
          <SelectFiltro
            ariaLabel="Pagamento"
            value={h.filtros.pago}
            onChange={(v) => h.setFiltros({ pago: v as Filtros['pago'] })}
            opcoes={[
              { value: '', label: 'Todos' },
              { value: 'true', label: 'Pagas' },
              { value: 'false', label: 'Não pagas' },
            ]}
          />
        </div>

        <PeriodFilter
          className="xs:col-span-2 lg:col-span-4"
          idPrefix="adiantamentos-filtro"
          de={h.filtros.de}
          ate={h.filtros.ate}
          onChange={(intervalo) => h.setFiltros(intervalo)}
          legenda="da solicitação"
        />
      </FilterBar>

      {h.carregando ? (
        <ListSkeleton label="Carregando solicitações..." />
      ) : h.erro ? (
        <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-10 text-center">
          <AlertCircle className="size-8 text-destructive" aria-hidden="true" />
          <p className="text-sm font-medium text-destructive">{h.erro}</p>
          <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={h.refetch}>
            Tentar novamente
          </Button>
        </div>
      ) : h.itens.length === 0 ? (
        <EmptyState icone={Inbox} titulo="Nenhuma solicitação encontrada" dica="Ajuste os filtros ou aguarde novas solicitações do app." />
      ) : (
        <>
          {/* Mobile card layout */}
          <div className="flex flex-col gap-2 md:hidden">
            {h.itens.map((item) => (
              <Link
                key={item.id}
                href={`/hub/dashboard/adiantamentos/${item.id}`}
                className="rounded-lg border p-3 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-sm">{item.integrationId}</span>
                  <AdiantamentoStatusBadge status={item.status} />
                </div>
                <div className="mt-1 truncate text-sm font-medium">{item.motorista.nome ?? '—'}</div>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>Solicitada: {formatDateBR(item.dataSolicitacao)}</span>
                  <span>Líquido: {formatBRL(item.valorLiquido)}</span>
                </div>
              </Link>
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden rounded-lg border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nº</TableHead>
                  <TableHead>Motorista</TableHead>
                  <TableHead>Solicitada</TableHead>
                  <TableHead>Produção</TableHead>
                  <TableHead className="text-right">Líquido</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Pendências</TableHead>
                  <TableHead>Lote</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {h.itens.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <Link href={`/hub/dashboard/adiantamentos/${item.id}`} className="font-mono text-primary hover:underline">
                        {item.integrationId}
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-[220px] truncate">{item.motorista.nome ?? '—'}</TableCell>
                    <TableCell>{formatDateBR(item.dataSolicitacao)}</TableCell>
                    <TableCell>{formatDateBR(item.dataProducao)}</TableCell>
                    <TableCell className="text-right font-mono font-medium">{formatBRL(item.valorLiquido)}</TableCell>
                    <TableCell>
                      <AdiantamentoStatusBadge status={item.status} />
                    </TableCell>
                    <TableCell>
                      {item.pendencias.length > 0 ? item.pendencias.join(', ') : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>{item.loteId ?? <span className="text-muted-foreground">—</span>}</TableCell>
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
