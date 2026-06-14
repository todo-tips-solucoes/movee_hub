'use client';

import { Fragment } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight } from 'lucide-react';

/**
 * Trilha de navegação (breadcrumb) do shell do dashboard — orientação em
 * subrotas (U009). Só apresentação: deriva os rótulos da rota atual; não toca
 * lógica/dados. As configurações têm 3 níveis (Painel › Configurações › X).
 */
const ROUTE_LABELS: Record<string, string> = {
  '/dashboard': 'Envio',
  '/dashboard/validacao-xml': 'Validação XML',
  '/dashboard/motoristas': 'Motoristas',
  '/dashboard/configuracoes/aparencia': 'Aparência',
  '/dashboard/configuracoes/grupo': 'Grupo',
};

type Crumb = { label: string; href?: string };

export function PageBreadcrumb() {
  const pathname = usePathname();
  const label = ROUTE_LABELS[pathname];
  const isConfig = pathname.startsWith('/dashboard/configuracoes');

  const crumbs: Crumb[] = [{ label: 'Painel', href: '/dashboard' }];
  if (isConfig) crumbs.push({ label: 'Configurações' });
  if (pathname !== '/dashboard' && label) crumbs.push({ label });

  return (
    <nav aria-label="Trilha de navegação" className="mb-3 text-sm">
      <ol className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <Fragment key={`${crumb.label}-${i}`}>
              <li className="flex items-center">
                {isLast || !crumb.href ? (
                  <span
                    className={isLast ? 'font-medium text-foreground' : undefined}
                    aria-current={isLast ? 'page' : undefined}
                  >
                    {crumb.label}
                  </span>
                ) : (
                  <Link href={crumb.href} className="transition-colors hover:text-foreground">
                    {crumb.label}
                  </Link>
                )}
              </li>
              {!isLast && (
                <li aria-hidden="true" className="flex items-center">
                  <ChevronRight className="h-3.5 w-3.5" />
                </li>
              )}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
