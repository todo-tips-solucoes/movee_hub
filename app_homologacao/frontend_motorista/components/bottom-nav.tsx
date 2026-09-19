'use client';

/**
 * adiantamento-motorista (tasks.md 6.2.1) — navegação inferior fixa:
 * Início · Adiantar · Notificações (badge) · Conta.
 *
 * Ref: prototipo M01 (`navItems`); plan.md Project Structure F6. O app hoje
 * não tem menu (só a tela de movimento) — esta é a primeira navegação entre
 * telas top-level; cada tela top-level (6.2-6.6) renderiza `<BottomNav />`
 * no próprio topo de página, sem wiring global em `app/(app)/layout.tsx`
 * (reservado para 6.7 — sessão/refresh).
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { buscarNotificacoesNaoLidas } from '@/lib/adiantamento-api';
import { Home, Payments, Bell, Wallet } from '@/components/ui/icons';

const ITENS = [
  { href: '/movimento', label: 'Início', Icon: Home },
  // "Adiantar" e não "Adiantamento": a barra é uma grade de 4 colunas iguais
  // (80px num aparelho de 320px) e o rótulo longo não cabia com a fonte maior.
  // A tela de destino continua se chamando "Adiantamento" no próprio título.
  { href: '/adiantamento', label: 'Adiantar', Icon: Payments },
  { href: '/notificacoes', label: 'Notificações', Icon: Bell },
  { href: '/conta-bancaria', label: 'Conta', Icon: Wallet },
] as const;

export function BottomNav() {
  const pathname = usePathname();
  const [naoLidas, setNaoLidas] = useState(0);

  // Badge (6.2.3): busca ao montar e sempre que a rota muda (ex.: sair de
  // /notificacoes já reflete a leitura). Fail-silent — mesma técnica de
  // components/notificacoes.tsx: um badge que falha não pode travar a nav.
  useEffect(() => {
    let ativo = true;
    buscarNotificacoesNaoLidas()
      .then((r) => {
        if (ativo) setNaoLidas(r.total);
      })
      .catch(() => {
        /* fail-silent — badge é progressivo */
      });
    return () => {
      ativo = false;
    };
  }, [pathname]);

  return (
    <nav
      aria-label="Navegação do app"
      className="glass glass-nav sticky bottom-0 z-20 grid grid-cols-4 rounded-none border-x-0 border-b-0 pb-[max(0.4rem,env(safe-area-inset-bottom))] pt-1"
    >
      {ITENS.map(({ href, label, Icon }) => {
        const ativa = pathname === href || (pathname?.startsWith(`${href}/`) ?? false);
        return (
          <Link
            key={href}
            href={href}
            aria-current={ativa ? 'page' : undefined}
            className={cn(
              // Rótulo: 0.68rem (10.88px) -> 0.8rem (12.8px), os ~2px pedidos.
              // A barra é uma grade de 4 colunas iguais, então o rótulo mais
              // longo é quem manda: a coluna vale 80px num aparelho de 320px.
              // `tracking-tight` compra alguns px no rótulo longo sem mexer no
              // corpo da letra. Largura medida no DOM (ver comentário em ITENS).
              'flex min-h-11 flex-col items-center justify-center gap-0.5 py-1.5 text-[0.8rem] font-medium tracking-tight transition-colors',
              ativa ? 'text-primary' : 'text-muted-foreground'
            )}
          >
            <span className="relative">
              {/* ícone acompanha o rótulo: 20px -> 24px */}
              <Icon className="h-6 w-6" />
              {label === 'Notificações' && naoLidas > 0 && (
                <span
                  aria-label={`${naoLidas} notificações não lidas`}
                  className="absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[0.6rem] font-bold leading-none text-destructive-foreground"
                >
                  {naoLidas > 9 ? '9+' : naoLidas}
                </span>
              )}
            </span>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
