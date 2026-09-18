'use client';

/**
 * adiantamento-motorista — app/(app)/adiantamento/historico/page.tsx (tasks.md 6.3.3)
 *
 * Lista paginada de solicitações (protótipo M10) — `statusRotulo` vem pronto
 * de `GET /motorista/adiantamentos` (mesmo texto do backend, nunca
 * reformulado aqui).
 *
 * Ref: prototipo M10; Spec US1.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { BottomNav } from '@/components/bottom-nav';
import { ThemeToggle } from '@/components/theme-toggle';
import { formatCurrency, formatDate } from '@/lib/utils';
import { buscarHistoricoAdiantamentos, type SolicitacaoResumoLista } from '@/lib/adiantamento-api';
import { statusInfo } from '@/lib/adiantamento-status';
import { iconeStatus } from '@/lib/adiantamento-status-icon';
import { Inbox } from '@/components/ui/icons';

export default function HistoricoAdiantamentoPage() {
  const [itens, setItens] = useState<SolicitacaoResumoLista[]>([]);
  const [pagina, setPagina] = useState(1);
  const [total, setTotal] = useState<number | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState(false);

  const carregarPagina = useCallback((p: number) => {
    setCarregando(true);
    buscarHistoricoAdiantamentos(p)
      .then((r) => {
        setItens((prev) => (p === 1 ? r.itens : [...prev, ...r.itens]));
        setTotal(r.total);
        setPagina(p);
        setErro(false);
      })
      .catch(() => setErro(true))
      .finally(() => setCarregando(false));
  }, []);

  useEffect(() => { carregarPagina(1); }, [carregarPagina]);

  const temMais = total != null && itens.length < total;

  return (
    <main className="relative flex min-h-dvh flex-col bg-muted/40">
      <header className="glass sticky top-0 z-20 flex items-center justify-between rounded-none border-x-0 border-t-0 px-4 pb-3 pt-[max(0.85rem,env(safe-area-inset-top))]">
        <h1 className="font-display text-lg font-bold">Meus adiantamentos</h1>
        <ThemeToggle />
      </header>

      <div className="mx-auto w-full max-w-md flex-1 space-y-3 px-4 pb-24 pt-5">
        {carregando && itens.length === 0 ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16 rounded-2xl" />)}
          </div>
        ) : erro && itens.length === 0 ? (
          <div className="animate-fade-up flex flex-col items-center gap-3 py-16 text-center">
            <Inbox className="h-10 w-10 text-muted-foreground" />
            <p className="font-display text-lg font-bold">Não foi possível carregar</p>
            <Button variant="outline" onClick={() => carregarPagina(1)}>Tentar de novo</Button>
          </div>
        ) : itens.length === 0 ? (
          <div className="animate-fade-up flex flex-col items-center gap-3 py-16 text-center">
            <Inbox className="h-10 w-10 text-muted-foreground" />
            <p className="font-display text-lg font-bold">Nenhum adiantamento ainda</p>
            <p className="max-w-xs text-sm text-muted-foreground">
              Suas solicitações de adiantamento aparecem aqui.
            </p>
          </div>
        ) : (
          <>
            <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
              {itens.map((item) => {
                const info = statusInfo(item.status);
                const Icone = iconeStatus(item.status);
                return (
                  <Link key={item.id} href={`/adiantamento/${item.id}`} className="flex items-center gap-3 p-4">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted">
                      <Icone className="h-4 w-4 text-muted-foreground" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{formatDate(item.dataSolicitacao)}</span>
                      <span className="tabular block text-xs text-muted-foreground">
                        {formatCurrency(item.valorLiquido)}
                      </span>
                    </span>
                    <Badge variant={info.variant}>{item.statusRotulo}</Badge>
                  </Link>
                );
              })}
            </div>
            {temMais && (
              <Button variant="outline" className="w-full" onClick={() => carregarPagina(pagina + 1)} disabled={carregando}>
                {carregando ? 'Carregando…' : 'Carregar mais'}
              </Button>
            )}
          </>
        )}
      </div>

      <BottomNav />
    </main>
  );
}
