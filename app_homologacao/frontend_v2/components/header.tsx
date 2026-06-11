'use client';

import { useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { LogOut, Menu, Send, FileCheck, Palette, Users, Truck } from 'lucide-react';
import { useAuth } from '@/contexts/auth-context';
import { useTenantTheme } from '@/contexts/tenant-theme-context';
import { ThemeToggle } from './theme-toggle';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** visível apenas para o administrador do grupo (config-ui-tenant) */
  grupoPai?: boolean;
};

// Fonte única dos itens de navegação — renderizada tanto no header desktop
// (horizontal) quanto no menu mobile (Sheet), aplicando o filtro is_grupo_pai.
const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Envio', icon: Send },
  { href: '/dashboard/validacao-xml', label: 'Validação XML', icon: FileCheck },
  // cadastro-motorista-base-validada: CRUD da base de motoristas (visível a todos)
  { href: '/dashboard/motoristas', label: 'Motoristas', icon: Truck },
  { href: '/dashboard/configuracoes/aparencia', label: 'Aparência', icon: Palette, grupoPai: true },
  { href: '/dashboard/configuracoes/grupo', label: 'Grupo', icon: Users, grupoPai: true },
];

export function Header() {
  const { user, logout } = useAuth();
  const { branding } = useTenantTheme();
  const router = useRouter();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

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

  // is_grupo_pai define quem vê Aparência/Grupo (5 itens vs 3)
  const navItems = NAV_ITEMS.filter(item => !item.grupoPai || user?.is_grupo_pai);

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-3 sm:px-4 md:px-6">
        <div className="flex items-center gap-2.5">
          {/* < lg: botão hambúrguer abre o menu de navegação em drawer (Sheet) */}
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-11 lg:hidden"
                  aria-label="Abrir menu"
                />
              }
            >
              <Menu className="size-5" />
            </SheetTrigger>
            <SheetContent side="left" className="w-72">
              <SheetHeader>
                <SheetTitle>{brandName}</SheetTitle>
                {user?.nome_empresa && (
                  <span className="text-sm text-muted-foreground truncate">
                    {user.nome_empresa}
                  </span>
                )}
              </SheetHeader>
              <nav className="flex flex-col gap-1 overflow-y-auto p-2">
                {navItems.map(item => {
                  const active = pathname === item.href;
                  const Icon = item.icon;
                  return (
                    <SheetClose
                      key={item.href}
                      render={<Link href={item.href} onClick={() => setMenuOpen(false)} />}
                      className={cn(
                        'flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors',
                        active
                          ? 'bg-primary/10 text-primary'
                          : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                      )}
                    >
                      <Icon className="size-5 shrink-0" />
                      <span>{item.label}</span>
                      {/* color-not-only: estado ativo também por indicador, não só cor */}
                      {active && <span className="ml-auto h-5 w-1 rounded-full bg-primary" />}
                    </SheetClose>
                  );
                })}
              </nav>
              {/* destructive-nav-separation: logout separado dos itens de navegação */}
              <SheetFooter>
                <SheetClose
                  render={
                    <Button
                      variant="ghost"
                      className="min-h-11 justify-start gap-3 text-destructive hover:text-destructive"
                      onClick={handleLogout}
                    />
                  }
                >
                  <LogOut className="size-5" />
                  Sair
                </SheetClose>
              </SheetFooter>
            </SheetContent>
          </Sheet>

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

          {/* ≥ lg: navegação horizontal com ícone + rótulo */}
          <nav className="ml-6 hidden items-center gap-1 lg:flex">
            {navItems.map(item => {
              const active = pathname === item.href;
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                    active
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
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
          {/* logout no header só no desktop; no mobile vive dentro do menu (Sheet) */}
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon" onClick={handleLogout} aria-label="Sair" className="hidden lg:flex" />}>
              <LogOut className="h-5 w-5" />
            </TooltipTrigger>
            <TooltipContent>Sair</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </header>
  );
}
