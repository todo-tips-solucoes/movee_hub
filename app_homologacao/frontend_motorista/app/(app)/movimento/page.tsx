'use client';

/**
 * Tela do Movimento Aberto.
 * Exibe valor, período, dados fiscais e links para validação e portal.
 * Ref: tarefa 5.2 / spec US2/US4 / contracts §movimento-aberto / quickstart 3, 4, 10
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/auth-context';
import { api } from '@/lib/api-client';
import { formatCurrency, formatDate, formatCNPJ, cn } from '@/lib/utils';
import { toast } from 'sonner';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { CountUp } from '@/components/ui/count-up';
import { Wordmark } from '@/components/brand/wordmark';
import { Aurora } from '@/components/brand/aurora';
import { ThemeToggle } from '@/components/theme-toggle';

interface Movimento {
  id: number;
  valor: string | number | null;
  dtInicial: string | null;
  dtFinal: string | null;
  nome: string | null;
  cnpjTomador: string | null;
  cnpjPrestador: string;
  tribnac: string | null;
  notaOk: string | boolean | null;
  erroValidacao: string | null;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'M';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export default function MovimentoPage() {
  const { user, logout } = useAuth();
  const [movimento, setMovimento] = useState<Movimento | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchMovimento = useCallback(async (soft = false) => {
    soft ? setRefreshing(true) : setLoading(true);
    try {
      const data = await api.get<{ movimento: Movimento | null }>('/motorista/movimento-aberto');
      setMovimento(data.movimento);
    } catch {
      toast.error('Erro ao carregar movimento. Tente novamente.');
      setMovimento(null);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchMovimento();
  }, [fetchMovimento]);

  const notaAprovada =
    movimento?.notaOk === true ||
    movimento?.notaOk === 'true' ||
    movimento?.notaOk === 'sim' ||
    movimento?.notaOk === '1';

  const nome = user?.nome || formatCNPJ(user?.cnpjPrestador ?? '');
  const valorNum =
    movimento?.valor != null && movimento.valor !== ''
      ? typeof movimento.valor === 'string'
        ? parseFloat(movimento.valor)
        : movimento.valor
      : NaN;

  return (
    <main className="relative flex min-h-dvh flex-col bg-muted/40">
      {/* App bar — glass */}
      <header className="glass sticky top-0 z-20 flex items-center justify-between rounded-none border-x-0 border-t-0 px-4 pb-3 pt-[max(0.85rem,env(safe-area-inset-top))]">
        <Wordmark className="text-xl" />
        <div className="flex items-center gap-0.5">
          <ThemeToggle />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => logout()}
            className="gap-1.5 text-muted-foreground"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 17l5-5-5-5M20 12H9M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
            </svg>
            Sair
          </Button>
        </div>
      </header>

      <div className="mx-auto w-full max-w-md flex-1 px-4 pb-10 pt-5">
        {/* Saudação com avatar */}
        <div className="animate-fade-up mb-5 flex items-center gap-3">
          <span className="bg-gradient-warm-rich flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl font-display text-base font-bold text-white shadow-[0_8px_18px_-8px_color-mix(in_oklab,var(--warm-3)_70%,transparent)]">
            {initials(nome)}
          </span>
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">Bem-vindo de volta</p>
            <p className="truncate font-display text-lg font-bold leading-tight">{nome}</p>
          </div>
        </div>

        {loading ? (
          /* Skeletons no formato do conteúdo real */
          <div className="space-y-4">
            <Skeleton className="h-44 rounded-3xl" />
            <Skeleton className="h-40 rounded-2xl" />
            <Skeleton className="h-12 rounded-xl" />
          </div>
        ) : movimento == null ? (
          /* Estado vazio — FR-004 */
          <div className="animate-fade-up flex flex-col items-center justify-center gap-4 py-16 text-center">
            <div className="animate-float-soft relative flex h-24 w-24 items-center justify-center">
              <span className="absolute inset-0 rounded-[2rem] bg-secondary" />
              <svg className="relative h-10 w-10 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div>
              <p className="font-display text-lg font-bold">Nenhum movimento aberto</p>
              <p className="mx-auto mt-1 max-w-xs text-sm text-muted-foreground">
                Quando houver um movimento em aberto, ele aparecerá aqui automaticamente.
              </p>
            </div>
            <Button variant="outline" onClick={() => fetchMovimento(true)} disabled={refreshing} className="mt-1">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={cn('h-4 w-4', refreshing && 'spinner')}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-2.64-6.36M21 3v6h-6" />
              </svg>
              Atualizar
            </Button>
          </div>
        ) : (
          /* Movimento aberto */
          <div className="space-y-4">
            {/* Hero — Valor */}
            <div
              className="bg-gradient-blue shine shine-sweep animate-scale-in relative overflow-hidden rounded-3xl p-6 text-white shadow-[0_24px_50px_-24px_var(--primary)]"
            >
              <Aurora className="opacity-60" />
              <div className="relative">
                <div className="flex items-center justify-between">
                  <p className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-[0.7rem] font-semibold uppercase tracking-wider text-white/90 backdrop-blur-sm">
                    <span className="h-1.5 w-1.5 rounded-full bg-warm-1 pulse-ring" />
                    Movimento aberto
                  </p>
                </div>
                <p className="mt-4 text-xs font-medium uppercase tracking-[0.18em] text-white/75">
                  Valor da nota fiscal
                </p>
                <p className="tabular mt-1.5 text-[2.7rem] font-bold leading-none tracking-tight [text-shadow:0_2px_22px_rgba(0,0,0,0.22)]">
                  {isNaN(valorNum) ? (
                    formatCurrency(movimento.valor)
                  ) : (
                    <CountUp value={valorNum} format={formatCurrency} />
                  )}
                </p>
                <div className="bg-gradient-warm-rich animate-gradient mt-4 h-1.5 w-16 rounded-full" />
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-lg bg-white/12 px-2.5 py-1.5 text-xs font-medium text-white/90 backdrop-blur-sm">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5 opacity-80">
                      <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" strokeLinecap="round" />
                    </svg>
                    <span className="tabular">{formatDate(movimento.dtInicial)}</span>
                  </span>
                  <span className="flex items-center text-white/50">→</span>
                  <span className="inline-flex items-center gap-1.5 rounded-lg bg-white/12 px-2.5 py-1.5 text-xs font-medium text-white/90 backdrop-blur-sm">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5 opacity-80">
                      <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" strokeLinecap="round" />
                    </svg>
                    <span className="tabular">{formatDate(movimento.dtFinal)}</span>
                  </span>
                </div>
              </div>
            </div>

            {/* Dados fiscais — bento grid */}
            <div className="animate-fade-up stagger" style={{ ['--d' as string]: '90ms' }}>
              <h2 className="font-display mb-2.5 flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Dados Fiscais
              </h2>
              <div className="grid grid-cols-2 gap-3">
                {(movimento.nome || movimento.cnpjTomador) && (
                  <div className="glass col-span-2 rounded-2xl p-4">
                    <p className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">
                      Tomador
                    </p>
                    {movimento.nome && (
                      <p className="font-display mt-1 font-semibold leading-snug">{movimento.nome}</p>
                    )}
                    {movimento.cnpjTomador && (
                      <p className="tabular mt-0.5 text-sm text-muted-foreground">
                        {formatCNPJ(movimento.cnpjTomador)}
                      </p>
                    )}
                  </div>
                )}

                {movimento.tribnac && (
                  <div className="glass rounded-2xl p-4">
                    <p className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">
                      TribNac
                    </p>
                    <p className="tabular mt-1 text-xl font-semibold">{movimento.tribnac}</p>
                  </div>
                )}

                <div className={cn('glass flex flex-col justify-between rounded-2xl p-4', !movimento.tribnac && 'col-span-2')}>
                  <p className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">
                    Status da NF
                  </p>
                  <div className="mt-2">
                    {notaAprovada ? (
                      <Badge variant="success">● Aprovada</Badge>
                    ) : (
                      <Badge variant="warning">● Pendente</Badge>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Status detalhado */}
            {notaAprovada ? (
              <div className="animate-fade-up stagger flex items-center gap-3 rounded-2xl border border-success/30 bg-success/10 p-4" style={{ ['--d' as string]: '150ms' }}>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-success text-white shadow-[0_6px_16px_-6px_var(--success)]">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeDasharray="24" strokeDashoffset="24" style={{ animation: 'mv-draw 0.5s ease 0.2s forwards' }} d="M5 13l4 4L19 7" />
                  </svg>
                </span>
                <p className="text-sm font-medium text-success">Nota aprovada. Reenvio bloqueado.</p>
              </div>
            ) : movimento.erroValidacao ? (
              <div className="animate-fade-up stagger rounded-2xl border border-warm-2/30 bg-warm-2/10 p-4" style={{ ['--d' as string]: '150ms' }}>
                <p className="font-display flex items-center gap-2 text-sm font-semibold text-warm-3">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.3 3.86l-8.06 14A2 2 0 004 21h16a2 2 0 001.74-3.14l-8.06-14a2 2 0 00-3.48 0z" />
                  </svg>
                  Última validação: campos reprovados
                </p>
                <p className="mt-1 text-xs text-warm-3/90">{movimento.erroValidacao}</p>
              </div>
            ) : null}

            {/* Ações */}
            <div className="animate-fade-up stagger space-y-2.5 pt-1" style={{ ['--d' as string]: '210ms' }}>
              {!notaAprovada && (
                <div className="glow-warm relative">
                  <Link href="/validar" className={cn(buttonVariants({ variant: 'warm', size: 'lg' }), 'relative z-10 w-full')}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    Validar minha NFS-e
                  </Link>
                </div>
              )}

              <a
                href="https://www.nfse.gov.br"
                target="_blank"
                rel="noopener noreferrer"
                className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'w-full')}
              >
                Portal NFS-e Nacional
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7 17L17 7M9 7h8v8" />
                </svg>
              </a>

              <Button variant="ghost" onClick={() => fetchMovimento(true)} disabled={refreshing} className="w-full">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={cn('h-4 w-4', refreshing && 'spinner')}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-2.64-6.36M21 3v6h-6" />
                </svg>
                {refreshing ? 'Atualizando…' : 'Atualizar'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
