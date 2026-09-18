'use client';

/**
 * adiantamento-motorista — app/(app)/notificacoes/page.tsx (tasks.md 6.5.1)
 *
 * Central de notificações (protótipo M02) — histórico persistente
 * independente de push (US7, FR-042..FR-044). Filtro por categoria e por
 * não lidas é um único seletor (mesmo comportamento do protótipo: os chips
 * são mutuamente exclusivos), tocar marca como lida e navega pelo `link`
 * revalidado (`lib/notificacao-link.ts` — defesa em profundidade).
 *
 * Ref: prototipo M02; Spec US7, §FR-042..FR-044.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { BottomNav } from '@/components/bottom-nav';
import { ThemeToggle } from '@/components/theme-toggle';
import { cn, formatDateTime } from '@/lib/utils';
import {
  buscarNotificacoes, buscarNotificacoesNaoLidas, marcarNotificacaoLida, marcarTodasNotificacoesLidas,
  type CategoriaNotificacao, type Notificacao,
} from '@/lib/adiantamento-api';
import { linkPermitido } from '@/lib/notificacao-link';
import { AlertTriangle, Bell, DoneAll, Inbox, Info, Paid, Payments, Wallet } from '@/components/ui/icons';

type Filtro = 'todas' | 'nao_lidas' | CategoriaNotificacao;

const CHIPS: { valor: Filtro; label: string }[] = [
  { valor: 'todas', label: 'Todas' },
  { valor: 'nao_lidas', label: 'Não lidas' },
  { valor: 'adiantamento', label: 'Adiantamento' },
  { valor: 'pagamento', label: 'Pagamento' },
  { valor: 'conta_bancaria', label: 'Conta bancária' },
  { valor: 'sistema', label: 'Sistema' },
  { valor: 'aviso', label: 'Avisos' },
];

const ICONE_CATEGORIA: Record<CategoriaNotificacao, typeof Bell> = {
  adiantamento: Payments,
  pagamento: Paid,
  conta_bancaria: Wallet,
  sistema: Info,
  aviso: Bell,
};

export default function NotificacoesPage() {
  const [filtro, setFiltro] = useState<Filtro>('todas');
  const [itens, setItens] = useState<Notificacao[]>([]);
  const [pagina, setPagina] = useState(1);
  const [total, setTotal] = useState<number | null>(null);
  const [totalNaoLidas, setTotalNaoLidas] = useState(0);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState(false);

  const carregarPagina = useCallback((f: Filtro, p: number) => {
    setCarregando(true);
    buscarNotificacoes({
      pagina: p,
      categoria: f === 'todas' || f === 'nao_lidas' ? undefined : f,
      naoLidas: f === 'nao_lidas' ? true : undefined,
    })
      .then((r) => {
        setItens((prev) => (p === 1 ? r.itens : [...prev, ...r.itens]));
        setTotal(r.total);
        setPagina(p);
        setErro(false);
      })
      .catch(() => setErro(true))
      .finally(() => setCarregando(false));
  }, []);

  useEffect(() => { carregarPagina(filtro, 1); }, [filtro, carregarPagina]);

  const atualizarBadge = useCallback(() => {
    buscarNotificacoesNaoLidas().then((r) => setTotalNaoLidas(r.total)).catch(() => {});
  }, []);

  useEffect(() => { atualizarBadge(); }, [atualizarBadge]);

  async function abrir(n: Notificacao) {
    if (!n.lida) {
      setItens((prev) => prev.map((i) => (i.id === n.id ? { ...i, lida: true } : i)));
      setTotalNaoLidas((t) => Math.max(0, t - 1));
      marcarNotificacaoLida(n.id).catch(() => {
        // fail-silent: pior caso é reler como não lida na próxima carga
      });
    }
  }

  async function marcarTodas() {
    setItens((prev) => prev.map((i) => ({ ...i, lida: true })));
    setTotalNaoLidas(0);
    try {
      await marcarTodasNotificacoesLidas();
    } catch {
      carregarPagina(filtro, 1);
      atualizarBadge();
    }
  }

  const temMais = total != null && itens.length < total;

  return (
    <main className="relative flex min-h-dvh flex-col bg-muted/40">
      <header className="glass sticky top-0 z-20 flex items-center justify-between rounded-none border-x-0 border-t-0 px-4 pb-3 pt-[max(0.85rem,env(safe-area-inset-top))]">
        <h1 className="font-display text-lg font-bold">Notificações</h1>
        <ThemeToggle />
      </header>

      <div className="mx-auto w-full max-w-md flex-1 space-y-3 px-4 pb-24 pt-5">
        <div role="group" aria-label="Filtro" className="flex flex-wrap gap-1.5">
          {CHIPS.map((c) => (
            <button
              key={c.valor}
              type="button"
              aria-pressed={filtro === c.valor}
              onClick={() => setFiltro(c.valor)}
              className={cn(
                'min-h-11 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                filtro === c.valor
                  ? 'border-primary bg-primary/10 text-[color-mix(in_oklab,var(--primary)_70%,var(--foreground)_30%)]'
                  : 'border-border text-muted-foreground'
              )}
            >
              {c.label}{c.valor === 'nao_lidas' && totalNaoLidas > 0 ? ` · ${totalNaoLidas}` : ''}
            </button>
          ))}
        </div>

        {totalNaoLidas > 0 && (
          <Button variant="ghost" size="sm" className="min-h-11 justify-self-end" onClick={marcarTodas}>
            <DoneAll className="h-4 w-4" />
            Marcar todas como lidas
          </Button>
        )}

        {carregando && itens.length === 0 ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16 rounded-2xl" />)}
          </div>
        ) : erro && itens.length === 0 ? (
          <div className="animate-fade-up flex flex-col items-center gap-3 py-16 text-center">
            <AlertTriangle className="h-10 w-10 text-muted-foreground" />
            <p className="font-display text-lg font-bold">Não foi possível carregar</p>
            <Button variant="outline" onClick={() => carregarPagina(filtro, 1)}>Tentar de novo</Button>
          </div>
        ) : itens.length === 0 ? (
          <div className="animate-fade-up flex flex-col items-center gap-3 py-16 text-center">
            <Inbox className="h-10 w-10 text-muted-foreground" />
            <p className="font-display text-lg font-bold">Nenhuma notificação</p>
          </div>
        ) : (
          <>
            <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
              {itens.map((n) => {
                const Icone = ICONE_CATEGORIA[n.categoria] || Bell;
                const destino = linkPermitido(n.link);
                const conteudo = (
                  <>
                    <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', n.lida ? 'bg-muted' : 'bg-primary/10')}>
                      {/* tasks.md 6.8.3: cores puras sobre o próprio tint do
                          ícone medem < 4.5:1 (axe color-contrast) — mesmo
                          ajuste do Badge (components/ui/badge.tsx). */}
                      <Icone
                        className={cn(
                          'h-4 w-4',
                          n.lida
                            ? 'text-[color-mix(in_oklab,var(--muted-foreground)_55%,var(--foreground)_45%)]'
                            : 'text-[color-mix(in_oklab,var(--primary)_70%,var(--foreground)_30%)]'
                        )}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn('block text-sm', n.lida ? 'font-medium' : 'font-semibold')}>{n.titulo}</span>
                      <span className="block text-xs text-muted-foreground">{n.corpo}</span>
                      <span className="tabular block text-[0.7rem] text-muted-foreground">{formatDateTime(n.criadaEm)}</span>
                    </span>
                    {!n.lida && <span aria-label="Não lida" className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary" />}
                  </>
                );
                return destino ? (
                  <Link key={n.id} href={destino} onClick={() => abrir(n)} className="flex items-start gap-3 p-4">
                    {conteudo}
                  </Link>
                ) : (
                  <button key={n.id} type="button" onClick={() => abrir(n)} className="flex w-full items-start gap-3 p-4 text-left">
                    {conteudo}
                  </button>
                );
              })}
            </div>
            {temMais && (
              <Button variant="outline" className="w-full" onClick={() => carregarPagina(filtro, pagina + 1)} disabled={carregando}>
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
