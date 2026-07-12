'use client';

// hub-importacoes (S4) FASE 6 task 6.2 — rota
// `/hub/dashboard/importacoes/[id]`: detalhe + progresso (polling) + erros
// paginados + ações reprocessar/cancelar/baixar original.
//
// Ref: docs/specs/hub-importacoes/contracts/importacoes-api.md
// §GET /importacoes/:id, §GET /importacoes/:id/erros,
// §POST /importacoes/:id/reprocessar, §POST /importacoes/:id/cancelar,
// §GET /importacoes/:id/original.

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  AlertCircle,
  ArrowLeft,
  Download,
  FileWarning,
  Loader2,
  RotateCw,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
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
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ImportacaoStatusBadge } from '@/components/hub/status-badge';
import { ListSkeleton } from '@/components/hub/table-skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { useImportacaoPolling } from '@/hooks/use-importacao-polling';
import {
  baixarErrosCsv,
  baixarOriginal,
  cancelarImportacao,
  ImportacaoApiError,
  listarErros,
  reprocessarImportacao,
} from '@/lib/hub/importacoes-api';
import {
  STATUS_CANCELAVEL,
  STATUS_EM_ANDAMENTO,
  STATUS_REPROCESSAVEL,
  TIPO_LABELS,
  type ImportacaoErroItem,
} from '@/lib/hub/importacoes-dto';
import { formatDateBR } from '@/lib/utils';

const ERROS_PAGE_SIZE = 20;

/** Lógica de erros paginados, isolada do polling do detalhe (fetch
 * independente — não precisa repetir a cada tick de polling). */
export function useImportacaoErros(id: number) {
  const [items, setItems] = useState<ImportacaoErroItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const buscar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const resposta = await listarErros(id, { page, pageSize: ERROS_PAGE_SIZE });
      setItems(resposta.items);
      setTotal(resposta.total);
    } catch (e) {
      setErro(e instanceof ImportacaoApiError ? e.message : 'Não foi possível carregar os erros.');
    } finally {
      setCarregando(false);
    }
  }, [id, page]);

  useEffect(() => {
    buscar();
  }, [buscar]);

  const totalPaginas = Math.max(1, Math.ceil(total / ERROS_PAGE_SIZE));

  return { items, total, page, setPage, totalPaginas, carregando, erro, refetch: buscar };
}

export default function ImportacaoDetalhePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = Number(params?.id);
  const { permissoes } = useHubAuth();
  const podeCriar = permissoes.includes('importacoes.criar');
  const podeExportar = permissoes.includes('importacoes.exportar');

  const {
    detalhe, carregando, erro, atualizacaoPausada, refetch, iniciarPolling,
  } = useImportacaoPolling(id);
  const errosState = useImportacaoErros(id);

  const [acaoEmAndamento, setAcaoEmAndamento] = useState<'reprocessar' | 'cancelar' | 'original' | null>(null);
  const [erroAcao, setErroAcao] = useState<string | null>(null);
  const [confirmandoCancelar, setConfirmandoCancelar] = useState(false);

  const acionarReprocessar = useCallback(async () => {
    setErroAcao(null);
    setAcaoEmAndamento('reprocessar');
    try {
      await reprocessarImportacao(id);
      const novoDetalhe = await refetch();
      // F8.1 (pós-review PR #57) — o polling anterior já tinha parado (a
      // importação estava num status TERMINAL, failed/cancelled, senão o
      // botão "Reprocessar" nem apareceria — STATUS_REPROCESSAVEL). O
      // reprocessamento volta o status a `pending`; sem reiniciar aqui, a
      // tela ficaria "congelada" mostrando o status antigo até um F5 manual.
      if (novoDetalhe && STATUS_EM_ANDAMENTO.has(novoDetalhe.status)) {
        iniciarPolling();
      }
      toast.success('Reprocessamento iniciado.');
    } catch (e) {
      setErroAcao(e instanceof ImportacaoApiError ? e.message : 'Falha ao reprocessar a importação.');
    } finally {
      setAcaoEmAndamento(null);
    }
  }, [id, refetch, iniciarPolling]);

  const acionarCancelar = useCallback(async () => {
    setErroAcao(null);
    setAcaoEmAndamento('cancelar');
    try {
      await cancelarImportacao(id);
      await refetch();
      setConfirmandoCancelar(false);
      toast.success('Importação cancelada.');
    } catch (e) {
      setConfirmandoCancelar(false);
      setErroAcao(e instanceof ImportacaoApiError ? e.message : 'Falha ao cancelar a importação.');
    } finally {
      setAcaoEmAndamento(null);
    }
  }, [id, refetch]);

  const acionarBaixarOriginal = useCallback(async () => {
    setErroAcao(null);
    setAcaoEmAndamento('original');
    try {
      await baixarOriginal(id);
      toast.success('Download do arquivo original iniciado.');
    } catch (e) {
      setErroAcao(e instanceof ImportacaoApiError ? e.message : 'Falha ao baixar o arquivo original.');
    } finally {
      setAcaoEmAndamento(null);
    }
  }, [id]);

  // F8.2 (pós-review PR #57) — a tabela de erros é buscada 1x no mount de
  // `useImportacaoErros` (antes de a importação terminar); se o polling do
  // detalhe chegar a um status TERMINAL com `invalidas > 0`, a tabela de
  // erros precisa ser refeita — senão a UI mostra "Erros (0)" para sempre
  // mesmo quando o processamento encontrou linhas inválidas.
  useEffect(() => {
    if (detalhe && !STATUS_EM_ANDAMENTO.has(detalhe.status) && (detalhe.contadores.invalidas ?? 0) > 0) {
      errosState.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só refaz quando status/invalidas mudam, não a cada render de errosState
  }, [detalhe?.status, detalhe?.contadores.invalidas]);

  if (!Number.isFinite(id)) {
    return (
      <div className="mx-auto max-w-3xl p-4 sm:p-6">
        <p role="alert" className="text-sm font-medium text-destructive">
          Identificador de importação inválido.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:p-6 lg:p-8">
      <Button variant="ghost" size="sm" className="w-fit min-h-11 gap-1.5 sm:min-h-8" onClick={() => router.push('/hub/dashboard/importacoes')}>
        <ArrowLeft className="size-4" aria-hidden="true" />
        Voltar ao histórico
      </Button>

      {carregando && !detalhe ? (
        <ListSkeleton label="Carregando importação..." linhas={4} />
      ) : erro && !detalhe ? (
        <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-10 text-center">
          <AlertCircle className="size-8 text-destructive" aria-hidden="true" />
          <p className="text-sm font-medium text-destructive">{erro}</p>
          <Button variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => refetch()}>
            <RotateCw className="size-4" aria-hidden="true" />
            Tentar novamente
          </Button>
        </div>
      ) : detalhe ? (
        <>
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle as="h1" className="text-lg">
                Importação #{detalhe.id} — {TIPO_LABELS[detalhe.tipo]}
              </CardTitle>
              <ImportacaoStatusBadge status={detalhe.status} />
            </CardHeader>
            <CardContent className="flex flex-col gap-3 px-4">
              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                <div>
                  <p className="text-xs text-muted-foreground">Total de linhas</p>
                  <p className="font-mono">{detalhe.contadores.total ?? '-'}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Válidas</p>
                  <p className="font-mono">{detalhe.contadores.validas ?? '-'}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Inválidas</p>
                  <p className="font-mono">{detalhe.contadores.invalidas ?? '-'}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Data referência</p>
                  <p>{formatDateBR(detalhe.dataReferencia) || '-'}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Duração</p>
                  <p>{detalhe.duracaoSegundos !== null ? `${detalhe.duracaoSegundos}s` : '-'}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Concluído em</p>
                  <p>{formatDateBR(detalhe.concluidoEm) || '-'}</p>
                </div>
              </div>

              {detalhe.erroResumo && (
                <p role="alert" className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
                  <FileWarning className="size-4 shrink-0" aria-hidden="true" />
                  {detalhe.erroResumo}
                </p>
              )}

              {erroAcao && (
                <p role="alert" className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
                  <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
                  {erroAcao}
                </p>
              )}

              {/* F8.3 (pós-review PR #57) — indicador de atualização automática
                  pausada: aparece MESMO com `detalhe` presente (dados antigos
                  continuam na tela, mas parou de se atualizar sozinho) — antes
                  só existia um erro de tela cheia, e SÓ quando `!detalhe`. */}
              {atualizacaoPausada && STATUS_EM_ANDAMENTO.has(detalhe.status) && (
                <p role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm font-medium text-warning-strong">
                  <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
                  Atualização automática pausada — não foi possível consultar o status mais recente.
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-auto min-h-0 p-0 underline"
                    onClick={async () => {
                      const d = await refetch();
                      if (d && STATUS_EM_ANDAMENTO.has(d.status)) iniciarPolling();
                    }}
                  >
                    Tentar novamente
                  </Button>
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                {podeCriar && STATUS_REPROCESSAVEL.has(detalhe.status) && (
                  <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={acaoEmAndamento !== null} onClick={acionarReprocessar}>
                    {acaoEmAndamento === 'reprocessar' ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <RotateCw className="size-4" aria-hidden="true" />
                    )}
                    Reprocessar
                  </Button>
                )}
                {podeCriar && STATUS_CANCELAVEL.has(detalhe.status) && (
                  <Button size="sm" variant="destructive" className="min-h-11 sm:min-h-8" disabled={acaoEmAndamento !== null} onClick={() => setConfirmandoCancelar(true)}>
                    <XCircle className="size-4" aria-hidden="true" />
                    Cancelar
                  </Button>
                )}
                {podeExportar && (
                  <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={acaoEmAndamento !== null} onClick={acionarBaixarOriginal}>
                    {acaoEmAndamento === 'original' ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Download className="size-4" aria-hidden="true" />
                    )}
                    Baixar original
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle as="h2" className="text-base">
                Erros ({errosState.total})
              </CardTitle>
              {errosState.total > 0 && (
                <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => baixarErrosCsv(id)}>
                  <Download className="size-3.5" aria-hidden="true" />
                  Baixar CSV
                </Button>
              )}
            </CardHeader>
            <CardContent className="px-4">
              {errosState.carregando ? (
                <p role="status" className="py-6 text-center text-sm text-muted-foreground">
                  Carregando erros...
                </p>
              ) : errosState.erro ? (
                <p role="alert" className="py-6 text-center text-sm font-medium text-destructive">
                  {errosState.erro}
                </p>
              ) : errosState.items.length === 0 ? (
                <p role="status" className="py-6 text-center text-sm text-muted-foreground">
                  Nenhum erro registrado nesta importação.
                </p>
              ) : (
                <>
                  <div className="overflow-x-auto rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Linha</TableHead>
                          <TableHead>Campo</TableHead>
                          <TableHead>Motivo</TableHead>
                          <TableHead>Valor</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {errosState.items.map((e, idx) => (
                          <TableRow key={`${e.numeroLinha}-${idx}`}>
                            <TableCell className="font-mono">{e.numeroLinha}</TableCell>
                            <TableCell>{e.campo ?? '-'}</TableCell>
                            <TableCell>{e.motivo ?? '-'}</TableCell>
                            {/* valorMascarado (LGPD) — nunca dado bruto */}
                            <TableCell className="font-mono">{e.valorMascarado ?? '-'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2 text-sm text-muted-foreground">
                    <span>
                      Página {errosState.page} de {errosState.totalPaginas}
                    </span>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="min-h-11 sm:min-h-8"
                        disabled={errosState.page <= 1}
                        onClick={() => errosState.setPage(errosState.page - 1)}
                      >
                        Anterior
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="min-h-11 sm:min-h-8"
                        disabled={errosState.page >= errosState.totalPaginas}
                        onClick={() => errosState.setPage(errosState.page + 1)}
                      >
                        Próxima
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <AlertDialog open={confirmandoCancelar} onOpenChange={setConfirmandoCancelar}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Cancelar importação</AlertDialogTitle>
                <AlertDialogDescription>
                  Tem certeza que deseja cancelar a importação #{detalhe.id}? O processamento é
                  interrompido e as linhas ainda não processadas são descartadas. Esta ação não pode
                  ser desfeita — será preciso importar o arquivo novamente.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={acaoEmAndamento === 'cancelar'}>Voltar</AlertDialogCancel>
                <AlertDialogAction
                  onClick={acionarCancelar}
                  disabled={acaoEmAndamento === 'cancelar'}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {acaoEmAndamento === 'cancelar' && (
                    <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
                  )}
                  Cancelar importação
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : null}
    </div>
  );
}
