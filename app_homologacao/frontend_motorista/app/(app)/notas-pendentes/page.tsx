'use client';

/**
 * Notas pendentes — o motorista envia o XML de cada nota que ficou em aberto
 * (últimos 90 dias), uma por pendência. A tela /validar segue intacta; as duas
 * vias convivem (BRIEFING decisão B).
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ThemeToggle } from '@/components/theme-toggle';
import { EnviarNotaPendente } from '@/components/enviar-nota-pendente';
import { ArrowLeft, AlertCircle, Inbox, RefreshCw } from '@/components/ui/icons';
import { formatCurrency } from '@/lib/utils';
import {
  listarNotasPendentes,
  periodoDaPendencia,
  rotuloOrigem,
  type NotaPendente,
} from '@/lib/notas-pendentes-api';

export default function NotasPendentesPage() {
  const [notas, setNotas] = useState<NotaPendente[] | null>(null);
  const [erro, setErro] = useState(false);

  const carregar = useCallback(() => {
    setErro(false);
    setNotas(null);
    listarNotasPendentes()
      .then(setNotas)
      .catch((e) => {
        console.error('[notas-pendentes] falha ao listar:', e);
        setErro(true);
      });
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  return (
    <main className="relative flex min-h-dvh flex-col bg-muted/40">
      <header className="glass sticky top-0 z-20 flex items-center justify-between rounded-none border-x-0 border-t-0 px-3 pb-3 pt-[max(0.85rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-1">
          <Link
            href="/movimento"
            aria-label="Voltar"
            className="inline-flex h-11 w-11 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted active:scale-90"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="font-display text-base font-semibold">Notas pendentes</h1>
        </div>
        <ThemeToggle />
      </header>

      <div className="mx-auto w-full max-w-md flex-1 px-4 pb-10 pt-6">
        <p className="mb-5 text-sm text-muted-foreground">
          Emita a nota de cada item para o tomador indicado e envie o XML. O pagamento depende do
          envio da nota.
        </p>

        {erro ? (
          <div role="alert" className="flex flex-col items-center gap-3 py-12 text-center">
            <AlertCircle className="h-8 w-8 text-destructive" />
            <p className="font-display font-bold">Não foi possível carregar suas notas</p>
            <Button variant="outline" onClick={carregar} className="min-h-11">
              <RefreshCw className="h-4 w-4" />
              Tentar novamente
            </Button>
          </div>
        ) : notas === null ? (
          <div className="space-y-3" aria-busy="true" aria-label="Carregando notas pendentes">
            <Skeleton className="h-40 rounded-2xl" />
            <Skeleton className="h-40 rounded-2xl" />
          </div>
        ) : notas.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <Inbox className="h-8 w-8 text-primary" />
            <p className="font-display font-bold">Nenhuma nota pendente</p>
          </div>
        ) : (
          <ul className="space-y-3">
            {notas.map((n) => (
              <li key={n.id} className="glass space-y-3 rounded-2xl p-4">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="tabular text-sm font-medium text-muted-foreground">
                    {periodoDaPendencia(n)}
                  </span>
                  <span className="tabular font-display text-xl font-bold">{formatCurrency(n.valor)}</span>
                </div>
                <div>
                  <p className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">
                    Emitir nota para
                  </p>
                  <p className="font-display font-semibold leading-snug">{n.tomador || '—'}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{rotuloOrigem(n.origem)}</p>
                </div>
                <EnviarNotaPendente nota={n} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
