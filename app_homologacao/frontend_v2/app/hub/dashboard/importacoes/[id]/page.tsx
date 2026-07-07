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
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
  STATUS_LABELS,
  STATUS_REPROCESSAVEL,
  TIPO_LABELS,
  type ImportacaoErroItem,
} from '@/lib/hub/importacoes-dto';
import { formatDateBR } from '@/lib/utils';

const ERROS_PAGE_SIZE = 20;

function badgeVariantDoStatus(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'completed') return 'default';
  if (status === 'completed_with_errors') return 'outline';
  if (status === 'failed') return 'destructive';
  if (status === 'cancelled') return 'secondary';
  return 'outline';
}

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

  const { detalhe, carregando, erro, refetch } = useImportacaoPolling(id);
  const errosState = useImportacaoErros(id);

  const [acaoEmAndamento, setAcaoEmAndamento] = useState<'reprocessar' | 'cancelar' | 'original' | null>(null);
  const [erroAcao, setErroAcao] = useState<string | null>(null);

  const acionarReprocessar = useCallback(async () => {
    setErroAcao(null);
    setAcaoEmAndamento('reprocessar');
    try {
      await reprocessarImportacao(id);
      await refetch();
    } catch (e) {
      setErroAcao(e instanceof ImportacaoApiError ? e.message : 'Falha ao reprocessar a importação.');
    } finally {
      setAcaoEmAndamento(null);
    }
  }, [id, refetch]);

  const acionarCancelar = useCallback(async () => {
    setErroAcao(null);
    setAcaoEmAndamento('cancelar');
    try {
      await cancelarImportacao(id);
      await refetch();
    } catch (e) {
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
    } catch (e) {
      setErroAcao(e instanceof ImportacaoApiError ? e.message : 'Falha ao baixar o arquivo original.');
    } finally {
      setAcaoEmAndamento(null);
    }
  }, [id]);

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
        <div role="status" className="flex flex-col items-center gap-2 rounded-lg border p-10 text-muted-foreground">
          <RotateCw className="size-6 animate-spin" aria-hidden="true" />
          <p className="text-sm">Carregando importação...</p>
        </div>
      ) : erro && !detalhe ? (
        <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-10 text-center">
          <AlertCircle className="size-8 text-destructive" aria-hidden="true" />
          <p className="text-sm font-medium text-destructive">{erro}</p>
        </div>
      ) : detalhe ? (
        <>
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle as="h1" className="text-lg">
                Importação #{detalhe.id} — {TIPO_LABELS[detalhe.tipo]}
              </CardTitle>
              <Badge variant={badgeVariantDoStatus(detalhe.status)}>{STATUS_LABELS[detalhe.status]}</Badge>
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
                  <Button size="sm" variant="destructive" className="min-h-11 sm:min-h-8" disabled={acaoEmAndamento !== null} onClick={acionarCancelar}>
                    {acaoEmAndamento === 'cancelar' ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <XCircle className="size-4" aria-hidden="true" />
                    )}
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
        </>
      ) : null}
    </div>
  );
}
