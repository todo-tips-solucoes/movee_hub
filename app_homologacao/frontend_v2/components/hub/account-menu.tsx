'use client';

// uiux-hub F2 — menu de conta no header do shell: as duas ações rápidas de
// sessão (perfil e sair) ficam a 1 clique de QUALQUER tela — antes o logout
// só existia dentro de /hub/dashboard/perfil. O fluxo de sair espelha o
// `sair()` do perfil: `logout()` do contexto e `router.replace('/hub/login')`
// mesmo em erro (fail-safe — a sessão local é descartada de qualquer forma).

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2, LogOut, User } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useHubAuth } from '@/contexts/hub-auth-context';

export function AccountMenu() {
  const { usuario, logout } = useHubAuth();
  const router = useRouter();
  const [saindo, setSaindo] = useState(false);

  const sair = useCallback(async () => {
    setSaindo(true);
    try {
      await logout();
    } finally {
      router.replace('/hub/login');
    }
  }, [logout, router]);

  if (!usuario) return null;

  const inicial = usuario.nome?.trim().charAt(0).toUpperCase() || '?';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Menu da conta"
        className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span
          aria-hidden="true"
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary"
        >
          {inicial}
        </span>
        <span className="hidden max-w-[160px] truncate sm:block">{usuario.nome}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel>
          <span className="block truncate text-sm font-medium text-foreground">{usuario.nome}</span>
          <span className="block truncate text-xs font-normal">{usuario.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/hub/dashboard/perfil" />}>
          <User aria-hidden="true" />
          Meu perfil
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" disabled={saindo} onClick={sair}>
          {saindo ? <Loader2 className="motion-safe:animate-spin" aria-hidden="true" /> : <LogOut aria-hidden="true" />}
          Sair
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
