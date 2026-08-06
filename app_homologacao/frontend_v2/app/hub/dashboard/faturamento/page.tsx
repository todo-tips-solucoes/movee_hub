'use client';

// hub-faturamento (S6) FASE 6 task 6.2 — rota `/hub/dashboard/faturamento`:
// cards de resumo + lista paginada de lançamentos com filtros server-side,
// export CSV condicionado e navegação condicional para o detalhe do
// entregador (módulo Motoristas, S5).
//
// Mesmo molde de `.../motoristas/page.tsx`/`.../importacoes/page.tsx`: hook
// de filtro/paginação local (state puro, sem sync de URL), cards no mobile +
// `Table` no desktop, filtros inline em `<select>`/`<Input>` do shadcn.
//
// Ref: docs/specs/hub-faturamento/plan.md §Plano por fases item 6,
// contracts/faturamento-api.md, quickstart.md Cenários 5/6/10/12/14.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { PageHeader } from '@/components/hub/page-header';
import { EmptyState } from '@/components/hub/empty-state';
import { KpiCard } from '@/components/hub/kpi-card';
import { KpiSkeleton, ListSkeleton } from '@/components/hub/table-skeleton';
import {
  AlertCircle,
  ChevronRight,
  Download,
  Receipt,
  Tag,
  Users,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
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
import { useDebounce } from '@/hooks/use-debounce';
import {
  baixarFaturamentoCsv,
  buscarEntregadoresFaturamento,
  FaturamentoApiError,
  listarAreasFaturamento,
  listarFaturamento,
  obterFaturamentoResumo,
  obterFaturamentoResumoAgrupado,
  type FaturamentoFiltros,
} from '@/lib/hub/faturamento-api';
import { EntregadorCombobox } from '@/components/hub/entregador-combobox';
import type {
  FaturamentoGroupBy,
  FaturamentoListItem,
  FaturamentoResumoCards,
  FaturamentoResumoGrupo,
} from '@/lib/hub/faturamento-dto';
import { HorizontalBarChart } from '@/components/hub/bar-chart';
import { Skeleton } from '@/components/ui/skeleton';
import { formatBRL, formatDateBR } from '@/lib/utils';

const PAGE_SIZE = 20;

const CARDS_INICIAIS: FaturamentoResumoCards = {
  totalGeral: '0.00',
  categoriaMaiorValor: null,
  entregadoresDistintos: 0,
};

export interface FaturamentoFiltrosUI {
  de: string;
  ate: string;
  categoria: string;
  entregadorId: string;
  /** Nome exibido no `EntregadorCombobox` — WS-B (tasks.md 2.4). Só usado
   * pela UI (não vai para a API); sincronizado com `entregadorId` pela
   * própria seleção do combobox. */
  entregadorNome: string;
  subpraca: string;
  comEntregador: '' | 'true' | 'false';
}

const FILTROS_INICIAIS: FaturamentoFiltrosUI = {
  de: '',
  ate: '',
  categoria: '',
  entregadorId: '',
  entregadorNome: '',
  subpraca: '',
  comEntregador: '',
};

/** Lógica isolada do JSX (mesmo padrão de `useMotoristasLista`/
 * `useImportacoesHistorico`). Busca lista + cards em paralelo com o MESMO
 * conjunto de filtros — o backend aplica exatamente os mesmos 6 filtros nos
 * dois endpoints (contracts/faturamento-api.md). */
export function useFaturamentoLista() {
  const [filtros, setFiltrosState] = useState<FaturamentoFiltrosUI>(FILTROS_INICIAIS);
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<FaturamentoListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [cards, setCards] = useState<FaturamentoResumoCards>(CARDS_INICIAIS);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  // impeccable rodada 2 (P2): antes era 1 fetch por tecla nos campos de texto
  // — o debounce espera a digitação assentar (DEBOUNCE_MS=300 do combobox).
  const filtrosDebounced = useDebounce(filtros, 300);

  const filtrosApi = useCallback(
    () => ({
      de: filtrosDebounced.de || undefined,
      ate: filtrosDebounced.ate || undefined,
      categoria: filtrosDebounced.categoria || undefined,
      entregadorId: filtrosDebounced.entregadorId ? Number(filtrosDebounced.entregadorId) : undefined,
      subpraca: filtrosDebounced.subpraca || undefined,
      comEntregador: filtrosDebounced.comEntregador === '' ? undefined : filtrosDebounced.comEntregador === 'true',
    }),
    [filtrosDebounced]
  );

  const buscar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const [respostaLista, respostaCards] = await Promise.all([
        listarFaturamento({ ...filtrosApi(), page, pageSize: PAGE_SIZE }),
        obterFaturamentoResumo(filtrosApi()),
      ]);
      setItems(respostaLista.items);
      setTotal(respostaLista.total);
      setCards(respostaCards);
    } catch (e) {
      setErro(e instanceof FaturamentoApiError ? e.message : 'Não foi possível carregar o faturamento.');
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

  const setFiltros = useCallback((partial: Partial<FaturamentoFiltrosUI>) => {
    setFiltrosState((prev) => {
      const proximo = { ...prev, ...partial };
      // FR-002/contrato: `entregadorId` + `comEntregador=false` é contraditório
      // (400) — um entregador específico nunca é um lançamento sem
      // entregador. A UI evita disparar o filtro inválido em vez de deixar o
      // usuário topar com o erro 400.
      if ('comEntregador' in partial && partial.comEntregador === 'false') {
        proximo.entregadorId = '';
        proximo.entregadorNome = '';
      }
      if ('entregadorId' in partial && partial.entregadorId && proximo.comEntregador === 'false') {
        proximo.comEntregador = '';
      }
      return proximo;
    });
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

function EntregadorCelula({ item, podeVerDetalhe }: { item: FaturamentoListItem; podeVerDetalhe: boolean }) {
  if (!item.comEntregador || item.entregadorId === null) {
    return <Badge variant="secondary">Agregados/bônus</Badge>;
  }
  if (podeVerDetalhe) {
    return (
      <Link
        href={`/hub/dashboard/motoristas/${item.entregadorId}`}
        className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
      >
        {item.entregadorNome ?? `#${item.entregadorId}`}
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </Link>
    );
  }
  return <span className="text-sm">{item.entregadorNome ?? `#${item.entregadorId}`}</span>;
}

function CardsResumo({ cards }: { cards: FaturamentoResumoCards }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <KpiCard label="Total geral" value={formatBRL(cards.totalGeral)} icon={Receipt} />
      <KpiCard
        label="Categoria de maior valor"
        value={cards.categoriaMaiorValor ?? '—'}
        icon={Tag}
      />
      <KpiCard
        label="Entregadores distintos"
        value={cards.entregadoresDistintos}
        icon={Users}
      />
    </div>
  );
}

/** uiux-hub F4 — distribuição do faturamento por categoria/dia, consumindo
 * `GET /faturamento/resumo?groupBy=...` (agregação 100% no backend, mesmos
 * filtros da lista; endpoint já existia no contrato e estava sem consumidor). */
function DistribuicaoFaturamento({ filtrosApi }: { filtrosApi: () => FaturamentoFiltros }) {
  const [groupBy, setGroupBy] = useState<Extract<FaturamentoGroupBy, 'categoria' | 'dia'>>('categoria');
  const [grupos, setGrupos] = useState<FaturamentoResumoGrupo[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  // Mesmo idioma dos hooks de lista (buscar em useCallback + useEffect).
  const buscar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const r = await obterFaturamentoResumoAgrupado(groupBy, filtrosApi());
      setGrupos(r.grupos);
    } catch (e) {
      setGrupos([]);
      setErro(e instanceof FaturamentoApiError ? e.message : 'Não foi possível carregar a distribuição.');
    } finally {
      setCarregando(false);
    }
  }, [groupBy, filtrosApi]);

  useEffect(() => {
    buscar();
  }, [buscar]);

  // Ordenação SÓ de apresentação (o valor exibido segue sendo a string do
  // backend): categoria = maiores primeiro; dia = cronológico pela chave.
  const dados = [...grupos]
    .sort((a, b) =>
      groupBy === 'dia' ? a.chave.localeCompare(b.chave) : parseFloat(b.total) - parseFloat(a.total)
    )
    .map((g) => ({
      chave: g.chave,
      rotulo: groupBy === 'dia' ? formatDateBR(g.chave) || g.rotulo : g.rotulo,
      valor: parseFloat(g.total) || 0,
      valorFormatado: formatBRL(g.total),
    }));

  return (
    <Card size="sm">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-sm text-muted-foreground">Distribuição do faturamento</CardTitle>
        <div className="flex gap-1" role="group" aria-label="Agrupar distribuição por">
          <Button
            size="sm"
            variant={groupBy === 'categoria' ? 'default' : 'outline'}
            className="min-h-11 sm:min-h-7"
            aria-pressed={groupBy === 'categoria'}
            onClick={() => setGroupBy('categoria')}
          >
            Por categoria
          </Button>
          <Button
            size="sm"
            variant={groupBy === 'dia' ? 'default' : 'outline'}
            className="min-h-11 sm:min-h-7"
            aria-pressed={groupBy === 'dia'}
            onClick={() => setGroupBy('dia')}
          >
            Por dia
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {carregando ? (
          <div role="status" className="flex flex-col gap-2 py-1" aria-label="Carregando distribuição...">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        ) : erro ? (
          <p role="alert" className="py-4 text-center text-sm text-destructive">
            {erro}
          </p>
        ) : (
          <HorizontalBarChart
            titulo={groupBy === 'categoria' ? 'Faturamento por categoria' : 'Faturamento por dia'}
            dados={dados}
            corVar="--chart-1"
          />
        )}
      </CardContent>
    </Card>
  );
}

export default function FaturamentoPage() {
  const { permissoes } = useHubAuth();
  const podeExportar = permissoes.includes('faturamento.exportar');
  const podeVerDetalheMotorista = permissoes.includes('motoristas.consultar');
  const h = useFaturamentoLista();
  const [exportando, setExportando] = useState(false);
  const [erroExport, setErroExport] = useState<string | null>(null);
  // WS-B (tasks.md 2.3.5, FR-010, D-B1): degradação sticky — uma vez que a
  // busca de entregador falhar (rede/5xx), a tela volta a mostrar o input
  // numérico pelo resto da sessão (não tenta o combobox de novo sozinha;
  // reabrir/recarregar a página tenta de novo).
  const [entregadorBuscaIndisponivel, setEntregadorBuscaIndisponivel] = useState(false);
  // uiux-hub pós-F4: filtro "Subpraça" como combobox — opções de GET
  // /faturamento/areas; falha na carga degrada para só "Todas".
  const [areasOpcoes, setAreasOpcoes] = useState<string[]>([]);
  useEffect(() => {
    let ativo = true;
    listarAreasFaturamento()
      .then((areas) => { if (ativo) setAreasOpcoes(areas); })
      .catch(() => { if (ativo) setAreasOpcoes([]); });
    return () => { ativo = false; };
  }, []);

  const exportarCsv = useCallback(async () => {
    setExportando(true);
    setErroExport(null);
    try {
      await baixarFaturamentoCsv(h.filtrosApi());
      toast.success('Exportação CSV iniciada.');
    } catch (e) {
      setErroExport(e instanceof FaturamentoApiError ? e.message : 'Não foi possível exportar o CSV.');
    } finally {
      setExportando(false);
    }
  }, [h]);

  return (
    <div className="mx-auto flex w-full max-w-[96rem] flex-col gap-4 p-4 sm:p-6 lg:p-8">
      <PageHeader titulo="Faturamento" subtitulo="Lançamentos de faturamento importados, por corrida/lote de entregador.">
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
      </PageHeader>

      {erroExport && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {erroExport}
        </div>
      )}

      {h.carregando ? (
        <KpiSkeleton label="Carregando indicadores de faturamento..." cards={3} />
      ) : (
        <CardsResumo cards={h.cards} />
      )}

      <DistribuicaoFaturamento filtrosApi={h.filtrosApi} />

      {/* Filtros */}
      <div className="rounded-lg border bg-card p-3">
        <div className="grid grid-cols-1 gap-3 xs:grid-cols-2 lg:grid-cols-6">
          <div className="flex flex-col gap-1">
            <label htmlFor="faturamento-filtro-de" className="text-xs text-muted-foreground">
              De (data de competência)
            </label>
            <Input
              id="faturamento-filtro-de"
              type="date"
              value={h.filtros.de}
              onChange={(e) => h.setFiltros({ de: e.target.value })}
              className="h-11 sm:h-9"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="faturamento-filtro-ate" className="text-xs text-muted-foreground">
              Até (data de competência)
            </label>
            <Input
              id="faturamento-filtro-ate"
              type="date"
              value={h.filtros.ate}
              onChange={(e) => h.setFiltros({ ate: e.target.value })}
              className="h-11 sm:h-9"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="faturamento-filtro-categoria" className="text-xs text-muted-foreground">
              Categoria
            </label>
            <Input
              id="faturamento-filtro-categoria"
              value={h.filtros.categoria}
              onChange={(e) => h.setFiltros({ categoria: e.target.value })}
              placeholder="Ex.: Corridas concluidas"
              className="h-11 sm:h-9"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="faturamento-filtro-subpraca" className="text-xs text-muted-foreground">
              Subpraça
            </label>
            <select
              id="faturamento-filtro-subpraca"
              aria-label="Subpraça"
              value={h.filtros.subpraca}
              onChange={(e) => h.setFiltros({ subpraca: e.target.value })}
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm sm:h-9"
            >
              <option value="">Todas</option>
              {areasOpcoes.map((area) => (
                <option key={area} value={area}>
                  {area}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="faturamento-filtro-entregador" className="text-xs text-muted-foreground">
              Entregador
            </label>
            {entregadorBuscaIndisponivel ? (
              // WS-B degradação (FR-010, D-B1): busca indisponível -> volta
              // ao input numérico original, sem quebrar a tela.
              <Input
                id="faturamento-filtro-entregador"
                type="number"
                min={1}
                value={h.filtros.entregadorId}
                onChange={(e) => h.setFiltros({ entregadorId: e.target.value, entregadorNome: '' })}
                placeholder="ID do entregador (ex.: 42)"
                className="h-11 sm:h-9"
              />
            ) : (
              <EntregadorCombobox
                id="faturamento-filtro-entregador"
                value={h.filtros.entregadorId ? Number(h.filtros.entregadorId) : null}
                nomeSelecionado={h.filtros.entregadorNome || null}
                disabled={h.filtros.comEntregador === 'false'}
                buscar={buscarEntregadoresFaturamento}
                onIndisponivel={() => setEntregadorBuscaIndisponivel(true)}
                onSelecionar={(id, nome) =>
                  h.setFiltros({
                    entregadorId: id !== null ? String(id) : '',
                    entregadorNome: nome ?? '',
                  })
                }
              />
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="faturamento-filtro-com-entregador" className="text-xs text-muted-foreground">
              Tipo de lançamento
            </label>
            <select
              id="faturamento-filtro-com-entregador"
              aria-label="Tipo de lançamento"
              value={h.filtros.comEntregador}
              onChange={(e) => h.setFiltros({ comEntregador: e.target.value as FaturamentoFiltrosUI['comEntregador'] })}
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm sm:h-9"
            >
              <option value="">Todos</option>
              <option value="true">Só com entregador</option>
              <option value="false">Só agregados/bônus</option>
            </select>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Os filtros de período usam a <strong>data de competência</strong> do lançamento (não a data de importação).
          </p>
          <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-8" onClick={h.resetFiltros}>
            Limpar filtros
          </Button>
        </div>
      </div>

      {/* Conteúdo */}
      {h.carregando ? (
        <ListSkeleton label="Carregando faturamento..." />
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
        <EmptyState
          icone={Receipt}
          titulo="Nenhum lançamento no período selecionado"
          dica="Ajuste os filtros ou selecione outro período de competência."
        />
      ) : (
        <>
          {/* Mobile card layout */}
          <div className="flex flex-col gap-2 md:hidden">
            {h.items.map((item) => (
              <div key={item.id} className="rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{item.categoria ?? '-'}</span>
                  <span className="font-mono text-sm">{formatBRL(item.valor)}</span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{formatDateBR(item.dataReferencia)}</div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <EntregadorCelula item={item} podeVerDetalhe={podeVerDetalheMotorista} />
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
          <div className="hidden rounded-lg border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data referência</TableHead>
                  <TableHead>Categoria</TableHead>
                  <TableHead className="text-right">Valor</TableHead>
                  <TableHead>Entregador</TableHead>
                  <TableHead>Subpraça</TableHead>
                  <TableHead>Praça</TableHead>
                  <TableHead>Período</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {h.items.map((item) => (
                  <TableRow key={item.id} className="hover:bg-muted/50">
                    <TableCell className="text-sm">{formatDateBR(item.dataReferencia)}</TableCell>
                    <TableCell className="max-w-[220px] truncate">{item.categoria ?? '-'}</TableCell>
                    <TableCell className="text-right font-mono">{formatBRL(item.valor)}</TableCell>
                    <TableCell>
                      <EntregadorCelula item={item} podeVerDetalhe={podeVerDetalheMotorista} />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{item.subpraca ?? '-'}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{item.praca ?? '-'}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{item.periodo ?? '-'}</TableCell>
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
