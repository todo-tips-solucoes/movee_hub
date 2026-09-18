'use client';

// adiantamento-motorista — app/hub/dashboard/adiantamentos/lotes/[id]/page.tsx
// (tasks.md 7.7.2/7.7.3, H12+H15): detalhe de UM lote — download do arquivo
// Transfeera, cancelamento e confirmação manual de pagamento (D-16, FASE 9
// bloqueada por Q-B1). Uma única tela para H12/H15 (o protótipo separa por
// status do lote — "Download" vs "Confirmação" — mas é o MESMO registro,
// mudando de aparência conforme `status`; plan.md Project Structure F7 lista
// só este `page.tsx` para os dois).
//
// Divergência do protótipo H12: sem "Próximos passos"/validação estrutural
// linha a linha na tela — a validação já rodou no servidor (FR-028, 409 se
// falhar cancela o lote automaticamente, nunca chega a existir para
// download); a tela só reflete o resultado (`arquivoNome`, `arquivoSha256`).
//
// Ref: docs/specs/adiantamento-motorista/contracts/hub-api.md §Pagamentos e
// lotes; spec.md US5 cenários 4/7/9, FR-030/FR-033/FR-035; data-model.md
// §AdiantamentoLote State Transitions; prototipo H12, H15.

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertCircle, ArrowLeft, Ban, CheckCircle2, Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ListSkeleton } from '@/components/hub/table-skeleton';
import { LoteStatusBadge, LoteItemSituacaoBadge } from '@/components/hub/status-badge';
import { CancelarLoteDialog, useCancelarLoteDialog } from '@/components/hub/adiantamento-cancelar-lote-dialog';
import { ConfirmarLoteDialog, useConfirmarLoteDialog } from '@/components/hub/adiantamento-confirmar-lote-dialog';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { LARGURA_DETALHE } from '@/lib/hub/larguras';
import {
  AdiantamentosApiError,
  baixarArquivoLote,
  obterLote,
  type LoteDetalhe,
} from '@/lib/hub/adiantamentos-api';
import { formatBRL, formatDateBR } from '@/lib/utils';

const PODE_BAIXAR = ['GERADO', 'EXPORTADO', 'CONCLUIDO', 'CONCLUIDO_COM_FALHAS'];
const PODE_CANCELAR = ['GERANDO', 'GERADO', 'EXPORTADO'];

function useLoteDetalhe(id: number) {
  const [lote, setLote] = useState<LoteDetalhe | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const buscar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const l = await obterLote(id);
      setLote(l);
    } catch (e) {
      setErro(e instanceof AdiantamentosApiError ? e.message : 'Não foi possível carregar o lote.');
    } finally {
      setCarregando(false);
    }
  }, [id]);

  useEffect(() => {
    buscar();
  }, [buscar]);

  return { lote, carregando, erro, refetch: buscar };
}

export default function AdiantamentoLoteDetalhePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = Number(params?.id);
  const { lote, carregando, erro, refetch } = useLoteDetalhe(id);
  const { permissoes } = useHubAuth();
  const [baixando, setBaixando] = useState(false);

  const cancelarDialog = useCancelarLoteDialog({
    loteId: id,
    status: lote?.status ?? '',
    onSucesso: () => {
      toast.success('Lote cancelado. As solicitações voltaram a liberadas.');
      refetch();
    },
  });
  const confirmarDialog = useConfirmarLoteDialog({
    loteId: id,
    itens: lote?.itens ?? [],
    onSucesso: () => {
      toast.success('Resultado do lote confirmado.');
      refetch();
    },
  });

  const baixar = useCallback(async () => {
    if (!lote) return;
    setBaixando(true);
    try {
      await baixarArquivoLote(lote.id, lote.numero);
      refetch();
    } catch (e) {
      toast.error(e instanceof AdiantamentosApiError ? e.message : 'Não foi possível baixar o arquivo do lote.');
    } finally {
      setBaixando(false);
    }
  }, [lote, refetch]);

  return (
    <div className={`mx-auto flex w-full ${LARGURA_DETALHE} flex-col gap-4 p-4 sm:p-6 lg:p-8`}>
      <Button
        variant="ghost"
        size="sm"
        className="w-fit min-h-11 gap-1.5 sm:min-h-8"
        onClick={() => (window.history.length > 1 ? router.back() : router.push('/hub/dashboard/adiantamentos/lotes'))}
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Voltar ao histórico de lotes
      </Button>

      {carregando && !lote ? (
        <ListSkeleton label="Carregando lote..." linhas={4} />
      ) : erro && !lote ? (
        <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-10 text-center">
          <AlertCircle className="size-8 text-destructive" aria-hidden="true" />
          <p className="text-sm font-medium text-destructive">{erro}</p>
          <Button variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={refetch}>
            Tentar novamente
          </Button>
        </div>
      ) : lote ? (
        <>
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <CardTitle as="h1" className="text-lg font-mono">
                  Lote {lote.numero}
                </CardTitle>
                <LoteStatusBadge status={lote.status} />
              </div>
              <div className="flex flex-wrap gap-2">
                {permissoes.includes('adiantamentos.reprocessar') && PODE_CANCELAR.includes(lote.status) && (
                  <Button variant="destructive" size="sm" className="min-h-11 gap-1.5 sm:min-h-8" onClick={cancelarDialog.abrir}>
                    <Ban className="size-4" aria-hidden="true" />
                    Cancelar lote
                  </Button>
                )}
                {permissoes.includes('adiantamentos.pagamento_confirmar') && lote.status === 'EXPORTADO' && (
                  <Button variant="outline" size="sm" className="min-h-11 gap-1.5 sm:min-h-8" onClick={confirmarDialog.abrir}>
                    <CheckCircle2 className="size-4" aria-hidden="true" />
                    Confirmar resultado
                  </Button>
                )}
                {permissoes.includes('adiantamentos.exportar') && PODE_BAIXAR.includes(lote.status) && (
                  <Button size="sm" className="min-h-11 gap-1.5 sm:min-h-8" disabled={baixando} onClick={baixar}>
                    {baixando ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <Download className="size-4" aria-hidden="true" />}
                    Baixar arquivo Transfeera
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="px-4">
              {lote.canceladoMotivo && (
                <p role="alert" className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
                  Cancelado: {lote.canceladoMotivo}
                </p>
              )}
              <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <dt className="text-muted-foreground">Criado em</dt>
                  <dd className="text-right font-medium">{formatDateBR(lote.criadoEm)}</dd>
                </div>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <dt className="text-muted-foreground">Pagamentos</dt>
                  <dd className="text-right font-mono font-medium">{lote.quantidade}</dd>
                </div>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <dt className="text-muted-foreground">Valor total</dt>
                  <dd className="text-right font-mono font-medium">{formatBRL(lote.valorTotal)}</dd>
                </div>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <dt className="text-muted-foreground">Downloads</dt>
                  <dd className="text-right font-mono font-medium">{lote.downloads}</dd>
                </div>
                {lote.arquivoNome && (
                  <div className="flex items-center justify-between gap-3 text-sm sm:col-span-2">
                    <dt className="text-muted-foreground">Arquivo</dt>
                    <dd className="text-right font-mono text-xs">{lote.arquivoNome}</dd>
                  </div>
                )}
                {lote.arquivoSha256 && (
                  <div className="flex items-center justify-between gap-3 text-sm sm:col-span-2">
                    <dt className="text-muted-foreground">SHA-256</dt>
                    <dd className="truncate text-right font-mono text-xs text-muted-foreground">{lote.arquivoSha256}</dd>
                  </div>
                )}
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle as="h2" className="text-base">
                Itens do lote
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4">
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Nº</TableHead>
                      <TableHead>Nome</TableHead>
                      <TableHead>Banco/agência/conta</TableHead>
                      <TableHead className="text-right">Valor</TableHead>
                      <TableHead>Situação</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lote.itens.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className="font-mono text-sm">{item.integrationId}</TableCell>
                        <TableCell className="max-w-[180px] truncate">{item.nome}</TableCell>
                        <TableCell className="font-mono text-sm">{item.banco} · {item.agencia} · {item.contaMascarada}</TableCell>
                        <TableCell className="text-right font-mono">{formatBRL(item.valor)}</TableCell>
                        <TableCell>
                          <LoteItemSituacaoBadge situacao={item.situacao} />
                          {item.situacaoMotivo && <p className="mt-1 text-xs text-muted-foreground">{item.situacaoMotivo}</p>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}

      <CancelarLoteDialog d={cancelarDialog} />
      <ConfirmarLoteDialog d={confirmarDialog} />
    </div>
  );
}
