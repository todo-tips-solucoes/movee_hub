'use client';

/**
 * adiantamento-motorista — app/(app)/adiantamento/page.tsx (tasks.md 6.3.1)
 *
 * Unifica os estados de disponibilidade do protótipo M03 (disponível),
 * M04 (dia indisponível) e M05 (prazo encerrado) numa única tela orientada
 * por `GET /motorista/adiantamento/disponibilidade` — o conteúdo/textos
 * seguem o protótipo, a divisão em 3 telas estáticas não (dado real decide
 * qual bloco aparece, nunca 3 componentes quase-duplicados). O sheet de
 * confirmação (M06, aceite obrigatório) abre por cima desta tela.
 *
 * Ref: prototipo M03-M06; Spec US1, §FR-002/FR-003/FR-007.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { BottomNav } from '@/components/bottom-nav';
import { ThemeToggle } from '@/components/theme-toggle';
import { cn, formatCurrency, formatDate, formatDateTime } from '@/lib/utils';
import {
  buscarDisponibilidade, buscarRegras, solicitarAdiantamento,
  type Disponibilidade, type EstimativaAdiantamento, type Regras,
} from '@/lib/adiantamento-api';
import { mensagemMotivo, traduzirErroAdiantamento } from '@/lib/erros-adiantamento';
import { statusInfo } from '@/lib/adiantamento-status';
import { AlertTriangle, CheckCircle, EventBusy, Help, Info, TimerOff } from '@/components/ui/icons';

function Breakdown({
  estimate, percentual, final: valorFinal,
}: { estimate: EstimativaAdiantamento; percentual: number | null; final: boolean }) {
  return (
    <dl className="space-y-1.5 text-sm">
      <div className="flex items-center justify-between">
        <dt className="text-muted-foreground">Produção considerada</dt>
        <dd className="tabular font-medium">{formatCurrency(estimate.production)}</dd>
      </div>
      {percentual != null && (
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">{percentual}% da produção</dt>
          <dd className="tabular font-medium">{formatCurrency(estimate.gross)}</dd>
        </div>
      )}
      <div className="flex items-center justify-between">
        <dt className="text-muted-foreground">Taxa de transferência</dt>
        <dd className="tabular font-medium">− {formatCurrency(estimate.fee)}</dd>
      </div>
      <div className="flex items-center justify-between border-t border-border/60 pt-1.5 font-semibold">
        <dt>Você recebe{valorFinal ? '' : ' (estimativa)'}</dt>
        <dd className="tabular">{formatCurrency(estimate.net)}</dd>
      </div>
    </dl>
  );
}

function TelaIndisponivel({ disp }: { disp: Disponibilidade }) {
  const Icone = disp.reason === 'AFTER_CUTOFF' || disp.reason === 'BEFORE_OPENING' ? TimerOff : EventBusy;
  return (
    <>
      <Badge variant="muted">
        <Icone className="h-3.5 w-3.5" />
        Indisponível hoje
      </Badge>
      <div className="rounded-3xl border border-border bg-card p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-muted">
            <Icone className="h-5 w-5 text-muted-foreground" />
          </span>
          <p className="font-display text-base font-bold leading-snug">
            {mensagemMotivo(disp.reason ?? 'NOT_CONFIGURED')}
          </p>
        </div>
        {disp.nextAvailableAt && (
          <div className="mt-3 flex items-start gap-2 rounded-xl bg-primary/5 p-3 text-sm">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <p><strong className="block">Próxima oportunidade</strong>{formatDateTime(disp.nextAvailableAt)}</p>
          </div>
        )}
      </div>
      {disp.todayRequest && (
        <Link
          href={`/adiantamento/${disp.todayRequest.id}`}
          className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4 text-sm font-medium"
        >
          <span>Sua solicitação de hoje ({disp.todayRequest.integrationId})</span>
          <Badge variant={statusInfo(disp.todayRequest.status).variant}>
            {statusInfo(disp.todayRequest.status).label}
          </Badge>
        </Link>
      )}
      <Link href="/adiantamento/regras" className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'w-full')}>
        Ver regras do adiantamento
      </Link>
    </>
  );
}

function SheetConfirmar({
  disp, regras, aceite, onAceiteChange, enviando, onConfirmar, onFechar,
}: {
  disp: Disponibilidade;
  regras: Regras | null | undefined;
  aceite: boolean;
  onAceiteChange: (v: boolean) => void;
  enviando: boolean;
  onConfirmar: () => void;
  onFechar: () => void;
}) {
  return (
    <div
      role="presentation"
      onClick={onFechar}
      className="fixed inset-0 z-40 flex items-end bg-black/40 backdrop-blur-sm"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-titulo"
        onClick={(e) => e.stopPropagation()}
        className="animate-scale-in relative z-50 w-full rounded-t-3xl bg-card p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl"
      >
        <span className="mx-auto mb-3 block h-1.5 w-10 rounded-full bg-border" aria-hidden="true" />
        <h2 id="sheet-titulo" className="font-display text-lg font-bold">Confirmar solicitação</h2>

        {disp.estimate?.eligible && (
          <div className="mt-3">
            <Breakdown estimate={disp.estimate} percentual={disp.percentage} final={false} />
          </div>
        )}

        {disp.bankAccount && (
          <p className="mt-3 text-sm text-muted-foreground">
            {disp.bankAccount.bank} · {disp.bankAccount.masked}
          </p>
        )}

        <div className="mt-3 rounded-xl bg-muted p-3 text-xs">
          <p className="font-semibold">
            Termos do adiantamento{regras ? ` (versão ${regras.configVersion})` : ''}
          </p>
          {regras === undefined ? (
            <Skeleton className="mt-2 h-16 rounded-lg" />
          ) : regras ? (
            <ul className="mt-1.5 list-disc space-y-1 pl-4">
              {regras.itens.map((item) => (
                <li key={item.titulo}>{item.descricao}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-1.5 text-muted-foreground">Não foi possível carregar os termos.</p>
          )}
        </div>

        <label className="mt-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={aceite}
            onChange={(e) => onAceiteChange(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0"
          />
          <span>Li e concordo com os termos acima.</span>
        </label>

        <Button
          className="mt-4 w-full"
          size="lg"
          disabled={!aceite || enviando || regras == null}
          onClick={onConfirmar}
        >
          {enviando ? 'Enviando…' : 'Confirmar solicitação'}
        </Button>
        <Button variant="ghost" className="mt-1.5 w-full" onClick={onFechar} disabled={enviando}>
          Voltar
        </Button>
      </div>
    </div>
  );
}

export default function AdiantamentoPage() {
  const router = useRouter();
  const [disp, setDisp] = useState<Disponibilidade | null | undefined>(undefined);
  const [sheetAberto, setSheetAberto] = useState(false);
  const [regras, setRegras] = useState<Regras | null | undefined>(undefined);
  const [aceite, setAceite] = useState(true);
  const [enviando, setEnviando] = useState(false);

  const carregar = useCallback(() => {
    setDisp(undefined);
    buscarDisponibilidade().then(setDisp).catch(() => setDisp(null));
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  function abrirSheet() {
    setAceite(true);
    setSheetAberto(true);
    if (regras === undefined) {
      buscarRegras().then(setRegras).catch(() => setRegras(null));
    }
  }

  async function confirmar() {
    if (!disp || !aceite) return;
    setEnviando(true);
    try {
      const chaveIdempotencia = crypto.randomUUID();
      const detalhe = await solicitarAdiantamento({
        aceite: true,
        chaveIdempotencia,
        configuracaoId: disp.configuracaoId,
      });
      setSheetAberto(false);
      router.push(`/adiantamento/${detalhe.id}`);
    } catch (err) {
      const { mensagem } = traduzirErroAdiantamento(err);
      toast.error(mensagem);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <main className="relative flex min-h-dvh flex-col bg-muted/40">
      <header className="glass sticky top-0 z-20 flex items-center justify-between rounded-none border-x-0 border-t-0 px-4 pb-3 pt-[max(0.85rem,env(safe-area-inset-top))]">
        <h1 className="font-display text-lg font-bold">Adiantamento</h1>
        <ThemeToggle />
      </header>

      <div className="mx-auto w-full max-w-md flex-1 space-y-4 px-4 pb-24 pt-5">
        {disp === undefined ? (
          <div className="space-y-4">
            <Skeleton className="h-40 rounded-3xl" />
            <Skeleton className="h-32 rounded-2xl" />
          </div>
        ) : disp === null ? (
          <div className="animate-fade-up flex flex-col items-center gap-3 py-16 text-center">
            <AlertTriangle className="h-10 w-10 text-muted-foreground" />
            <p className="font-display text-lg font-bold">Não foi possível carregar</p>
            <Button variant="outline" onClick={carregar}>Tentar de novo</Button>
          </div>
        ) : disp.canRequest ? (
          <>
            <div className="flex items-center justify-between">
              <Badge variant="success">
                <CheckCircle className="h-3.5 w-3.5" />
                Disponível hoje
              </Badge>
              <span className="tabular text-xs font-medium text-muted-foreground">até {disp.cutoffTime}</span>
            </div>

            <div className="space-y-3 rounded-3xl border border-border bg-card p-5 shadow-sm">
              <div>
                <p className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">
                  Produção considerada
                </p>
                <p className="mt-1 font-semibold">
                  Sua solicitação de hoje usa a produção de {formatDate(disp.productionDate)}.
                </p>
              </div>
              {disp.estimate?.eligible ? (
                <Breakdown estimate={disp.estimate} percentual={disp.percentage} final={false} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  A estimativa aparece assim que a produção de ontem for importada.
                </p>
              )}
              <div className="flex items-start gap-2 rounded-xl bg-primary/5 p-3 text-xs text-foreground/80">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <p>O valor final é calculado às {disp.cutoffTime}, com a produção importada até lá.</p>
              </div>
            </div>

            {disp.bankAccount && (
              <div className="space-y-2 rounded-2xl border border-border bg-card p-4">
                <p className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">
                  Conta de destino
                </p>
                <p className="text-sm">{disp.bankAccount.bank} · {disp.bankAccount.masked}</p>
                <Link href="/conta-bancaria" className="inline-flex min-h-11 items-center text-sm font-semibold text-primary underline-offset-4 hover:underline">
                  Ver ou alterar dados bancários
                </Link>
              </div>
            )}

            <Button className="w-full" size="lg" onClick={abrirSheet}>
              Solicitar adiantamento
            </Button>
            <Link href="/adiantamento/regras" className={cn(buttonVariants({ variant: 'ghost', size: 'lg' }), 'w-full')}>
              <Help className="h-4 w-4" />
              Como funciona
            </Link>
          </>
        ) : (
          <TelaIndisponivel disp={disp} />
        )}
      </div>

      {sheetAberto && disp && (
        <SheetConfirmar
          disp={disp}
          regras={regras}
          aceite={aceite}
          onAceiteChange={setAceite}
          enviando={enviando}
          onConfirmar={confirmar}
          onFechar={() => setSheetAberto(false)}
        />
      )}

      <BottomNav />
    </main>
  );
}
