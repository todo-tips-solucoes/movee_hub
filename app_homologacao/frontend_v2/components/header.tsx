'use client';

import { LogOut, Send, FileCheck, Palette, Users, Truck } from 'lucide-react';
import { useAuth } from '@/contexts/auth-context';
import { useTenantTheme } from '@/contexts/tenant-theme-context';
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
  const { branding } = useTenantTheme();
  const router = useRouter();
  const pathname = usePathname();

  // White-label: marca/logo do tenant (fallback p/ identidade Movee/EnvioMassa)
  const brandName = branding?.nome_exibicao || 'Envio em Massa';
  const logoUrl = branding?.logo_url || null;

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
          {/* dec-030: logo do tenant h-8 max-w-32; fallback = logo oficial EntreGô */}
          {logoUrl ? (
            <img src={logoUrl} alt={brandName} className="h-8 max-w-32 object-contain" />
          ) : (
            <img
              src="/brand/logo-entrego-96h.png"
              srcSet="/brand/logo-entrego-48h.png 1x, /brand/logo-entrego-96h.png 2x, /brand/logo-entrego-192h.png 3x"
              alt="EntreGô"
              className="h-7 w-auto object-contain dark:brightness-0 dark:invert"
            />
          )}
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
            {/* cadastro-motorista-base-validada: CRUD da base de motoristas.
                Escopo derivado do movimento do próprio admin → visível a todos. */}
            <Link
              href="/dashboard/motoristas"
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                pathname === '/dashboard/motoristas'
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
            >
              <Truck className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Motoristas</span>
            </Link>
            {/* config-ui-tenant: visíveis só para o administrador do grupo (is_grupo_pai) */}
            {user?.is_grupo_pai && (
              <>
                <Link
                  href="/dashboard/configuracoes/aparencia"
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    pathname === '/dashboard/configuracoes/aparencia'
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                  }`}
                >
                  <Palette className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Aparência</span>
                </Link>
                <Link
                  href="/dashboard/configuracoes/grupo"
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    pathname === '/dashboard/configuracoes/grupo'
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                  }`}
                >
                  <Users className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Grupo</span>
                </Link>
              </>
            )}
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
