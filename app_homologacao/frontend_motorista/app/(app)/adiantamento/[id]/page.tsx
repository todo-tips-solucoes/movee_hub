'use client';

/**
 * adiantamento-motorista — app/(app)/adiantamento/[id]/page.tsx (tasks.md 6.3.2, 6.3.5)
 *
 * Detalhe + timeline de UMA solicitação (protótipo M07 aguardando, M08 em
 * processamento, M09 pago, M11 rejeitado/inelegível — um único componente
 * orientado por `status`, não 4 telas quase-duplicadas). O botão de
 * cancelamento (M07) só aparece em `AGUARDANDO_CORTE` (edge #22 — o backend
 * recusa com 409 fora dessa janela; a tela nunca decide sozinha se "já
 * passou do corte", só esconde o botão fora do estado que o permite).
 *
 * A timeline mostra só os eventos REAIS já ocorridos (`timeline[]` da API) —
 * nenhuma etapa futura é fabricada aqui (Constitution VI): o status atual já
 * está coberto pelo badge de topo.
 *
 * Ref: prototipo M07-M09, M11; Spec US1, §FR-013/FR-014.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ThemeToggle } from '@/components/theme-toggle';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/utils';
import { buscarDetalheAdiantamento, cancelarAdiantamento, type SolicitacaoDetalhe } from '@/lib/adiantamento-api';
import { traduzirErroAdiantamento } from '@/lib/erros-adiantamento';
import { statusInfo } from '@/lib/adiantamento-status';
import { iconeStatus } from '@/lib/adiantamento-status-icon';
import { AlertCircle, ArrowLeft, Check, EventRepeat } from '@/components/ui/icons';

export default function AdiantamentoDetalhePage() {
  const params = useParams<{ id: string }>();
  const [detalhe, setDetalhe] = useState<SolicitacaoDetalhe | null | undefined>(undefined);
  const [cancelando, setCancelando] = useState(false);

  const carregar = useCallback(() => {
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) {
      setDetalhe(null);
      return;
    }
    setDetalhe(undefined);
    buscarDetalheAdiantamento(id).then(setDetalhe).catch(() => setDetalhe(null));
  }, [params.id]);

  useEffect(() => { carregar(); }, [carregar]);

  async function handleCancelar() {
    if (!detalhe) return;
    setCancelando(true);
    try {
      const atualizado = await cancelarAdiantamento(detalhe.id);
      setDetalhe(atualizado);
      toast.success('Solicitação cancelada.');
    } catch (err) {
      const { mensagem } = traduzirErroAdiantamento(err);
      toast.error(mensagem);
      carregar(); // pode ter passado do corte nesse meio-tempo — recarrega o estado real
    } finally {
      setCancelando(false);
    }
  }

  const info = detalhe ? statusInfo(detalhe.status) : null;
  const Icone = detalhe ? iconeStatus(detalhe.status) : null;

  return (
    <main className="relative flex min-h-dvh flex-col bg-muted/40">
      <header className="glass sticky top-0 z-20 flex items-center justify-between rounded-none border-x-0 border-t-0 px-3 pb-3 pt-[max(0.85rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-1">
          <Link
            href="/adiantamento"
            aria-label="Voltar"
            className="inline-flex h-11 w-11 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted active:scale-90"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="font-display text-base font-semibold">
            {detalhe ? detalhe.integrationId : 'Adiantamento'}
          </h1>
        </div>
        <ThemeToggle />
      </header>

      <div className="mx-auto w-full max-w-md flex-1 space-y-4 px-4 pb-10 pt-5">
        {detalhe === undefined ? (
          <div className="space-y-3">
            <Skeleton className="h-8 w-1/2 rounded-lg" />
            <Skeleton className="h-32 rounded-2xl" />
            <Skeleton className="h-40 rounded-2xl" />
          </div>
        ) : detalhe === null ? (
          <div className="animate-fade-up flex flex-col items-center gap-3 py-16 text-center">
            <AlertCircle className="h-10 w-10 text-muted-foreground" />
            <p className="font-display text-lg font-bold">Solicitação não encontrada</p>
            <Link href="/adiantamento/historico" className="inline-flex min-h-11 items-center text-sm font-semibold text-primary underline-offset-4 hover:underline">
              Ver meus adiantamentos
            </Link>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="font-display text-base font-bold">{formatDate(detalhe.dataProducao)}</span>
              {info && Icone && (
                <Badge variant={info.variant}>
                  <Icone className="h-3.5 w-3.5" />
                  {info.label}
                </Badge>
              )}
            </div>

            {detalhe.status === 'REJEITADA' && (
              <div className="flex items-start gap-2 rounded-2xl border border-warm-2/30 bg-warm-2/10 p-4 text-sm">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[color-mix(in_oklab,var(--warm-3)_55%,var(--foreground)_45%)]" />
                <p>
                  <strong className="block text-[color-mix(in_oklab,var(--warm-3)_55%,var(--foreground)_45%)]">Rejeitado pelo financeiro</strong>
                  {detalhe.motivoStatus ? `Motivo: ${detalhe.motivoStatus}` : 'Fale com o suporte se tiver dúvida.'}
                </p>
              </div>
            )}
            {detalhe.status === 'FALHOU' && (
              <div className="flex items-start gap-2 rounded-2xl border border-warm-2/30 bg-warm-2/10 p-4 text-sm">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[color-mix(in_oklab,var(--warm-3)_55%,var(--foreground)_45%)]" />
                <p>
                  O pagamento falhou. O financeiro vai reprocessar.
                  {detalhe.motivoStatus ? ` Motivo: ${detalhe.motivoStatus}` : ''}
                </p>
              </div>
            )}
            {detalhe.status === 'INELEGIVEL' && (
              <div className="flex items-start gap-2 rounded-2xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>{detalhe.motivoStatus || 'Não houve produção suficiente para liberar este adiantamento.'}</p>
              </div>
            )}

            {detalhe.calculo && (
              <div className="space-y-2 rounded-2xl border border-border bg-card p-4">
                <p className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">Cálculo</p>
                <dl className="space-y-1.5 text-sm">
                  <div className="flex items-center justify-between">
                    <dt className="text-muted-foreground">Produção</dt>
                    <dd className="tabular">{formatCurrency(detalhe.calculo.producao)}</dd>
                  </div>
                  {detalhe.calculo.percentual != null && (
                    <div className="flex items-center justify-between">
                      <dt className="text-muted-foreground">Percentual aplicado</dt>
                      <dd className="tabular">{detalhe.calculo.percentual}%</dd>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <dt className="text-muted-foreground">Valor bruto</dt>
                    <dd className="tabular">{formatCurrency(detalhe.calculo.bruto)}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-muted-foreground">Taxa</dt>
                    <dd className="tabular">− {formatCurrency(detalhe.calculo.taxa)}</dd>
                  </div>
                  <div className="flex items-center justify-between border-t border-border/60 pt-1.5 font-semibold">
                    <dt>Valor líquido</dt>
                    <dd className="tabular">{formatCurrency(detalhe.calculo.liquido)}</dd>
                  </div>
                </dl>
                <p className="text-xs text-muted-foreground">
                  Regras da versão {detalhe.configVersion}, vigentes quando você pediu. Mudanças posteriores não
                  alteram esta solicitação.
                </p>
              </div>
            )}

            {detalhe.status === 'PAGA' && detalhe.calculo && (
              <div className="flex items-start gap-2 rounded-2xl bg-primary/5 p-4 text-sm">
                <EventRepeat className="mt-0.5 h-4 w-4 shrink-0 text-[color-mix(in_oklab,var(--primary)_70%,var(--foreground)_30%)]" />
                <p>
                  <strong className="block">Desconto no repasse</strong>
                  {formatCurrency(detalhe.calculo.bruto)} (valor bruto) serão descontados do repasse desta produção.
                  A taxa já foi cobrada aqui.
                </p>
              </div>
            )}

            {detalhe.contaMascarada && (
              <div className="space-y-1 rounded-2xl border border-border bg-card p-4">
                <p className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">
                  Conta de destino
                </p>
                <p className="text-sm">{detalhe.contaMascarada.bank} · {detalhe.contaMascarada.masked}</p>
              </div>
            )}

            {detalhe.timeline.length > 0 && (
              <div className="rounded-2xl border border-border bg-card p-4">
                <p className="mb-2 text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">
                  Andamento
                </p>
                <ol className="space-y-3">
                  {detalhe.timeline.map((ev, i) => (
                    <li key={i} className="flex items-start gap-3">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
                        <Check className="h-3 w-3" />
                      </span>
                      <div>
                        <p className="text-sm font-medium">{ev.etapa}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatDateTime(ev.ocorridoEm)}{ev.motivo ? ` · ${ev.motivo}` : ''}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {detalhe.status === 'AGUARDANDO_CORTE' && (
              <>
                <Button variant="destructive" className="w-full" onClick={handleCancelar} disabled={cancelando}>
                  {cancelando ? 'Cancelando…' : 'Cancelar solicitação'}
                </Button>
                <p className="text-center text-xs text-muted-foreground">
                  Disponível até o horário de corte de hoje. Depois disso a solicitação segue para o cálculo.
                </p>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}
