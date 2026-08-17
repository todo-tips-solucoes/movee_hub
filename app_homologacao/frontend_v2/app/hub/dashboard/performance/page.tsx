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

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { LARGURA_LISTA } from '@/lib/hub/larguras';
import { PageHeader } from '@/components/hub/page-header';
import { FilterBar } from '@/components/hub/filter-bar';
import { EmptyState } from '@/components/hub/empty-state';
import { FunilCorridas } from '@/components/hub/funil-corridas';
import { MetaBadge } from '@/components/hub/meta-badge';
import {
  INDICADORES_META,
  chaveMeta,
  leiturasDoRegistro,
  listarMetas,
  type MetaPerformance,
} from '@/lib/hub/performance-metas-api';
import { SelectFiltro } from '@/components/hub/select-filtro';
import { KpiCard } from '@/components/hub/kpi-card';
import { PaginationControls } from '@/components/pagination-controls';
import { PeriodFilter } from '@/components/hub/period-filter';
import { KpiSkeleton, ListSkeleton } from '@/components/hub/table-skeleton';
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Clock,
  Download,
  Percent,
  Target,
  TrendingUp,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
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
  baixarPerformanceCsv,
  buscarEntregadoresPerformance,
  listarAreasPerformance,
  listarPerformance,
  obterPerformanceResumo,
  obterPerformanceResumoAgrupado,
  PerformanceApiError,
  type PerformanceFiltros,
} from '@/lib/hub/performance-api';
import { EntregadorCombobox } from '@/components/hub/entregador-combobox';
import type {
  PerformanceGroupBy,
  PerformanceListItem,
  PerformanceResumoCards,
  PerformanceResumoGrupo,
} from '@/lib/hub/performance-dto';
import { HorizontalBarChart } from '@/components/hub/bar-chart';
import { Skeleton } from '@/components/ui/skeleton';
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
  /** Nome exibido no `EntregadorCombobox` — WS-B (tasks.md 2.4), espelho de
   * `faturamento/page.tsx#FaturamentoFiltrosUI.entregadorNome`. */
  entregadorNome: string;
}

const FILTROS_INICIAIS: PerformanceFiltrosUI = {
  de: '',
  ate: '',
  periodo: '',
  subpraca: '',
  entregadorId: '',
  entregadorNome: '',
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

/** Contador inteiro com separador de milhar pt-BR (`12345` -> `"12.345"`);
 * `null` -> `"-"` — paridade de formatação com os percentuais acima. */
function formatInt(valor: number | null | undefined): string {
  if (valor === null || valor === undefined) return '-';
  return valor.toLocaleString('pt-BR');
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

  // impeccable rodada 2 (P2): antes era 1 fetch por tecla nos campos de texto
  // — o debounce espera a digitação assentar (DEBOUNCE_MS=300 do combobox).
  const filtrosDebounced = useDebounce(filtros, 300);

  const filtrosApi = useCallback(
    () => ({
      de: filtrosDebounced.de || undefined,
      ate: filtrosDebounced.ate || undefined,
      periodo: filtrosDebounced.periodo || undefined,
      subpraca: filtrosDebounced.subpraca || undefined,
      entregadorId: filtrosDebounced.entregadorId ? Number(filtrosDebounced.entregadorId) : undefined,
    }),
    [filtrosDebounced]
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

/**
 * Nome do entregador, navegável para a ficha (impeccable r24).
 *
 * Isto REVERTE a research Decision 11 desta feature ("NENHUM link para
 * /hub/dashboard/motoristas/:id — o nome aqui é texto simples, nunca
 * navegável"), por decisão explícita do operador em 2026-08-16: chegar à
 * pessoa a partir do desempenho do turno passou a ser necessário. O gate de
 * permissão é o mesmo do faturamento (`motoristas.consultar`) — sem ele, o
 * nome volta a ser texto, e ninguém é mandado para um 403.
 */
function EntregadorNome({
  item,
  podeVerDetalhe,
}: {
  item: PerformanceListItem;
  podeVerDetalhe: boolean;
}) {
  const rotulo = item.entregadorNome ?? `#${item.entregadorId}`;
  if (!podeVerDetalhe || item.entregadorId === null) {
    return <span className="text-sm">{rotulo}</span>;
  }
  return (
    <Link
      href={`/hub/dashboard/motoristas/${item.entregadorId}`}
      className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
    >
      {rotulo}
      <ChevronRight className="size-3.5" aria-hidden="true" />
    </Link>
  );
}

/**
 * As marcas de meta de um registro (impeccable r24 parte 2). Fica ao lado do
 * funil porque é o mesmo assunto: o funil diz o que aconteceu, a marca diz se
 * aquilo cumpre o combinado. Silenciosa quando não há meta configurada ou
 * quando falta leitura — ver `MetaBadge`.
 */
function MarcasDeMeta({
  item,
  metasPorChave,
}: {
  item: PerformanceListItem;
  metasPorChave: Map<string, number>;
}) {
  const leituras = leiturasDoRegistro(item);
  const marcas = INDICADORES_META.map((ind) => ({
    id: ind.id,
    rotulo: ind.rotulo,
    valor: leituras[ind.id],
    meta: metasPorChave.get(chaveMeta(item.praca ?? '', item.periodo ?? '', ind.id)),
  })).filter((m) => m.valor !== null && m.meta !== undefined);

  if (marcas.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {marcas.map((m) => (
        <MetaBadge key={m.id} valor={m.valor} meta={m.meta} rotulo={m.rotulo} />
      ))}
    </div>
  );
}

function CardsResumo({ cards }: { cards: PerformanceResumoCards }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <KpiCard
        label="Corridas completadas"
        value={formatInt(cards.corridasCompletadas)}
        icon={CheckCircle2}
      />
      <KpiCard
        label="Taxa de aceitação"
        value={formatFracaoPct(cards.taxaAceitacao)}
        icon={TrendingUp}
      />
      <KpiCard
        label="Taxa de conclusão"
        value={formatFracaoPct(cards.taxaConclusao)}
        icon={Percent}
      />
      <KpiCard
        label="Tempo disponível médio"
        value={formatPontoPct(cards.tempoDisponivelMedio)}
        icon={Clock}
      />
    </div>
  );
}

/** uiux-hub F4 — corridas completadas por dia/período, consumindo
 * `GET /performance/resumo?groupBy=...` (agregação 100% no backend, mesmos
 * filtros da lista; endpoint já existia no contrato e estava sem consumidor). */
function DistribuicaoPerformance({ filtrosApi }: { filtrosApi: () => PerformanceFiltros }) {
  const [groupBy, setGroupBy] = useState<Extract<PerformanceGroupBy, 'dia' | 'periodo'>>('dia');
  const [grupos, setGrupos] = useState<PerformanceResumoGrupo[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  // Mesmo idioma dos hooks de lista (buscar em useCallback + useEffect).
  const buscar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const r = await obterPerformanceResumoAgrupado(groupBy, filtrosApi());
      setGrupos(r.grupos);
    } catch (e) {
      setGrupos([]);
      setErro(e instanceof PerformanceApiError ? e.message : 'Não foi possível carregar a distribuição.');
    } finally {
      setCarregando(false);
    }
  }, [groupBy, filtrosApi]);

  useEffect(() => {
    buscar();
  }, [buscar]);

  // Ordenação SÓ de apresentação: dia = cronológico; período = maiores primeiro.
  const dados = [...grupos]
    .sort((a, b) =>
      groupBy === 'dia' ? a.chave.localeCompare(b.chave) : b.corridasCompletadas - a.corridasCompletadas
    )
    .map((g) => ({
      chave: g.chave,
      rotulo: groupBy === 'dia' ? formatDateBR(g.chave) || g.rotulo : g.rotulo,
      valor: g.corridasCompletadas,
      valorFormatado: formatInt(g.corridasCompletadas),
    }));

  return (
    <Card size="sm">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-sm text-muted-foreground">Corridas completadas</CardTitle>
        <div className="flex gap-1" role="group" aria-label="Agrupar corridas completadas por">
          <Button
            size="sm"
            variant={groupBy === 'dia' ? 'default' : 'outline'}
            className="min-h-11 sm:min-h-7"
            aria-pressed={groupBy === 'dia'}
            onClick={() => setGroupBy('dia')}
          >
            Por dia
          </Button>
          <Button
            size="sm"
            variant={groupBy === 'periodo' ? 'default' : 'outline'}
            className="min-h-11 sm:min-h-7"
            aria-pressed={groupBy === 'periodo'}
            onClick={() => setGroupBy('periodo')}
          >
            Por período
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
            titulo={groupBy === 'dia' ? 'Corridas completadas por dia' : 'Corridas completadas por período'}
            dados={dados}
            corVar="--chart-2"
            // impeccable r22 (P3): mesma frase da lista logo abaixo — antes
            // gráfico e tabela diziam o mesmo vazio de dois jeitos.
            mensagemVazia="Nenhum registro de turno no período selecionado."
          />
        )}
      </CardContent>
    </Card>
  );
}

export default function PerformancePage() {
  const { permissoes } = useHubAuth();
  const podeExportar = permissoes.includes('performance.exportar');
  // impeccable r22 (P2): saída do estado vazio — ver o `EmptyState` abaixo.
  const podeImportar = permissoes.includes('importacoes.consultar');
  // impeccable r24: mesmo gate do faturamento para chegar à ficha da pessoa.
  const podeVerDetalheMotorista = permissoes.includes('motoristas.consultar');
  const podeGerenciarMetas = permissoes.includes('performance.metas_gerenciar');

  // impeccable r24 parte 2: as metas do cruzamento praça × turno. Carregadas
  // uma vez (são poucas por entidade) e casadas por linha no render.
  //
  // A falha DEIXOU de ser silenciosa (revisão adversarial, 2026-08-16). Antes
  // o catch caía em `[]`, produzindo exatamente a tela de quem nunca
  // configurou meta — e o comentário anterior tratava isso como desejável. Não
  // é: o estado de quem nunca configurou é VERDADEIRO; este é DESCONHECIDO
  // apresentado como verdadeiro. Um turno reprovado deixava de ser reprovado e
  // ninguém ficava sabendo, numa tela cujo número vira cobrança contratual.
  const [metas, setMetas] = useState<MetaPerformance[]>([]);
  const [metasIndisponiveis, setMetasIndisponiveis] = useState(false);
  const carregarMetas = useCallback(() => {
    setMetasIndisponiveis(false);
    listarMetas()
      .then((m) => setMetas(m))
      .catch(() => {
        setMetas([]);
        setMetasIndisponiveis(true);
      });
  }, []);
  useEffect(() => {
    carregarMetas();
  }, [carregarMetas]);
  const metasPorChave = useMemo(
    () => new Map(metas.map((m) => [chaveMeta(m.praca, m.periodo, m.indicador), m.valor])),
    [metas]
  );
  const h = usePerformanceLista();
  // impeccable r22 (P2): idem faturamento — ver o `EmptyState` mais abaixo.
  const temFiltroAtivo = Object.entries(h.filtros).some(
    ([chave, valor]) => chave !== 'entregadorNome' && valor !== ''
  );
  const [exportando, setExportando] = useState(false);
  const [erroExport, setErroExport] = useState<string | null>(null);
  // WS-B (tasks.md 2.3.5, FR-010, D-B1): degradação sticky — espelho de
  // faturamento/page.tsx.
  const [entregadorBuscaIndisponivel, setEntregadorBuscaIndisponivel] = useState(false);
  // uiux-hub pós-F4: filtro "Subpraça" como combobox — opções de GET
  // /performance/areas; falha na carga degrada para só "Todas".
  const [areasOpcoes, setAreasOpcoes] = useState<string[]>([]);
  useEffect(() => {
    let ativo = true;
    listarAreasPerformance()
      .then((areas) => { if (ativo) setAreasOpcoes(areas); })
      .catch(() => { if (ativo) setAreasOpcoes([]); });
    return () => { ativo = false; };
  }, []);

  const exportarCsv = useCallback(async () => {
    setExportando(true);
    setErroExport(null);
    try {
      await baixarPerformanceCsv(h.filtrosApi());
      toast.success('Exportação CSV iniciada.');
    } catch (e) {
      setErroExport(e instanceof PerformanceApiError ? e.message : 'Não foi possível exportar o CSV.');
    } finally {
      setExportando(false);
    }
  }, [h]);

  return (
    <div className={`mx-auto flex w-full ${LARGURA_LISTA} flex-col gap-4 p-4 sm:p-6 lg:p-8`}>
      <PageHeader titulo="Performance" subtitulo="Registros de turno importados: ofertas, aceites, conclusões e tempo disponível por entregador.">
        {podeGerenciarMetas && (
          <Link
            href="/hub/dashboard/performance/metas"
            className={buttonVariants({
              variant: 'outline',
              size: 'sm',
              className: 'min-h-11 gap-1.5 sm:min-h-8',
            })}
          >
            <Target className="size-4" aria-hidden="true" />
            Metas
          </Link>
        )}
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

      {metasIndisponiveis && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning-strong"
        >
          <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
          <p className="min-w-0 flex-1">
            Metas indisponíveis: <strong className="font-medium">nenhuma linha foi avaliada</strong>{' '}
            nesta carga. Os números abaixo continuam corretos.
          </p>
          <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={carregarMetas}>
            Tentar novamente
          </Button>
        </div>
      )}

      {erroExport && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {erroExport}
        </div>
      )}

      {h.carregando ? (
        <KpiSkeleton label="Carregando indicadores de performance..." cards={4} />
      ) : (
        <CardsResumo cards={h.cards} />
      )}

      {/* impeccable r22 (P2): mesma correção de faturamento — filtros antes do
          gráfico que eles governam, e `FilterBar` no lugar do container
          artesanal, para o "Limpar" desabilitar em zero e contar os ativos. */}
      <FilterBar
        gridClassName="grid-cols-1 xs:grid-cols-2 lg:grid-cols-5"
        onClear={h.resetFiltros}
        filtrosAtivos={
          Object.entries(h.filtros).filter(
            ([chave, valor]) => chave !== 'entregadorNome' && valor !== ''
          ).length
        }
        nota={
          <>
            Os filtros de período usam a <strong>data do turno</strong> (não a data de importação).
          </>
        }
      >
          <PeriodFilter
            className="xs:col-span-2"
            idPrefix="performance-filtro"
            de={h.filtros.de}
            ate={h.filtros.ate}
            onChange={(intervalo) => h.setFiltros(intervalo)}
            rotuloDe="De (data do turno)"
            rotuloAte="Até (data do turno)"
            legenda="do turno"
            // Mesma janela do faturamento: `JANELA_PADRAO_DIAS = 30` em
            // lib/hub-performance-dto.js. A tela dizia "todo o período
            // disponível" e mostrava 30 dias (impeccable r23/r24).
            janelaPadraoDias={30}
          />

          <div className="flex flex-col gap-1">
            <label htmlFor="performance-filtro-periodo" className="text-xs text-muted-foreground">
              Turno (período)
            </label>
            <Input
              id="performance-filtro-periodo"
              value={h.filtros.periodo}
              onChange={(e) => h.setFiltros({ periodo: e.target.value })}
              placeholder="Ex.: ALMOCO 11H30-15H29"
              list="performance-turnos-na-pagina"
              className="h-11 sm:h-9"
            />
            {/* impeccable r22 (P2): idêntico ao filtro de categoria em
                faturamento — igualdade exata em texto livre, ao lado de um
                select populado. Aqui a string é ainda mais difícil de decorar
                (`ALMOCO 11H30-15H29`). Opções tiradas dos registros já
                carregados; ceiling e caminho de saída no comentário gêmeo. */}
            <datalist id="performance-turnos-na-pagina">
              {Array.from(
                new Set(h.items.map((i) => i.periodo).filter((p): p is string => !!p))
              )
                .sort((a, b) => a.localeCompare(b, 'pt-BR'))
                .map((p) => (
                  <option key={p} value={p} />
                ))}
            </datalist>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="performance-filtro-subpraca" className="text-xs text-muted-foreground">
              Subpraça
            </label>
            <SelectFiltro
              id="performance-filtro-subpraca"
              ariaLabel="Subpraça"
              value={h.filtros.subpraca}
              onChange={(subpraca) => h.setFiltros({ subpraca })}
              opcoes={[
                { value: '', label: 'Todas' },
                ...areasOpcoes.map((area) => ({ value: area, label: area })),
              ]}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="performance-filtro-entregador" className="text-xs text-muted-foreground">
              Entregador
            </label>
            {entregadorBuscaIndisponivel ? (
              // WS-B degradação (FR-010, D-B1): busca indisponível -> volta
              // ao input numérico original, sem quebrar a tela.
              <Input
                id="performance-filtro-entregador"
                type="number"
                min={1}
                value={h.filtros.entregadorId}
                onChange={(e) => h.setFiltros({ entregadorId: e.target.value, entregadorNome: '' })}
                placeholder="ID do entregador (ex.: 42)"
                className="h-11 sm:h-9"
              />
            ) : (
              <EntregadorCombobox
                id="performance-filtro-entregador"
                value={h.filtros.entregadorId ? Number(h.filtros.entregadorId) : null}
                nomeSelecionado={h.filtros.entregadorNome || null}
                buscar={buscarEntregadoresPerformance}
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
      </FilterBar>

      <DistribuicaoPerformance filtrosApi={h.filtrosApi} />

      {/* Conteúdo */}
      {h.carregando ? (
        <ListSkeleton label="Carregando performance..." />
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
          icone={TrendingUp}
          titulo="Nenhum registro de turno no período selecionado"
          dica={
            temFiltroAtivo
              ? 'Nenhum registro corresponde aos filtros atuais.'
              : 'Os turnos aparecem aqui depois de uma importação de performance.'
          }
        >
          {temFiltroAtivo ? (
            <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={h.resetFiltros}>
              Limpar filtros
            </Button>
          ) : (
            podeImportar && (
              <Link
                href="/hub/dashboard/importacoes"
                className={buttonVariants({ size: 'sm', className: 'min-h-11 sm:min-h-8' })}
              >
                Ir para Importações
              </Link>
            )
          )}
        </EmptyState>
      ) : (
        <>
          {/* Mobile card layout */}
          <div className="flex flex-col gap-2 md:hidden">
            {h.items.map((item) => (
              <div key={item.id} className="rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    <EntregadorNome item={item} podeVerDetalhe={podeVerDetalheMotorista} />
                  </span>
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
                {/* impeccable r24: as marcas de meta existiam SÓ na tabela
                    desktop — em 390px a feature simplesmente não existia,
                    enquanto a tela de metas prometia por escrito que o que
                    fica abaixo é destacado na Performance. Achado adversarial. */}
                <MarcasDeMeta item={item} metasPorChave={metasPorChave} />
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
                  {/* impeccable r24: eram cinco colunas de contador solto —
                      Ofertadas/Aceitas/Rejeitadas/Completadas/Canceladas —
                      que na verdade são UM funil. Ler os cinco números e
                      montar a história era trabalho empurrado para a pessoa,
                      e a tabela tinha 13 colunas fixas sem controle nenhum. */}
                  <TableHead>Funil de corridas</TableHead>
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
                    <TableCell className="text-sm">
                      <EntregadorNome item={item} podeVerDetalhe={podeVerDetalheMotorista} />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{item.subpraca ?? '-'}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{item.praca ?? '-'}</TableCell>
                    <TableCell>
                      <FunilCorridas
                        dados={{
                          ofertadas: item.corridasOfertadas,
                          aceitas: item.corridasAceitas,
                          rejeitadas: item.corridasRejeitadas,
                          completadas: item.corridasCompletadas,
                          canceladas: item.corridasCanceladas,
                        }}
                      />
                      <MarcasDeMeta item={item} metasPorChave={metasPorChave} />
                    </TableCell>
                    <TableCell className="text-right font-mono">{formatInt(item.pedidosConcluidos)}</TableCell>
                    <TableCell className="text-right">{formatPontoPct(item.tempoDisponivelPct)}</TableCell>
                    <TableCell className="text-right font-mono">{formatBRL(item.taxas)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Paginação — idioma único do produto (impeccable rodada 4, h4). */}
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
