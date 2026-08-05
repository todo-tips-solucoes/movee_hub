'use client';

// hub-shell (S3) task 2.2 — navegação principal do shell, 100% data-driven
// a partir de `HubAuthProvider.modulos` (GET /me). Nenhum item hardcoded
// (FR-001/SC-001): "visível" = presente no array (D2, `lib/hub/me-dto.ts`).
//
// Responsivo: reusa o padrão do header responsivo já existente no painel
// (`components/header.tsx`) — Sheet (Base UI) como drawer no mobile,
// lista vertical fixa em telas >= lg.
//
// Ref: docs/specs/hub-shell/plan.md §3.2, data-model.md §5.

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';
import { useHubAuth } from '@/contexts/hub-auth-context';
import { useSidebarCollapse } from '@/contexts/sidebar-collapse-context';
import type { HubModulo } from '@/lib/hub/me-dto';
import { moduloParaRota, resolveModuleIcon } from '@/lib/hub/module-nav';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

// Ordena por `ordem` de forma defensiva (data-model.md §2 já promete vir
// ordenado do backend, mas o componente não deve depender disso).
function ordenarModulos(modulos: HubModulo[]): HubModulo[] {
  return [...modulos].sort((a, b) => a.ordem - b.ordem);
}

const ITEM_CLASSNAME = (active: boolean, colapsada?: boolean) =>
  cn(
    'flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors duration-200 motion-reduce:transition-none',
    colapsada && 'justify-center px-0',
    active
      ? // hub-uiux-refresh FASE 6 (6.1, achado de contraste): texto na cor
        // de marca (`text-sidebar-primary`) sobre o próprio tint claro dela
        // (`bg-sidebar-primary/10`) dá 3.72:1 no tema claro — abaixo de
        // 4.5:1 (WCAG AA). `text-sidebar-foreground` já é o par de alto
        // contraste dos tokens de superfície (usado por todo o resto do
        // texto do hub) e continua respondendo a white-label indiretamente
        // (o tint de fundo e a barra lateral — `bg-sidebar-primary` abaixo
        // — seguem na cor de marca; só o texto deixou de depender dela).
        'bg-sidebar-primary/10 font-semibold text-sidebar-foreground'
      : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground'
  );

function ItemContent({
  modulo,
  active,
  colapsada,
}: {
  modulo: HubModulo;
  active: boolean;
  colapsada?: boolean;
}) {
  // `resolveModuleIcon` é uma lookup pura e determinística sobre um mapa
  // estático (lib/hub/module-nav.ts) — o mesmo `icone` sempre resolve para o
  // MESMO componente lucide-react (não "cria" nada a cada render, mesmo
  // padrão de `const Icon = item.icon` já usado em components/header.tsx).
  const Icon = resolveModuleIcon(modulo.icone, modulo.codigo);
  return (
    <>
      {/* eslint-disable-next-line react-hooks/static-components -- ver comentário acima; o lint não distingue lookup determinística de criação de componente quando o valor vem de uma chamada de função em vez de acesso direto a campo. */}
      <Icon className="size-5 shrink-0" />
      {/* colapsado (task 2.1.2): label sai do fluxo visual (`sr-only`) mas
          permanece no nome acessível — o Tooltip cobre a leitura visual. */}
      <span className={cn('truncate', colapsada && 'sr-only')}>{modulo.nome}</span>
      {active && !colapsada && (
        <span className="ml-auto h-5 w-1 rounded-full bg-sidebar-primary" />
      )}
    </>
  );
}

/** Item de navegação para a sidebar fixa (>= lg) — Link direto, sem Sheet.
 * Colapsado: envolve o Link num Tooltip (nome do módulo), acessível tanto
 * por hover quanto por foco de teclado (task 2.1.2, checklists/ux.md CHK001). */
function ItemLink({
  modulo,
  active,
  colapsada,
}: {
  modulo: HubModulo;
  active: boolean;
  colapsada: boolean;
}) {
  const content = <ItemContent modulo={modulo} active={active} colapsada={colapsada} />;

  if (!colapsada) {
    return (
      <Link
        href={moduloParaRota(modulo.codigo)}
        aria-current={active ? 'page' : undefined}
        className={ITEM_CLASSNAME(active)}
      >
        {content}
      </Link>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            href={moduloParaRota(modulo.codigo)}
            aria-current={active ? 'page' : undefined}
            className={ITEM_CLASSNAME(active, colapsada)}
          />
        }
      >
        {content}
      </TooltipTrigger>
      <TooltipContent side="right">{modulo.nome}</TooltipContent>
    </Tooltip>
  );
}

/** Lista de módulos do usuário logado, já ordenada e pronta para render. */
export function useModuleNavItems(): HubModulo[] {
  const { modulos } = useHubAuth();
  return ordenarModulos(modulos);
}

export function ModuleNav() {
  const items = useModuleNavItems();
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Colapso é exclusivo da sidebar fixa (>= lg) — o drawer mobile abaixo
  // não lê `colapsada` em lugar nenhum, preservando o comportamento
  // idêntico exigido pela FR-005/task 2.1.4.
  const { colapsada } = useSidebarCollapse();

  if (items.length === 0) return null;

  return (
    <>
      {/* < lg: drawer (Sheet) acionado por hambúrguer — mesmo padrão do header */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="size-11 lg:hidden"
              aria-label="Abrir menu de módulos"
            />
          }
        >
          <Menu className="size-5" />
        </SheetTrigger>
        <SheetContent side="left" className="w-72 bg-sidebar text-sidebar-foreground">
          <SheetHeader>
            <SheetTitle>Módulos</SheetTitle>
          </SheetHeader>
          <nav aria-label="Navegação de módulos" className="flex flex-col gap-1 overflow-y-auto p-2">
            {items.map((modulo) => {
              const active = pathname === moduloParaRota(modulo.codigo);
              return (
                <SheetClose
                  key={modulo.codigo}
                  render={
                    <Link
                      href={moduloParaRota(modulo.codigo)}
                      onClick={() => setDrawerOpen(false)}
                      aria-current={active ? 'page' : undefined}
                    />
                  }
                  className={ITEM_CLASSNAME(active)}
                >
                  <ItemContent modulo={modulo} active={active} />
                </SheetClose>
              );
            })}
          </nav>
        </SheetContent>
      </Sheet>

      {/* >= lg: sidebar fixa vertical. `self-start` + altura própria são o que
          fazem o sticky valer: como item de flex esticado ela teria a altura do
          conteúdo inteiro e rolaria junto com a página (os módulos do topo
          sumiam ao descer). `top`/altura descontam o EnvBadge (ver env-badge). */}
      <nav
        aria-label="Navegação de módulos"
        className={cn(
          'hidden shrink-0 flex-col gap-1 border-r border-sidebar-border bg-sidebar p-2 text-sidebar-foreground transition-[width] duration-200 motion-reduce:transition-none lg:sticky lg:top-[var(--env-badge-h,0px)] lg:flex lg:h-[calc(100svh-var(--env-badge-h,0px))] lg:self-start lg:overflow-y-auto',
          colapsada ? 'w-16' : 'w-60'
        )}
      >
        {items.map((modulo) => (
          <ItemLink
            key={modulo.codigo}
            modulo={modulo}
            active={pathname === moduloParaRota(modulo.codigo)}
            colapsada={colapsada}
          />
        ))}
      </nav>
    </>
  );
}
