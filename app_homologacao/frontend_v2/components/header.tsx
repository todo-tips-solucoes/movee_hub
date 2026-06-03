'use client';

import { LogOut, Send, FileCheck } from 'lucide-react';
import { useAuth } from '@/contexts/auth-context';
import { ThemeToggle } from './theme-toggle';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';

export function Header() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  const handleLogout = async () => {
    try {
      await logout();
      router.push('/login');
    } catch {
      toast.error('Erro ao sair');
    }
  };

  const initials = user?.nome_empresa
    ? user.nome_empresa.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()
    : '';

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-3 sm:px-4 md:px-6">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
            <Send className="h-4 w-4 text-primary-foreground" />
          </div>
          <span className="font-semibold text-lg">Envio em Massa</span>
          <nav className="ml-6 flex items-center gap-1">
            <Link
              href="/dashboard"
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                pathname === '/dashboard'
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
            >
              <Send className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Envio</span>
            </Link>
            <Link
              href="/dashboard/validacao-xml"
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                pathname === '/dashboard/validacao-xml'
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
            >
              <FileCheck className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Validacao XML</span>
            </Link>
          </nav>
        </div>

        <div className="flex items-center gap-2">
          {user && (
            <Tooltip>
              <TooltipTrigger render={<div className="flex items-center gap-2 rounded-full bg-muted px-3 py-1.5 cursor-default" />}>
                <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                  {initials}
                </div>
                <span className="text-sm font-medium hidden sm:inline max-w-[150px] truncate">
                  {user.nome_empresa}
                </span>
              </TooltipTrigger>
              <TooltipContent>{user.nome_empresa}</TooltipContent>
            </Tooltip>
          )}
          <ThemeToggle />
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon" onClick={handleLogout} aria-label="Sair" />}>
              <LogOut className="h-5 w-5" />
            </TooltipTrigger>
            <TooltipContent>Sair</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </header>
  );
}
