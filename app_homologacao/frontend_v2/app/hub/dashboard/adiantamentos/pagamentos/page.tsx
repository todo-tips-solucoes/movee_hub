'use client';

// adiantamento-motorista — app/hub/dashboard/adiantamentos/pagamentos/page.tsx
// (tasks.md 7.6, H08–H11): montagem de lote de pagamento em DOIS passos
// dentro do mesmo arquivo (sem rotas `/novo`, `/novo/revisao` do protótipo —
// plan.md Project Structure F7 lista só este `page.tsx` para H08–H11; estado
// local `step` faz o papel de wizard):
//   1. "selecao" (H08+H09): lista de solicitações LIBERADA com seleção por
//      página ou "todas as N do filtro" (`use-selecao-lote.ts`, cross-página
//      — a listagem pagina no máximo 100 por vez).
//   2. "previa" (H10+H11 fundidas): `POST /lotes/previa` mostra aptas E
//      pendências na MESMA tela (o protótipo separa H10/H11 em rotas; aqui a
//      seção de pendências fica inline, expansível, sem rota própria — YAGNI,
//      nenhuma task pede navegação dedicada).
//
// Divergências do protótipo (Constitution VI — nunca fabricar o que a API
// não devolve):
// - `SolicitacaoResumo` (lista H09) não traz banco/agência/conta — só
//   `GET /lotes/previa` devolve `bancoAgenciaContaMascarados` (`LinhaPrevia`).
//   A tabela de seleção mostra só o que a API lista tem.
// - A barra de seleção NUNCA soma os valores no cliente (`valorLiquido` é
//   string, nunca somada/recalculada — FR bancário) — só mostra a contagem;
//   o total aparece na prévia, já somado pelo backend (`totalApto`).
// - Motivos de pendência são os 4 códigos REAIS de `hub_adiantamento_lote_previa`
//   (infra/hub/migrations/0067:1472-1490): `JA_EM_LOTE`, `VALOR_INVALIDO`,
//   `STATUS_<status>`, e `DUPLICADA_NA_SELECAO` (adicionado pela própria rota
//   para duplicatas na seleção) — não a lista de 15 motivos "aspiracionais"
//   do mock (dígito ausente, banco não identificado etc., que a validação
//   bancária já resolve no cadastro da conta, não aqui).
//
// Ref: docs/specs/adiantamento-motorista/contracts/hub-api.md §Pagamentos e
// lotes; spec.md US5/FR-026..FR-032, edge #12-15, #25; prototipo H08-H11.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertCircle, ArrowLeft, ArrowRight, Inbox, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox, CHECKBOX_ALVO_44 } from '@/components/ui/checkbox';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
import { AdiantamentosAbas } from '@/components/hub/adiantamentos-abas';
import { rotuloStatusAdiantamento } from '@/components/hub/status-badge';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { useDebounce } from '@/hooks/use-debounce';
import { LIMITE_LOTE, useSelecaoLote } from '@/hooks/use-selecao-lote';
import { LARGURA_LISTA } from '@/lib/hub/larguras';
import {
  AdiantamentosApiError,
  criarLote,
  listarSolicitacoes,
  previaLote,
  type PreviaLoteResponse,
  type SolicitacaoResumo,
  type SolicitacoesFiltros,
} from '@/lib/hub/adiantamentos-api';
import { formatBRL, formatDateBR } from '@/lib/utils';

const PAGE_SIZE = 20;

interface Filtros {
  de: string;
  ate: string;
  busca: string;
}

const FILTROS_INICIAIS: Filtros = { de: '', ate: '', busca: '' };

/** Motivo de pendência → rótulo pt-BR. Só os códigos REAIS (ver cabeçalho do
 * arquivo); desconhecido cai no próprio código (fail-safe, Constitution VI). */
function rotuloPendencia(codigo: string): string {
  if (codigo === 'JA_EM_LOTE') return 'Já está em outro lote';
  if (codigo === 'VALOR_INVALIDO') return 'Valor calculado inválido (zero ou negativo)';
  if (codigo === 'DUPLICADA_NA_SELECAO') return 'Duplicada na seleção';
  if (codigo === 'CONTA_ALTERADA') return 'Conta bancária alterada — revisar antes de incluir no lote';
  if (codigo.startsWith('STATUS_')) return `Status atual: ${rotuloStatusAdiantamento(codigo.slice('STATUS_'.length))}`;
  return codigo;
}

/** Lógica isolada do JSX (mesmo padrão de `useContasLista`). Só solicitações
 * `LIBERADA` entram aqui — é o universo elegível para lote (H08). */
export function usePagamentosLista() {
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

  const filtrosApi: SolicitacoesFiltros = useMemo(() => ({
    status: 'LIBERADA',
    de: filtrosDebounced.de || undefined,
    ate: filtrosDebounced.ate || undefined,
    busca: filtrosDebounced.busca || undefined,
  }), [filtrosDebounced]);

  const buscar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const resposta = await listarSolicitacoes({ ...filtrosApi, page, pageSize: PAGE_SIZE });
      setItens(resposta.itens);
      setTotal(resposta.total);
    } catch (e) {
      setErro(e instanceof AdiantamentosApiError ? e.message : 'Não foi possível carregar as solicitações liberadas.');
      setItens([]);
      setTotal(0);
    } finally {
      setCarregando(false);
    }
  }, [filtrosApi, page]);

  useEffect(() => {
    buscar();
  }, [buscar]);

  const totalPaginas = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtrosAtivos = Object.values(filtros).filter((v) => v !== '').length;

  return {
    filtros, setFiltros, resetFiltros, filtrosAtivos, filtrosApi,
    itens, total, page, setPage, totalPaginas, carregando, erro, refetch: buscar,
  };
}

interface EstadoPrevia {
  carregando: boolean;
  erro: string | null;
  dados: PreviaLoteResponse | null;
}

export default function AdiantamentosPagamentosPage() {
  const h = usePagamentosLista();
  const s = useSelecaoLote();
  const router = useRouter();
  const { permissoes } = useHubAuth();
  const podeCriarLote = permissoes.includes('adiantamentos.lote_criar');

  const [step, setStep] = useState<'selecao' | 'previa'>('selecao');
  const [previa, setPrevia] = useState<EstadoPrevia>({ carregando: false, erro: null, dados: null });
  const [dialogGerar, setDialogGerar] = useState(false);
  const [gerando, setGerando] = useState(false);

  const idsSelecionados = useMemo(() => [...s.selecionados], [s.selecionados]);
  const todosDaPaginaSelecionados = h.itens.length > 0 && h.itens.every((i) => s.selecionados.has(i.id));
  const excedeLimite = idsSelecionados.length > LIMITE_LOTE;

  const revisarLote = useCallback(async () => {
    if (idsSelecionados.length === 0 || excedeLimite) return;
    setPrevia({ carregando: true, erro: null, dados: null });
    try {
      const dados = await previaLote(idsSelecionados);
      setPrevia({ carregando: false, erro: null, dados });
      setStep('previa');
    } catch (e) {
      const msg = e instanceof AdiantamentosApiError ? e.message : 'Não foi possível gerar a prévia do lote.';
      setPrevia({ carregando: false, erro: msg, dados: null });
      toast.error(msg);
    }
  }, [idsSelecionados, excedeLimite]);

  const confirmarGerarLote = useCallback(async () => {
    if (!previa.dados || previa.dados.quantidadeApta === 0) return;
    setGerando(true);
    try {
      const lote = await criarLote({
        ids: previa.dados.aptas.map((a) => a.id),
        quantidadeEsperada: previa.dados.quantidadeApta,
        totalEsperado: previa.dados.totalApto,
        chaveIdempotencia: crypto.randomUUID(),
      });
      toast.success(`Lote ${lote.numero} gerado com ${lote.quantidade} pagamento(s).`);
      s.limpar();
      setDialogGerar(false);
      router.push(`/hub/dashboard/adiantamentos/lotes/${lote.id}`);
    } catch (e) {
      if (e instanceof AdiantamentosApiError && e.codigo === 'PREVIA_DESATUALIZADA') {
        toast.error('A prévia mudou desde a última consulta — gerando uma nova.');
        setDialogGerar(false);
        revisarLote();
      } else {
        toast.error(e instanceof AdiantamentosApiError ? e.message : 'Não foi possível gerar o lote.');
      }
    } finally {
      setGerando(false);
    }
  }, [previa.dados, router, s, revisarLote]);

  if (step === 'previa') {
    return (
      <div className={`mx-auto flex w-full ${LARGURA_LISTA} flex-col gap-4 p-4 sm:p-6 lg:p-8`}>
        <Button
          variant="ghost"
          size="sm"
          className="w-fit min-h-11 gap-1.5 sm:min-h-8"
          onClick={() => setStep('selecao')}
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Voltar à seleção
        </Button>

        <PageHeader titulo="Revisar lote" subtitulo="Confira antes de gerar o arquivo. Só as aptas entram." />

        {previa.carregando ? (
          <ListSkeleton label="Calculando prévia do lote..." />
        ) : previa.erro ? (
          <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-10 text-center">
            <AlertCircle className="size-8 text-destructive" aria-hidden="true" />
            <p className="text-sm font-medium text-destructive">{previa.erro}</p>
            <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={revisarLote}>
              Tentar novamente
            </Button>
          </div>
        ) : previa.dados ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg border bg-card p-3">
                <div className="text-xs text-muted-foreground">Selecionadas</div>
                <div className="text-xl font-semibold">{previa.dados.selecionadas}</div>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <div className="text-xs text-muted-foreground">Aptas para exportação</div>
                <div className="text-xl font-semibold text-success">{previa.dados.quantidadeApta}</div>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <div className="text-xs text-muted-foreground">Com pendências</div>
                <div className="text-xl font-semibold text-warning-strong">{previa.dados.pendentes.length}</div>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <div className="text-xs text-muted-foreground">Valor total do lote</div>
                <div className="text-xl font-semibold">{formatBRL(previa.dados.totalApto)}</div>
              </div>
            </div>

            {previa.dados.pendentes.length > 0 && (
              <div role="alert" className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning-strong">
                <p>
                  <strong>{previa.dados.pendentes.length} registro(s) com pendências ficam fora deste lote.</strong>{' '}
                  Elas continuam liberadas e podem entrar num próximo lote depois de corrigidas.
                </p>
                <ul className="flex flex-col gap-1 pl-4 text-xs">
                  {previa.dados.pendentes.map((p) => {
                    const item = h.itens.find((i) => i.id === p.id);
                    return (
                      <li key={p.id} className="list-disc">
                        <span className="font-mono">{item?.integrationId ?? `Solicitação #${p.id}`}</span>
                        {item?.motorista.nome ? ` — ${item.motorista.nome}` : ''}
                        : {p.pendencias.map(rotuloPendencia).join(', ')}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {previa.dados.aptas.length === 0 ? (
              <EmptyState icone={Inbox} titulo="Nenhuma solicitação apta" dica="Todas as selecionadas têm pendência — ajuste a seleção." />
            ) : (
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Nº</TableHead>
                      <TableHead>Motorista</TableHead>
                      <TableHead>Banco/agência/conta</TableHead>
                      <TableHead className="text-right">Valor</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previa.dados.aptas.map((linha) => (
                      <TableRow key={linha.id}>
                        <TableCell className="font-mono text-sm">{linha.integrationId}</TableCell>
                        <TableCell>{linha.motorista ?? '—'}</TableCell>
                        <TableCell className="font-mono text-sm">{linha.bancoAgenciaContaMascarados ?? '—'}</TableCell>
                        <TableCell className="text-right font-mono">{formatBRL(linha.valor)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            <div className="sticky bottom-4 flex items-center justify-end gap-3 rounded-lg border bg-card p-3 shadow-lg">
              <Button
                size="sm"
                className="min-h-11 gap-1.5 sm:min-h-8"
                disabled={previa.dados.quantidadeApta === 0}
                onClick={() => setDialogGerar(true)}
              >
                Gerar arquivo Transfeera
                <ArrowRight className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </>
        ) : null}

        <AlertDialog open={dialogGerar} onOpenChange={(open) => !gerando && setDialogGerar(open)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Gerar lote com {previa.dados?.quantidadeApta ?? 0} pagamento(s)?</AlertDialogTitle>
              <AlertDialogDescription>
                Total {formatBRL(previa.dados?.totalApto ?? '0')}. As solicitações ficam reservadas neste lote e não
                podem entrar em outro. O arquivo é validado antes do download (FR-027, FR-028).
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={gerando}>Voltar</AlertDialogCancel>
              <AlertDialogAction onClick={confirmarGerarLote} disabled={gerando}>
                {gerando && <Loader2 className="mr-2 size-4 motion-safe:animate-spin" aria-hidden="true" />}
                Gerar lote e arquivo
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }

  return (
    <div className={`mx-auto flex w-full ${LARGURA_LISTA} flex-col gap-4 p-4 sm:p-6 lg:p-8`}>
      <PageHeader titulo="Pagamentos" subtitulo="Adiantamentos liberados, prontos para entrar num lote Transfeera." />
      <AdiantamentosAbas />

      <FilterBar
        gridClassName="grid-cols-1 xs:grid-cols-2 lg:grid-cols-3"
        onClear={h.resetFiltros}
        filtrosAtivos={h.filtrosAtivos}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="pag-filtro-de">Solicitadas de</Label>
          <Input id="pag-filtro-de" type="date" className="h-11 sm:h-9" value={h.filtros.de} onChange={(e) => h.setFiltros({ de: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="pag-filtro-ate">até</Label>
          <Input id="pag-filtro-ate" type="date" className="h-11 sm:h-9" value={h.filtros.ate} onChange={(e) => h.setFiltros({ ate: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="pag-filtro-busca">Motorista</Label>
          <Input
            id="pag-filtro-busca"
            placeholder="Nome ou documento"
            className="h-11 sm:h-9"
            value={h.filtros.busca}
            onChange={(e) => h.setFiltros({ busca: e.target.value })}
          />
        </div>
      </FilterBar>

      {h.carregando ? (
        <ListSkeleton label="Carregando solicitações liberadas..." />
      ) : h.erro ? (
        <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-10 text-center">
          <AlertCircle className="size-8 text-destructive" aria-hidden="true" />
          <p className="text-sm font-medium text-destructive">{h.erro}</p>
          <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={h.refetch}>
            Tentar novamente
          </Button>
        </div>
      ) : h.itens.length === 0 ? (
        <EmptyState icone={Inbox} titulo="Nenhuma solicitação liberada" dica="Ajuste os filtros ou aguarde a próxima produção." />
      ) : (
        <>
          {podeCriarLote && h.total > h.itens.length && (
            <div role="status" className="flex flex-wrap items-center gap-2 rounded-md bg-muted/60 px-3 py-2 text-sm">
              {todosDaPaginaSelecionados && idsSelecionados.length === h.itens.length ? (
                <>
                  <span>Todas as {h.itens.length} desta página estão selecionadas.</span>
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto min-h-11 p-0 sm:min-h-0"
                    disabled={s.carregandoTodos}
                    onClick={async () => {
                      const total = await s.selecionarTodosDoFiltro(h.filtrosApi);
                      if (total > LIMITE_LOTE) {
                        toast.warning(`O filtro tem ${total} solicitações — só as primeiras ${LIMITE_LOTE} (limite do parceiro de pagamento) foram selecionadas.`);
                      }
                    }}
                  >
                    {s.carregandoTodos && <Loader2 className="mr-1 inline size-3.5 motion-safe:animate-spin" aria-hidden="true" />}
                    Selecionar as {h.total} do filtro
                  </Button>
                </>
              ) : (
                <span>{idsSelecionados.length} selecionada(s) de {h.total} no filtro.</span>
              )}
            </div>
          )}

          {/* Mobile card layout — sem checkbox de seleção (mesmo precedente de
              `contas/page.tsx`: montagem de lote é fluxo desktop-first; a
              tabela abaixo é a única superfície de seleção). */}
          <div className="flex flex-col gap-2 md:hidden">
            {h.itens.map((item) => (
              <div key={item.id} className="flex items-start gap-2 rounded-lg border p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{item.motorista.nome ?? '—'}</span>
                    <span className="font-mono text-sm">{formatBRL(item.valorLiquido)}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="font-mono">{item.integrationId}</span>
                    <span>Solicitada: {formatDateBR(item.dataSolicitacao)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden rounded-lg border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  {podeCriarLote && (
                    <TableHead className="w-10">
                      <span className="flex h-11 w-11 items-center justify-center -m-2.5 md:h-8 md:w-8 md:m-0">
                        <Checkbox
                          className={CHECKBOX_ALVO_44}
                          checked={todosDaPaginaSelecionados}
                          onCheckedChange={() => s.toggleTodosDaPagina(h.itens.map((i) => i.id))}
                          aria-label="Selecionar todas desta página"
                        />
                      </span>
                    </TableHead>
                  )}
                  <TableHead>Nº</TableHead>
                  <TableHead>Motorista</TableHead>
                  <TableHead>Solicitada em</TableHead>
                  <TableHead>Produção</TableHead>
                  <TableHead className="text-right">Líquido</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {h.itens.map((item) => (
                  <TableRow key={item.id}>
                    {podeCriarLote && (
                      <TableCell>
                        <span className="flex h-11 w-11 items-center justify-center -m-2.5 md:h-8 md:w-8 md:m-0">
                          <Checkbox
                            className={CHECKBOX_ALVO_44}
                            checked={s.selecionados.has(item.id)}
                            onCheckedChange={() => s.toggle(item.id)}
                            aria-label={`Selecionar ${item.integrationId}`}
                          />
                        </span>
                      </TableCell>
                    )}
                    <TableCell className="font-mono text-sm">{item.integrationId}</TableCell>
                    <TableCell className="max-w-[200px] truncate">{item.motorista.nome ?? '—'}</TableCell>
                    <TableCell>{formatDateBR(item.dataSolicitacao)}</TableCell>
                    <TableCell>{formatDateBR(item.dataProducao)}</TableCell>
                    <TableCell className="text-right font-mono">{formatBRL(item.valorLiquido)}</TableCell>
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

      {podeCriarLote && idsSelecionados.length > 0 && (
        <div className="sticky bottom-4 flex flex-col gap-2 rounded-lg border bg-card p-3 shadow-lg sm:flex-row sm:items-center sm:justify-between">
          <span className="text-sm">
            <b>{idsSelecionados.length} selecionada(s)</b>
            {excedeLimite && (
              <span className="ml-2 text-warning-strong">
                excede o limite de {LIMITE_LOTE} do parceiro de pagamento — reduza a seleção.
              </span>
            )}
          </span>
          <Button size="sm" className="min-h-11 gap-1.5 sm:min-h-8" disabled={excedeLimite || previa.carregando} onClick={revisarLote}>
            {previa.carregando && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />}
            Revisar lote
            <ArrowRight className="size-4" aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  );
}
