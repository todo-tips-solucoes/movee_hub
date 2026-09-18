'use client';

// adiantamento-motorista — app/hub/dashboard/adiantamentos/contas/page.tsx
// (tasks.md 7.5.1/7.5.3, H06): lista mascarada de contas bancárias com os
// filtros REAIS do backend (routes/hub-adiantamentos.js:453-479, dec-105) —
// status/origem/semAlertas/busca/banco — e aprovação em massa (FR-020).
//
// Divergência do protótipo H06: o mock filtra "Banco" por um `<select>` com
// os nomes; a rota só aceita `banco` = código COMPE de 3 dígitos
// (`hub_conta_bancaria_listar`, p_banco), e não existe endpoint de lista de
// bancos no hub — um `<select>` exigiria fabricar/duplicar a lista COMPE
// (`lib/fixtures/bancos-compe.json`, hoje só no backend). Campo de texto
// para o código, mesmo padrão do filtro "Motorista" (Constitution VI).
//
// Aprovação em massa (FR-020): o critério de elegibilidade (origem
// CARGA_INICIAL + sem alertas + PENDENTE) já vive no banco
// (`hub_conta_bancaria_aprovar_lote`, 0067) — esta tela NUNCA reimplementa o
// critério, apenas envia os ids selecionados e reflete o resultado
// (aprovadas/ignoradas com motivo) que a API devolve.
//
// Ref: docs/specs/adiantamento-motorista/contracts/hub-api.md §Contas
// bancárias; docs/specs/adiantamento-motorista/spec.md FR-018/FR-019/FR-020;
// prototipo H06.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { AlertCircle, Inbox, Loader2 } from 'lucide-react';
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
import { SelectFiltro } from '@/components/hub/select-filtro';
import { ContaStatusBadge, STATUS_CONTA_OPCOES } from '@/components/hub/status-badge';
import { AdiantamentosAbas } from '@/components/hub/adiantamentos-abas';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { useDebounce } from '@/hooks/use-debounce';
import { LARGURA_LISTA } from '@/lib/hub/larguras';
import {
  AdiantamentosApiError,
  aprovarContasEmLote,
  listarContas,
  type ContaMascaradaAdiantamento,
} from '@/lib/hub/adiantamentos-api';
import { formatDateBR } from '@/lib/utils';

const PAGE_SIZE = 20;

/** Rótulo pt-BR dos alertas documentados (data-model.md). Código
 * desconhecido cai no próprio código (Constitution VI — nunca fabricar
 * significado), mesmo fail-safe dos StatusBadge deste módulo. */
const ALERTA_LABEL: Record<string, string> = {
  TITULAR_DIFERENTE: 'Titular diferente',
  CPF_NAO_CONFERIDO: 'CPF não conferido',
};

function rotuloAlerta(codigo: string): string {
  return ALERTA_LABEL[codigo] ?? codigo;
}

interface Filtros {
  status: string;
  origem: string;
  semAlertas: '' | 'true' | 'false';
  busca: string;
  banco: string;
}

const FILTROS_INICIAIS: Filtros = { status: '', origem: '', semAlertas: '', busca: '', banco: '' };

/** Lógica isolada do JSX (mesmo padrão de `useSolicitacoesLista`). */
export function useContasLista() {
  const [filtros, setFiltrosState] = useState<Filtros>(FILTROS_INICIAIS);
  const [page, setPage] = useState(1);
  const [itens, setItens] = useState<ContaMascaradaAdiantamento[]>([]);
  const [total, setTotal] = useState(0);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [selecionados, setSelecionados] = useState<Set<number>>(new Set());

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
      const resposta = await listarContas({
        status: filtrosDebounced.status || undefined,
        origem: filtrosDebounced.origem || undefined,
        semAlertas: filtrosDebounced.semAlertas === '' ? undefined : filtrosDebounced.semAlertas === 'true',
        busca: filtrosDebounced.busca || undefined,
        banco: filtrosDebounced.banco || undefined,
        page,
        pageSize: PAGE_SIZE,
      });
      setItens(resposta.itens);
      setTotal(resposta.total);
      // r6 (data-table.tsx): seleção sobrevive à repaginação/refetch só para
      // ids ainda presentes na página atual — evita "fantasma selecionado".
      setSelecionados((atual) => new Set([...atual].filter((id) => resposta.itens.some((i) => i.id === id))));
    } catch (e) {
      setErro(e instanceof AdiantamentosApiError ? e.message : 'Não foi possível carregar as contas bancárias.');
      setItens([]);
      setTotal(0);
    } finally {
      setCarregando(false);
    }
  }, [filtrosDebounced, page]);

  useEffect(() => {
    buscar();
  }, [buscar]);

  const toggleSelecionado = useCallback((id: number) => {
    setSelecionados((atual) => {
      const novo = new Set(atual);
      if (novo.has(id)) novo.delete(id);
      else novo.add(id);
      return novo;
    });
  }, []);

  const toggleSelecionarPagina = useCallback(() => {
    setSelecionados((atual) => {
      const todosSelecionados = itens.length > 0 && itens.every((i) => atual.has(i.id));
      if (todosSelecionados) return new Set([...atual].filter((id) => !itens.some((i) => i.id === id)));
      const novo = new Set(atual);
      itens.forEach((i) => novo.add(i.id));
      return novo;
    });
  }, [itens]);

  const limparSelecao = useCallback(() => setSelecionados(new Set()), []);

  const totalPaginas = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtrosAtivos = Object.values(filtros).filter((v) => v !== '').length;

  return {
    filtros, setFiltros, resetFiltros, filtrosAtivos,
    itens, total, page, setPage, totalPaginas, carregando, erro, refetch: buscar,
    selecionados, toggleSelecionado, toggleSelecionarPagina, limparSelecao,
  };
}

export default function AdiantamentosContasPage() {
  const h = useContasLista();
  const { permissoes } = useHubAuth();
  const podeRevisar = permissoes.includes('adiantamentos.contas_revisar');
  const [confirmandoLote, setConfirmandoLote] = useState(false);
  const [aprovandoLote, setAprovandoLote] = useState(false);

  const idsSelecionados = useMemo(() => [...h.selecionados], [h.selecionados]);
  const todosDaPaginaSelecionados = h.itens.length > 0 && h.itens.every((i) => h.selecionados.has(i.id));
  // FR-020: "quantidade afetada", não a quantidade selecionada — mesmo critério
  // que hub_conta_bancaria_aprovar_lote aplica no banco (origem CARGA_INICIAL +
  // sem alertas + PENDENTE). Só espelha o critério para exibição; a decisão real
  // continua vindo do backend (comentário do topo do arquivo).
  const qtdElegivel = useMemo(
    () =>
      h.itens.filter(
        (i) => h.selecionados.has(i.id) && i.status === 'PENDENTE' && i.origem === 'CARGA_INICIAL' && i.alertas.length === 0
      ).length,
    [h.itens, h.selecionados]
  );

  const confirmarAprovacaoLote = useCallback(async () => {
    setAprovandoLote(true);
    try {
      const resultado = await aprovarContasEmLote(idsSelecionados);
      if (resultado.ignoradas.length === 0) {
        toast.success(`${resultado.aprovadas} conta(s) aprovada(s).`);
      } else {
        toast.warning(
          `${resultado.aprovadas} aprovada(s), ${resultado.ignoradas.length} ignorada(s) (fora do critério de aprovação em massa).`
        );
      }
      setConfirmandoLote(false);
      h.limparSelecao();
      h.refetch();
    } catch (e) {
      toast.error(e instanceof AdiantamentosApiError ? e.message : 'Não foi possível aprovar as contas selecionadas.');
    } finally {
      setAprovandoLote(false);
    }
  }, [idsSelecionados, h]);

  return (
    <div className={`mx-auto flex w-full ${LARGURA_LISTA} flex-col gap-4 p-4 sm:p-6 lg:p-8`}>
      <PageHeader titulo="Contas bancárias" subtitulo="Solicitações de cadastro e alteração de dados bancários dos motoristas." />
      <AdiantamentosAbas />

      <FilterBar
        gridClassName="grid-cols-1 xs:grid-cols-2 lg:grid-cols-5"
        onClear={h.resetFiltros}
        filtrosAtivos={h.filtrosAtivos}
      >
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Situação</span>
          <SelectFiltro
            ariaLabel="Situação"
            value={h.filtros.status}
            onChange={(v) => h.setFiltros({ status: v })}
            opcoes={[
              { value: '', label: 'Todas' },
              ...STATUS_CONTA_OPCOES.map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() })),
            ]}
          />
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Origem</span>
          <SelectFiltro
            ariaLabel="Origem"
            value={h.filtros.origem}
            onChange={(v) => h.setFiltros({ origem: v })}
            opcoes={[
              { value: '', label: 'Todas' },
              { value: 'APP', label: 'App' },
              { value: 'CARGA_INICIAL', label: 'Carga inicial' },
            ]}
          />
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Alertas</span>
          <SelectFiltro
            ariaLabel="Alertas"
            value={h.filtros.semAlertas}
            onChange={(v) => h.setFiltros({ semAlertas: v as Filtros['semAlertas'] })}
            opcoes={[
              { value: '', label: 'Todos' },
              { value: 'true', label: 'Sem alertas' },
              { value: 'false', label: 'Com alertas' },
            ]}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="contas-filtro-busca">Motorista</Label>
          <Input
            id="contas-filtro-busca"
            placeholder="Nome ou documento"
            className="h-11 sm:h-9"
            value={h.filtros.busca}
            onChange={(e) => h.setFiltros({ busca: e.target.value })}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="contas-filtro-banco">Banco</Label>
          <Input
            id="contas-filtro-banco"
            placeholder="Código (3 dígitos)"
            inputMode="numeric"
            maxLength={3}
            className="h-11 sm:h-9"
            value={h.filtros.banco}
            onChange={(e) => h.setFiltros({ banco: e.target.value.replace(/\D/g, '') })}
          />
        </div>
      </FilterBar>

      {h.carregando ? (
        <ListSkeleton label="Carregando contas bancárias..." />
      ) : h.erro ? (
        <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-10 text-center">
          <AlertCircle className="size-8 text-destructive" aria-hidden="true" />
          <p className="text-sm font-medium text-destructive">{h.erro}</p>
          <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={h.refetch}>
            Tentar novamente
          </Button>
        </div>
      ) : h.itens.length === 0 ? (
        <EmptyState icone={Inbox} titulo="Nenhuma conta encontrada" dica="Ajuste os filtros ou aguarde novos envios do app." />
      ) : (
        <>
          {/* Mobile card layout */}
          <div className="flex flex-col gap-2 md:hidden">
            {h.itens.map((item) => (
              <Link
                key={item.id}
                href={`/hub/dashboard/adiantamentos/contas/${item.id}`}
                className="rounded-lg border p-3 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{item.titularNome}</span>
                  <ContaStatusBadge status={item.status} />
                </div>
                <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{item.documentoMascarado}</div>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>{item.banco}</span>
                  <span>Enviada: {formatDateBR(item.solicitadaEm)}</span>
                  {item.alertas.length > 0 && <span className="text-warning">{item.alertas.map(rotuloAlerta).join(', ')}</span>}
                </div>
              </Link>
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden rounded-lg border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  {podeRevisar && (
                    <TableHead className="w-10">
                      <span className="flex h-11 w-11 items-center justify-center -m-2.5 md:h-8 md:w-8 md:m-0">
                        <Checkbox
                          className={CHECKBOX_ALVO_44}
                          checked={todosDaPaginaSelecionados}
                          onCheckedChange={h.toggleSelecionarPagina}
                          aria-label="Selecionar todas as contas desta página"
                        />
                      </span>
                    </TableHead>
                  )}
                  <TableHead>Titular</TableHead>
                  <TableHead>Documento</TableHead>
                  <TableHead>Banco</TableHead>
                  <TableHead className="text-right">Agência</TableHead>
                  <TableHead>Conta</TableHead>
                  <TableHead>Origem</TableHead>
                  <TableHead>Alertas</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Enviada em</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {h.itens.map((item) => (
                  <TableRow key={item.id}>
                    {podeRevisar && (
                      <TableCell>
                        <span className="flex h-11 w-11 items-center justify-center -m-2.5 md:h-8 md:w-8 md:m-0">
                          <Checkbox
                            className={CHECKBOX_ALVO_44}
                            checked={h.selecionados.has(item.id)}
                            onCheckedChange={() => h.toggleSelecionado(item.id)}
                            aria-label={`Selecionar ${item.titularNome}`}
                          />
                        </span>
                      </TableCell>
                    )}
                    <TableCell className="max-w-[200px] truncate">{item.titularNome}</TableCell>
                    <TableCell className="font-mono text-sm">{item.documentoMascarado}</TableCell>
                    <TableCell>{item.banco}</TableCell>
                    <TableCell className="text-right font-mono">{item.agencia}</TableCell>
                    <TableCell className="font-mono">{item.contaMascarada}</TableCell>
                    <TableCell>{item.origem === 'CARGA_INICIAL' ? 'Carga inicial' : 'App'}</TableCell>
                    <TableCell>
                      {item.alertas.length > 0 ? (
                        <span className="text-xs font-medium text-warning">{item.alertas.map(rotuloAlerta).join(', ')}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <ContaStatusBadge status={item.status} />
                    </TableCell>
                    <TableCell>{formatDateBR(item.solicitadaEm)}</TableCell>
                    <TableCell>
                      <Link href={`/hub/dashboard/adiantamentos/contas/${item.id}`} className="text-primary hover:underline">
                        Revisar
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

      {/* FR-020: aprovação em massa — só desta página (sem "todas do filtro",
          divergência deliberada do H09/pagamentos que este módulo não usa
          aqui: nenhuma tarefa pede seleção cross-página para contas). */}
      {podeRevisar && idsSelecionados.length > 0 && (
        <div className="sticky bottom-4 flex items-center justify-between gap-3 rounded-lg border bg-card p-3 shadow-lg">
          <span className="text-sm">
            <b>{idsSelecionados.length} selecionada(s)</b>
          </span>
          <Button size="sm" className="min-h-11 sm:min-h-8" onClick={() => setConfirmandoLote(true)}>
            Aprovar selecionadas
          </Button>
        </div>
      )}

      <AlertDialog open={confirmandoLote} onOpenChange={(open) => !aprovandoLote && setConfirmandoLote(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Aprovar {qtdElegivel} conta(s)?</AlertDialogTitle>
            <AlertDialogDescription>
              {idsSelecionados.length} selecionada(s); só {qtdElegivel} atende(m) o critério (pendente, sem
              alertas e originada da carga inicial — FR-020). As demais ficam de fora e aparecem como
              ignoradas no resultado.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={aprovandoLote}>Voltar</AlertDialogCancel>
            <AlertDialogAction onClick={confirmarAprovacaoLote} disabled={aprovandoLote}>
              {aprovandoLote && <Loader2 className="mr-2 size-4 motion-safe:animate-spin" aria-hidden="true" />}
              Aprovar selecionadas
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
