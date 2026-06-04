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
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Wordmark } from '@/components/brand/wordmark';
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

export default function MovimentoPage() {
  const { user, logout } = useAuth();
  const [movimento, setMovimento] = useState<Movimento | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const fetchMovimento = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<{ movimento: Movimento | null }>('/motorista/movimento-aberto');
      setMovimento(data.movimento);
    } catch {
      toast.error('Erro ao carregar movimento. Tente novamente.');
      setMovimento(null);
    } finally {
      setLoading(false);
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

  return (
    <main className="flex min-h-dvh flex-col bg-muted/40">
      {/* App bar */}
      <header className="sticky top-0 z-10 flex items-center justify-between bg-primary px-4 pb-3.5 pt-[max(0.875rem,env(safe-area-inset-top))] text-primary-foreground shadow-sm">
        <Wordmark className="text-xl" />
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => logout()}
            className="text-primary-foreground/90 hover:bg-white/15 hover:text-primary-foreground"
          >
            Sair
          </Button>
        </div>
      </header>

      <div className="flex-1 px-4 py-5">
        <p className="mb-4 text-sm text-muted-foreground">
          Olá,{' '}
          <span className="font-display font-semibold text-foreground">
            {user?.nome || formatCNPJ(user?.cnpjPrestador ?? '')}
          </span>
        </p>

        {loading ? (
          <div className="flex flex-1 items-center justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : movimento == null ? (
          /* Estado vazio — FR-004 */
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <div className="rounded-2xl bg-secondary p-4">
              <svg className="h-8 w-8 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <p className="font-display font-semibold">Nenhum movimento aberto</p>
            <p className="max-w-xs text-sm text-muted-foreground">
              Quando houver um movimento em aberto, ele aparecerá aqui.
            </p>
            <Button variant="outline" size="sm" onClick={fetchMovimento} className="mt-1">
              Atualizar
            </Button>
          </div>
        ) : (
          /* Movimento aberto */
          <div className="space-y-4">
            {/* Card principal — Valor */}
            <div className="bg-gradient-blue relative overflow-hidden rounded-2xl p-5 text-white shadow-md shadow-primary/20">
              <div className="absolute -right-8 -top-8 h-28 w-28 rounded-full bg-white/10" />
              <p className="text-xs font-medium uppercase tracking-wider text-white/80">
                Valor da nota fiscal
              </p>
              <p className="font-display mt-1.5 text-[2rem] font-extrabold leading-none tracking-tight">
                {formatCurrency(movimento.valor)}
              </p>
              <div className="bg-gradient-warm mt-3 h-1 w-14 rounded-full" />
              <div className="mt-3 flex flex-wrap gap-x-4 text-xs text-white/85">
                <span>De: {formatDate(movimento.dtInicial)}</span>
                <span>Até: {formatDate(movimento.dtFinal)}</span>
              </div>
            </div>

            {/* Dados fiscais */}
            <Card className="p-5">
              <h2 className="font-display mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Dados Fiscais
              </h2>
              <dl className="divide-y divide-border text-sm">
                {movimento.nome && (
                  <div className="flex justify-between gap-3 py-2 first:pt-0">
                    <dt className="text-muted-foreground">Nome</dt>
                    <dd className="font-display text-right font-semibold">{movimento.nome}</dd>
                  </div>
                )}
                {movimento.cnpjTomador && (
                  <div className="flex justify-between gap-3 py-2">
                    <dt className="text-muted-foreground">CNPJ Tomador</dt>
                    <dd className="font-display font-semibold">{formatCNPJ(movimento.cnpjTomador)}</dd>
                  </div>
                )}
                {movimento.tribnac && (
                  <div className="flex justify-between gap-3 py-2">
                    <dt className="text-muted-foreground">TribNac</dt>
                    <dd className="font-display font-semibold">{movimento.tribnac}</dd>
                  </div>
                )}
                <div className="flex items-center justify-between gap-3 py-2 last:pb-0">
                  <dt className="text-muted-foreground">Status da NF</dt>
                  <dd>
                    {notaAprovada ? (
                      <Badge variant="success">● Aprovada</Badge>
                    ) : (
                      <Badge variant="warning">● Pendente</Badge>
                    )}
                  </dd>
                </div>
              </dl>
            </Card>

            {/* Status detalhado */}
            {notaAprovada ? (
              <div className="flex items-center gap-2.5 rounded-xl border border-success/30 bg-success/10 p-4">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success text-white">
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </span>
                <p className="text-sm font-medium text-success">Nota aprovada. Reenvio bloqueado.</p>
              </div>
            ) : movimento.erroValidacao ? (
              <div className="rounded-xl border border-warm-2/30 bg-warm-2/10 p-4">
                <p className="font-display text-sm font-semibold text-warm-3">
                  Última validação: campos reprovados
                </p>
                <p className="mt-1 text-xs text-warm-3/90">{movimento.erroValidacao}</p>
              </div>
            ) : null}

            {/* Ações */}
            <div className="space-y-2.5 pt-1">
              {!notaAprovada && (
                <Link href="/validar" className={cn(buttonVariants({ variant: 'warm', size: 'lg' }), 'w-full')}>
                  Validar minha NFS-e
                </Link>
              )}

              <a
                href="https://www.nfse.gov.br"
                target="_blank"
                rel="noopener noreferrer"
                className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'w-full')}
              >
                Portal NFS-e Nacional ↗
              </a>

              <Button variant="ghost" onClick={fetchMovimento} className="w-full">
                Atualizar
              </Button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
