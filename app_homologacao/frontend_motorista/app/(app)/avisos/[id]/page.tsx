'use client';

/**
 * push-motorista (tasks.md 6.5.1) — detalhe do aviso aberto a partir da
 * notificação push (FR-013). Sessão expirada é tratada pelo layout de
 * `(app)` (redireciona para `/login?next=/avisos/<id>`, resolvido de volta
 * por `lib/next-seguro.ts` após o login — 6.5.2).
 *
 * Ref: contracts/motorista-push.md §GET /motorista/avisos/:id
 */

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api-client';
import { formatDate } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { ThemeToggle } from '@/components/theme-toggle';
import { ArrowLeft, AlertCircle, Mail } from '@/components/ui/icons';

interface Aviso {
  id: number;
  titulo: string;
  corpo: string;
  enviadoEm: string;
}

export default function AvisoDetalhePage() {
  const params = useParams<{ id: string }>();
  // undefined = carregando; null = indisponível (404 nos 3 casos do
  // contrato: inexistente, expurgado ou fora de escopo — sem distinção)
  const [aviso, setAviso] = useState<Aviso | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<Aviso>(`/motorista/avisos/${params.id}`);
        if (!cancelled) setAviso(data);
      } catch {
        if (!cancelled) setAviso(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  return (
    <main className="relative flex min-h-dvh flex-col bg-muted/40">
      {/* App bar — glass (mesmo padrão de app/(app)/validar/page.tsx) */}
      <header className="glass sticky top-0 z-20 flex items-center justify-between rounded-none border-x-0 border-t-0 px-3 pb-3 pt-[max(0.85rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-1">
          <Link
            href="/movimento"
            aria-label="Voltar"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted active:scale-90"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="font-display text-base font-semibold">Aviso</h1>
        </div>
        <ThemeToggle />
      </header>

      <div className="mx-auto w-full max-w-md flex-1 px-4 pb-10 pt-6">
        {aviso === undefined ? (
          <div className="space-y-3">
            <Skeleton className="h-6 w-2/3 rounded-lg" />
            <Skeleton className="h-24 rounded-2xl" />
          </div>
        ) : aviso === null ? (
          <div className="animate-fade-up flex flex-col items-center gap-3 py-16 text-center">
            <AlertCircle className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
            <p className="font-display text-lg font-bold">Aviso não disponível</p>
            <p className="max-w-xs text-sm text-muted-foreground">
              Este aviso não existe mais, expirou ou não é destinado a você.
            </p>
          </div>
        ) : (
          <div className="animate-fade-up space-y-3">
            <div className="flex items-start gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm">
              <Mail className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
              <div className="min-w-0">
                <h2 className="font-display text-lg font-bold">{aviso.titulo}</h2>
                <p className="mt-1 text-xs text-muted-foreground">{formatDate(aviso.enviadoEm)}</p>
              </div>
            </div>
            <p className="whitespace-pre-wrap rounded-2xl border border-border bg-card p-4 text-sm leading-relaxed">
              {aviso.corpo}
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
