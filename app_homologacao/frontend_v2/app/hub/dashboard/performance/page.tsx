'use client';

// hub-performance (S7) FASE 5 task 5.2 — rota `/hub/dashboard/performance`:
// cards de resumo + lista paginada de registros de turno com filtros
// server-side e export CSV condicionado.
//
// Mesmo molde de `.../faturamento/page.tsx`: hook de filtro/paginação local
// (state puro, sem sync de URL), cards no mobile + `Table` no desktop,
// filtros inline em `<select>`/`<Input>` do shadcn. Diferença deliberada
// (research.md Decision 11): NENHUM link para `/hub/dashboard/motoristas/:id`
// — o nome do entregador aqui é texto simples, nunca navegável.
//
// Ref: docs/specs/hub-performance/plan.md "Plano por fases" passo 5,
// contracts/performance-api.md, quickstart.md Cenários 5/6/10/12/14.

import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Download,
  Percent,
  RotateCw,
  TrendingUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useHubAuth } from '@/contexts/hub-auth-context';
import {
  baixarPerformanceCsv,
  listarPerformance,
  obterPerformanceResumo,
  PerformanceApiError,
} from '@/lib/hub/performance-api';
import type { PerformanceListItem, PerformanceResumoCards } from '@/lib/hub/performance-dto';
import { formatBRL, formatDateBR } from '@/lib/utils';

const PAGE_SIZE = 20;

const CARDS_INICIAIS: PerformanceResumoCards = {
  corridasCompletadas: 0,
  taxaAceitacao: null,
  taxaConclusao: null,
  tempoDisponivelMedio: null,
  taxasReais: '0.00',
};

export interface PerformanceFiltrosUI {
  de: string;
  ate: string;
  periodo: string;
  subpraca: string;
  entregadorId: string;
}

const FILTROS_INICIAIS: PerformanceFiltrosUI = {
  de: '',
  ate: '',
  periodo: '',
  subpraca: '',
  entregadorId: '',
};

/** `"0.8333"` (razão 0–1, research.md Decision 7) -> `"83,33%"`.
 * `null` = "indicador indisponível" (SC-009) -> `"—"`, NUNCA `"0%"`. */
function formatFracaoPct(valor: string | null): string {
  if (valor === null) return '—';
  const num = parseFloat(valor);
  if (isNaN(num)) return '—';
  return `${(num * 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

/** `"87.42"` (já em escala percentual, `tempo_disponivel_pct`) -> `"87,42%"`.
 * `null` -> `"—"`. Diferente de `formatFracaoPct`: NÃO multiplica por 100. */
function formatPontoPct(valor: string | number | null): string {
  if (valor === null || valor === undefined) return '—';
  const num = typeof valor === 'string' ? parseFloat(valor) : valor;
  if (isNaN(num)) return '—';
  return `${num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

/** Lógica isolada do JSX (mesmo padrão de `useFaturamentoLista`). Busca
 * lista + cards em paralelo com o MESMO conjunto de filtros — o backend
 * aplica exatamente os mesmos 5 filtros nos dois endpoints
 * (contracts/performance-api.md). */
export function usePerformanceLista() {
  const [filtros, setFiltrosState] = useState<PerformanceFiltrosUI>(FILTROS_INICIAIS);
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<PerformanceListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [cards, setCards] = useState<PerformanceResumoCards>(CARDS_INICIAIS);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const filtrosApi = useCallback(
    () => ({
      de: filtros.de || undefined,
      ate: filtros.ate || undefined,
      periodo: filtros.periodo || undefined,
      subpraca: filtros.subpraca || undefined,
      entregadorId: filtros.entregadorId ? Number(filtros.entregadorId) : undefined,
    }),
    [filtros]
  );

  const buscar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const [respostaLista, respostaCards] = await Promise.all([
        listarPerformance({ ...filtrosApi(), page, pageSize: PAGE_SIZE }),
        obterPerformanceResumo(filtrosApi()),
      ]);
      setItems(respostaLista.items);
      setTotal(respostaLista.total);
      setCards(respostaCards);
    } catch (e) {
      setErro(e instanceof PerformanceApiError ? e.message : 'Não foi possível carregar a performance.');
      setItems([]);
      setTotal(0);
      setCards(CARDS_INICIAIS);
    } finally {
      setCarregando(false);
    }
  }, [filtrosApi, page]);

  useEffect(() => {
    buscar();
  }, [buscar]);

  const setFiltros = useCallback((partial: Partial<PerformanceFiltrosUI>) => {
    setFiltrosState((prev) => ({ ...prev, ...partial }));
    setPage(1);
  }, []);

  const resetFiltros = useCallback(() => {
    setFiltrosState(FILTROS_INICIAIS);
    setPage(1);
  }, []);

  const totalPaginas = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return {
    filtros,
    setFiltros,
    resetFiltros,
    page,
    setPage,
    totalPaginas,
    items,
    total,
    cards,
    carregando,
    erro,
    filtrosApi,
    refetch: buscar,
  };
}

function CardsResumo({ cards }: { cards: PerformanceResumoCards }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card size="sm">
        <CardHeader className="flex flex-row items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <CheckCircle2 className="size-4" aria-hidden="true" />
          </span>
          <CardTitle className="text-sm text-muted-foreground">Corridas completadas</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="font-heading text-xl font-semibold text-foreground">{cards.corridasCompletadas}</p>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader className="flex flex-row items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <TrendingUp className="size-4" aria-hidden="true" />
          </span>
          <CardTitle className="text-sm text-muted-foreground">Taxa de aceitação</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="font-heading text-xl font-semibold text-foreground">
            {formatFracaoPct(cards.taxaAceitacao)}
          </p>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader className="flex flex-row items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Percent className="size-4" aria-hidden="true" />
          </span>
          <CardTitle className="text-sm text-muted-foreground">Taxa de conclusão</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="font-heading text-xl font-semibold text-foreground">
            {formatFracaoPct(cards.taxaConclusao)}
          </p>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader className="flex flex-row items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Clock className="size-4" aria-hidden="true" />
          </span>
          <CardTitle className="text-sm text-muted-foreground">Tempo disponível médio</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="font-heading text-xl font-semibold text-foreground">
            {formatPontoPct(cards.tempoDisponivelMedio)}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export default function PerformancePage() {
  const { permissoes } = useHubAuth();
  const podeExportar = permissoes.includes('performance.exportar');
  const h = usePerformanceLista();
  const [exportando, setExportando] = useState(false);
  const [erroExport, setErroExport] = useState<string | null>(null);

  const exportarCsv = useCallback(async () => {
    setExportando(true);
    setErroExport(null);
    try {
      await baixarPerformanceCsv(h.filtrosApi());
    } catch (e) {
      setErroExport(e instanceof PerformanceApiError ? e.message : 'Não foi possível exportar o CSV.');
    } finally {
      setExportando(false);
    }
  }, [h]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-xl font-semibold text-foreground sm:text-2xl">Performance</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Registros de turno importados: ofertas, aceites, conclusões e tempo disponível por entregador.
          </p>
        </div>
        {podeExportar && (
          <Button
            size="sm"
            variant="outline"
            className="min-h-11 gap-1.5 sm:min-h-8"
            disabled={exportando}
            onClick={exportarCsv}
          >
            <Download className="size-4" aria-hidden="true" />
            {exportando ? 'Exportando...' : 'Exportar CSV'}
          </Button>
        )}
      </div>

      {erroExport && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {erroExport}
        </div>
      )}

      <CardsResumo cards={h.cards} />

      {/* Filtros */}
      <div className="rounded-lg border bg-card p-3">
        <div className="grid grid-cols-1 gap-3 xs:grid-cols-2 lg:grid-cols-5">
          <div className="flex flex-col gap-1">
            <label htmlFor="performance-filtro-de" className="text-xs text-muted-foreground">
              De (data do turno)
            </label>
            <Input
              id="performance-filtro-de"
              type="date"
              value={h.filtros.de}
              onChange={(e) => h.setFiltros({ de: e.target.value })}
              className="h-11 sm:h-9"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="performance-filtro-ate" className="text-xs text-muted-foreground">
              Até (data do turno)
            </label>
            <Input
              id="performance-filtro-ate"
              type="date"
              value={h.filtros.ate}
              onChange={(e) => h.setFiltros({ ate: e.target.value })}
              className="h-11 sm:h-9"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="performance-filtro-periodo" className="text-xs text-muted-foreground">
              Turno (período)
            </label>
            <Input
              id="performance-filtro-periodo"
              value={h.filtros.periodo}
              onChange={(e) => h.setFiltros({ periodo: e.target.value })}
              placeholder="Ex.: ALMOCO 11H30-15H29"
              className="h-11 sm:h-9"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="performance-filtro-subpraca" className="text-xs text-muted-foreground">
              Subpraça
            </label>
            <Input
              id="performance-filtro-subpraca"
              value={h.filtros.subpraca}
              onChange={(e) => h.setFiltros({ subpraca: e.target.value })}
              placeholder="Ex.: PINHEIROS"
              className="h-11 sm:h-9"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="performance-filtro-entregador" className="text-xs text-muted-foreground">
              ID do entregador
            </label>
            <Input
              id="performance-filtro-entregador"
              type="number"
              min={1}
              value={h.filtros.entregadorId}
              onChange={(e) => h.setFiltros({ entregadorId: e.target.value })}
              placeholder="Ex.: 42"
              className="h-11 sm:h-9"
            />
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Os filtros de período usam a <strong>data do turno</strong> (não a data de importação).
          </p>
          <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-8" onClick={h.resetFiltros}>
            Limpar filtros
          </Button>
        </div>
      </div>

      {/* Conteúdo */}
      {h.carregando ? (
        <div role="status" className="flex flex-col items-center gap-2 rounded-lg border p-10 text-muted-foreground">
          <RotateCw className="size-6 animate-spin" aria-hidden="true" />
          <p className="text-sm">Carregando performance...</p>
        </div>
      ) : h.erro ? (
        <div
          role="alert"
          className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-10 text-center"
        >
          <AlertCircle className="size-8 text-destructive" aria-hidden="true" />
          <p className="text-sm font-medium text-destructive">{h.erro}</p>
          <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={h.refetch}>
            Tentar novamente
          </Button>
        </div>
      ) : h.items.length === 0 ? (
        <div
          role="status"
          className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-10 text-center text-muted-foreground"
        >
          <TrendingUp className="size-10 opacity-30" aria-hidden="true" />
          <p className="font-medium">Nenhum registro de turno no período selecionado</p>
          <p className="text-xs">Ajuste os filtros ou selecione outro período.</p>
        </div>
      ) : (
        <>
          {/* Mobile card layout */}
          <div className="flex flex-col gap-2 md:hidden">
            {h.items.map((item) => (
              <div key={item.id} className="rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{item.entregadorNome ?? `#${item.entregadorId}`}</span>
                  <span className="font-mono text-sm">{formatBRL(item.taxas)}</span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {formatDateBR(item.dataPeriodo)} {item.periodo ? `— ${item.periodo}` : ''}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>Ofertadas: {item.corridasOfertadas}</span>
                  <span>Aceitas: {item.corridasAceitas}</span>
                  <span>Completadas: {item.corridasCompletadas}</span>
                  <span>Canceladas: {item.corridasCanceladas}</span>
                  <span>Tempo disp.: {formatPontoPct(item.tempoDisponivelPct)}</span>
                </div>
                {(item.subpraca || item.praca) && (
                  <p className="mt-2 truncate text-xs text-muted-foreground">
                    {[item.subpraca, item.praca].filter(Boolean).join(' — ')}
                  </p>
                )}
              </div>
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-lg border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data do turno</TableHead>
                  <TableHead>Período</TableHead>
                  <TableHead>Entregador</TableHead>
                  <TableHead>Subpraça</TableHead>
                  <TableHead>Praça</TableHead>
                  <TableHead className="text-right">Ofertadas</TableHead>
                  <TableHead className="text-right">Aceitas</TableHead>
                  <TableHead className="text-right">Rejeitadas</TableHead>
                  <TableHead className="text-right">Completadas</TableHead>
                  <TableHead className="text-right">Canceladas</TableHead>
                  <TableHead className="text-right">Pedidos concl.</TableHead>
                  <TableHead className="text-right">Tempo disp.</TableHead>
                  <TableHead className="text-right">Taxas</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {h.items.map((item) => (
                  <TableRow key={item.id} className="hover:bg-muted/50">
                    <TableCell className="text-sm">{formatDateBR(item.dataPeriodo)}</TableCell>
                    <TableCell className="max-w-[180px] truncate text-sm text-muted-foreground">
                      {item.periodo ?? '-'}
                    </TableCell>
                    <TableCell className="text-sm">{item.entregadorNome ?? `#${item.entregadorId}`}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{item.subpraca ?? '-'}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{item.praca ?? '-'}</TableCell>
                    <TableCell className="text-right">{item.corridasOfertadas}</TableCell>
                    <TableCell className="text-right">{item.corridasAceitas}</TableCell>
                    <TableCell className="text-right">{item.corridasRejeitadas}</TableCell>
                    <TableCell className="text-right">{item.corridasCompletadas}</TableCell>
                    <TableCell className="text-right">{item.corridasCanceladas}</TableCell>
                    <TableCell className="text-right">{item.pedidosConcluidos ?? '-'}</TableCell>
                    <TableCell className="text-right">{formatPontoPct(item.tempoDisponivelPct)}</TableCell>
                    <TableCell className="text-right font-mono">{formatBRL(item.taxas)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Paginação */}
          <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>
              Página {h.page} de {h.totalPaginas} — {h.total} registro{h.total === 1 ? '' : 's'}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                className="min-h-11 sm:min-h-8"
                disabled={h.page <= 1}
                onClick={() => h.setPage(h.page - 1)}
              >
                Anterior
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="min-h-11 sm:min-h-8"
                disabled={h.page >= h.totalPaginas}
                onClick={() => h.setPage(h.page + 1)}
              >
                Próxima
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
