'use client';

// hub-importacoes (S4) FASE 6 task 6.1 — rota `/hub/dashboard/importacoes`:
// histórico paginado (tabela + filtros) + entrada do wizard de upload.
//
// Nota de correção de rota (tasks.md FASE 6): `plan.md` §Project Structure
// lista `app/hub/importacoes/page.tsx`, mas a convenção real do shell (S3,
// `lib/hub/module-nav.ts` `moduloParaRota`) é `/hub/dashboard/<codigo>` —
// esta é a rota REAL. Módulo `importacoes` já semeado (0007), ícone `Upload`
// já mapeado em `ICON_MAP` — nenhuma mudança em `module-nav.ts` necessária.
//
// Ref: docs/specs/hub-importacoes/plan.md §Plano por fases item 6,
// contracts/importacoes-api.md §GET /importacoes.

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  ChevronRight,
  Clock,
  FileText,
  UploadCloud,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { ImportWizard, useImportWizard } from '@/components/hub/import-wizard';
import { PageHeader } from '@/components/hub/page-header';
import { EmptyState } from '@/components/hub/empty-state';
import { SelectFiltro } from '@/components/hub/select-filtro';
import { PaginationControls } from '@/components/pagination-controls';
import { FilterBar } from '@/components/hub/filter-bar';
import { PeriodFilter } from '@/components/hub/period-filter';
import { UsuarioCombobox } from '@/components/hub/usuario-combobox';
import { ListSkeleton } from '@/components/hub/table-skeleton';
import { ImportacaoStatusBadge } from '@/components/hub/status-badge';
import { listarImportacoes, ImportacaoApiError , type ColunaImportacoes } from '@/lib/hub/importacoes-api';
import {
  STATUS_LABELS,
  TIPO_LABELS,
  TIPOS_IMPORTACAO,
  type ImportacaoListItem,
  type StatusImportacao,
  type TipoImportacao,
} from '@/lib/hub/importacoes-dto';
import { useDebounce } from '@/hooks/use-debounce';
import { useFiltrosUrl } from '@/hooks/use-filtros-url';
import { proximaOrdenacao } from '@/lib/utils';
import { CabecalhoOrdenavel } from '@/components/hub/cabecalho-ordenavel';
import { formatDateBR } from '@/lib/utils';

const STATUS_OPCOES: StatusImportacao[] = [
  'pending',
  'validating',
  'processing',
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
];

const PAGE_SIZE = 20;

export interface ImportacoesFiltros {
  tipo: TipoImportacao | '';
  status: StatusImportacao | '';
  responsavel: string;
  de: string;
  ate: string;
  // rodada 16: ordenação junto dos filtros — herda a URL (r14).
  ordenarPor: '' | ColunaImportacoes;
  direcao: '' | 'asc' | 'desc';
}

const FILTROS_INICIAIS: ImportacoesFiltros = {
  tipo: '',
  status: '',
  responsavel: '',
  de: '',
  ate: '',
  ordenarPor: '',
  direcao: '',
};

// Enquanto houver importação nestes status, a lista se atualiza sozinha —
// o operador acompanha o processamento sem F5 (impeccable harden 2026-08-06).
const STATUS_EM_ANDAMENTO: readonly StatusImportacao[] = ['pending', 'validating', 'processing'];
const POLL_INTERVALO_MS = 10_000;

/** Lógica isolada do JSX (mesmo padrão de `usePerfil`/`useEntitySwitcher`). */
export function useImportacoesHistorico() {
  // rodada 14 (h3): filtro e página na URL — "Voltar ao histórico" devolve o
  // histórico como estava (ver `use-filtros-url.ts`).
  const {
    filtros,
    page,
    setFiltros,
    setPage,
    limpar: resetFiltros,
  } = useFiltrosUrl<ImportacoesFiltros>(FILTROS_INICIAIS);
  const [items, setItems] = useState<ImportacaoListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [atualizadoEm, setAtualizadoEm] = useState<Date | null>(null);

  // impeccable rodada 2 (P2): antes era 1 fetch por tecla no campo de
  // responsável — o debounce espera a digitação assentar (DEBOUNCE_MS=300).
  const filtrosDebounced = useDebounce(filtros, 300);

  const buscar = useCallback(async (opts?: { silencioso?: boolean }) => {
    // `silencioso` = refresh do polling: sem skeleton, e uma falha transitória
    // não derruba a lista que o operador está acompanhando.
    const silencioso = opts?.silencioso === true;
    if (!silencioso) {
      setCarregando(true);
      setErro(null);
    }
    try {
      const resposta = await listarImportacoes({
        tipo: filtrosDebounced.tipo || undefined,
        status: filtrosDebounced.status || undefined,
        responsavel: filtrosDebounced.responsavel || undefined,
        de: filtrosDebounced.de ? new Date(`${filtrosDebounced.de}T00:00:00`).toISOString() : undefined,
        ate: filtrosDebounced.ate ? new Date(`${filtrosDebounced.ate}T23:59:59`).toISOString() : undefined,
        ordenarPor: filtrosDebounced.ordenarPor || undefined,
        direcao: filtrosDebounced.direcao || undefined,
        page,
        pageSize: PAGE_SIZE,
      });
      setItems(resposta.items);
      setTotal(resposta.total);
      setErro(null);
      setAtualizadoEm(new Date());
    } catch (e) {
      if (!silencioso) {
        setErro(e instanceof ImportacaoApiError ? e.message : 'Não foi possível carregar o histórico de importações.');
        setItems([]);
        setTotal(0);
      }
    } finally {
      if (!silencioso) {
        setCarregando(false);
      }
    }
  }, [filtrosDebounced, page]);

  useEffect(() => {
    buscar();
  }, [buscar]);

  const emAndamento = items.some((item) => STATUS_EM_ANDAMENTO.includes(item.status));

  useEffect(() => {
    if (!emAndamento) return;
    const id = setInterval(() => {
      buscar({ silencioso: true });
    }, POLL_INTERVALO_MS);
    return () => clearInterval(id);
  }, [emAndamento, buscar]);

  const totalPaginas = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Wrapper sem argumentos: consumidores usam `onClick={h.refetch}` e o
  // event de clique não pode vazar para o parâmetro `opts` de `buscar`.
  const refetch = useCallback(() => buscar(), [buscar]);

  const ordem = filtros.ordenarPor
    ? { coluna: filtros.ordenarPor, direcao: (filtros.direcao || 'asc') as 'asc' | 'desc' }
    : null;
  const alternarOrdem = useCallback(
    (coluna: ColunaImportacoes) => {
      const proxima = proximaOrdenacao(
        filtros.ordenarPor ? { coluna: filtros.ordenarPor, direcao: (filtros.direcao || 'asc') as 'asc' | 'desc' } : null,
        coluna
      );
      setFiltros({ ordenarPor: proxima?.coluna ?? '', direcao: proxima?.direcao ?? '' });
    },
    [filtros.ordenarPor, filtros.direcao, setFiltros]
  );

  return {
    filtros,
    setFiltros,
    ordem,
    alternarOrdem,
    resetFiltros,
    page,
    setPage,
    totalPaginas,
    items,
    total,
    carregando,
    erro,
    atualizadoEm,
    emAndamento,
    refetch,
  };
}

function LinhaAguardandoLock() {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label="Aguardando outra importação do mesmo tipo terminar"
        className="ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-xs font-medium text-muted-foreground hover:bg-muted"
      >
        <Clock className="size-3.5" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <p>Aguardando outra importação do mesmo tipo terminar (lock ocupado).</p>
      </TooltipContent>
    </Tooltip>
  );
}

function StatusBadge({ item }: { item: ImportacaoListItem }) {
  return (
    <span className="inline-flex items-center">
      <ImportacaoStatusBadge status={item.status} />
      {/* 6.5 — dec-032/CHK013: sinal adicional distinguindo "pending recém-criado"
          de "pending aguardando lock", sem introduzir novo estado na máquina. */}
      {item.aguardandoLock && <LinhaAguardandoLock />}
    </span>
  );
}

function ImportacoesConteudo() {
  const { permissoes } = useHubAuth();
  const podeCriar = permissoes.includes('importacoes.criar');
  const h = useImportacoesHistorico();
  // Hook do wizard criado na página (uiux-hub F2) para o empty state também
  // poder abrir o diálogo — mesmo idioma de useVinculoMotoristaDialog.
  const wizard = useImportWizard(() => h.refetch());
  // uiux-hub F3: a linha inteira navega (o hover já sugeria clique); o link
  // "Detalhes" permanece como caminho de teclado/leitor de tela.
  const router = useRouter();

  return (
    <div className="mx-auto flex w-full max-w-[96rem] flex-col gap-4 p-4 sm:p-6 lg:p-8">
      <PageHeader titulo="Importações" subtitulo="Histórico de importações de faturamento e performance.">
        <ImportWizard podeCriar={podeCriar} state={wizard} />
      </PageHeader>

      {/* Filtros */}
      <FilterBar
        gridClassName="grid-cols-1 xs:grid-cols-2 lg:grid-cols-5"
        onClear={h.resetFiltros}
        filtrosAtivos={Object.values(h.filtros).filter((v) => v !== '').length}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="importacoes-filtro-tipo" className="text-xs text-muted-foreground">
            Tipo
          </label>
          <SelectFiltro
            id="importacoes-filtro-tipo"
            ariaLabel="Tipo"
            value={h.filtros.tipo}
            onChange={(v) => h.setFiltros({ tipo: v as TipoImportacao | '' })}
            opcoes={[
              { value: '', label: 'Todos' },
              ...TIPOS_IMPORTACAO.map((t) => ({ value: t, label: TIPO_LABELS[t] })),
            ]}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="importacoes-filtro-status" className="text-xs text-muted-foreground">
            Status
          </label>
          <SelectFiltro
            id="importacoes-filtro-status"
            ariaLabel="Status"
            value={h.filtros.status}
            onChange={(v) => h.setFiltros({ status: v as StatusImportacao | '' })}
            opcoes={[
              { value: '', label: 'Todos' },
              ...STATUS_OPCOES.map((s) => ({ value: s, label: STATUS_LABELS[s] })),
            ]}
          />
        </div>

        <div className="flex flex-col gap-1">
          {/* impeccable rodada 4 (h6): mesmo componente da auditoria. Aqui a
              degradação importa de verdade — o papel `operador` tem o módulo
              de importações e NÃO tem `usuarios.gerenciar`, então para ele o
              combobox se apresenta como o campo de ID de sempre. */}
          <span id="importacoes-filtro-responsavel-label" className="text-xs text-muted-foreground">
            Responsável
          </span>
          <UsuarioCombobox
            id="importacoes-filtro-responsavel"
            aria-labelledby="importacoes-filtro-responsavel-label"
            ariaLabel="Filtrar por responsável pela importação"
            value={h.filtros.responsavel}
            onChange={(v) => h.setFiltros({ responsavel: v })}
          />
        </div>

        <PeriodFilter
          className="xs:col-span-2"
          idPrefix="importacoes-filtro"
          de={h.filtros.de}
          ate={h.filtros.ate}
          onChange={(intervalo) => h.setFiltros(intervalo)}
          legenda="da importação"
        />
      </FilterBar>

      {/* Enquanto há importação em andamento, a lista se atualiza sozinha
          (polling silencioso do hook) — este texto diz isso ao operador.
          Sem live region: o badge de status da linha já comunica a mudança;
          anunciar a cada 10s viraria ruído de leitor de tela. */}
      {!h.carregando && h.emAndamento && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="size-3.5" aria-hidden="true" />
          Importação em andamento — a lista atualiza sozinha a cada 10 segundos
          {h.atualizadoEm ? ` · última atualização às ${h.atualizadoEm.toLocaleTimeString('pt-BR')}` : ''}.
        </p>
      )}

      {/* Conteúdo */}
      {h.carregando ? (
        <ListSkeleton label="Carregando importações..." />
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
          icone={FileText}
          titulo="Nenhuma importação encontrada"
          dica="Ajuste os filtros ou importe um novo arquivo."
        >
          {podeCriar && (
            <Button size="sm" className="min-h-11 gap-1.5 sm:min-h-8" onClick={() => wizard.setOpen(true)}>
              <UploadCloud className="size-4" aria-hidden="true" />
              Nova importação
            </Button>
          )}
        </EmptyState>
      ) : (
        <>
          {/* Mobile card layout */}
          <div className="flex flex-col gap-2 md:hidden">
            {h.items.map((item) => (
              <Link
                key={item.id}
                href={`/hub/dashboard/importacoes/${item.id}`}
                className="rounded-lg border p-3 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{TIPO_LABELS[item.tipo]}</span>
                  <StatusBadge item={item} />
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">{item.nomeArquivo}</p>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>Total: {item.totalLinhas ?? '-'}</span>
                  <span>Válidas: {item.linhasValidas ?? '-'}</span>
                  <span>Inválidas: {item.linhasInvalidas ?? '-'}</span>
                  {item.dataReferencia && <span>{formatDateBR(item.dataReferencia)}</span>}
                </div>
              </Link>
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden rounded-lg border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <CabecalhoOrdenavel coluna="tipo" rotulo="Tipo" ordem={h.ordem} onOrdenar={h.alternarOrdem} />
                  <CabecalhoOrdenavel coluna="status" rotulo="Status" ordem={h.ordem} onOrdenar={h.alternarOrdem} />
                  <CabecalhoOrdenavel coluna="nome_arquivo" rotulo="Arquivo" ordem={h.ordem} onOrdenar={h.alternarOrdem} />
                  <CabecalhoOrdenavel coluna="total_linhas" rotulo="Total" ordem={h.ordem} onOrdenar={h.alternarOrdem} className="text-right" />
                  <TableHead className="text-right">Válidas</TableHead>
                  <TableHead className="text-right">Inválidas</TableHead>
                  <CabecalhoOrdenavel coluna="data_referencia" rotulo="Data referência" ordem={h.ordem} onOrdenar={h.alternarOrdem} />
                  <TableHead>Duração</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {h.items.map((item) => (
                  <TableRow
                    key={item.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => router.push(`/hub/dashboard/importacoes/${item.id}`)}
                  >
                    <TableCell>{TIPO_LABELS[item.tipo]}</TableCell>
                    <TableCell>
                      <StatusBadge item={item} />
                    </TableCell>
                    <TableCell className="max-w-[220px] truncate">{item.nomeArquivo}</TableCell>
                    <TableCell className="text-right font-mono">{item.totalLinhas ?? '-'}</TableCell>
                    <TableCell className="text-right font-mono">{item.linhasValidas ?? '-'}</TableCell>
                    <TableCell className="text-right font-mono">{item.linhasInvalidas ?? '-'}</TableCell>
                    <TableCell className="text-sm">{formatDateBR(item.dataReferencia)}</TableCell>
                    <TableCell className="text-sm">
                      {item.duracaoSegundos !== null ? `${item.duracaoSegundos}s` : '-'}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link
                        href={`/hub/dashboard/importacoes/${item.id}`}
                        className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                      >
                        Detalhes
                        <ChevronRight className="size-3.5" aria-hidden="true" />
                      </Link>
                    </TableCell>
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

// rodada 14: `useFiltrosUrl` usa `useSearchParams`, e o Next reprova o
// prerender de página sem boundary ("should be wrapped in a suspense
// boundary"). O fallback é o mesmo esqueleto que a tela já usa enquanto
// carrega — nada novo aparece para quem olha.
export default function ImportacoesPage() {
  return (
    <Suspense>
      <ImportacoesConteudo />
    </Suspense>
  );
}
