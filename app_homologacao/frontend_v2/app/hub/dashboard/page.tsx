'use client';

// hub-shell (S3) task 5.1 — `/hub/dashboard`: cards por módulo habilitado
// (FR-009), um por entrada de `me.modulos` (mesma fonte de verdade do
// `ModuleNav`, task 2.2 — "presença no array = visível", D2). Cada card leva
// à rota do módulo via `moduloParaRota` (mesmo mapeamento usado pelo nav).
//
// Estado vazio (FR-010): `modulos.length === 0` nunca é uma tela em branco —
// mensagem explícita, mesmo tom do texto de "sem acesso" da tela
// `/selecionar-entidade` (task 3.2).
//
// Ref: docs/specs/hub-shell/plan.md §3.4, spec.md US4/FR-009/FR-010.

import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { useHubAuth } from '@/contexts/hub-auth-context';
import type { HubModulo } from '@/lib/hub/me-dto';
import { DEFAULT_MODULE_ICON, moduloParaRota, resolveModuleIcon } from '@/lib/hub/module-nav';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';

// Mesmo critério defensivo do ModuleNav (lib/hub/module-nav.ts): o backend já
// promete vir ordenado por `ordem`, mas o componente não depende disso.
function ordenarModulos(modulos: HubModulo[]): HubModulo[] {
  return [...modulos].sort((a, b) => a.ordem - b.ordem);
}

/** Lógica isolada do JSX — mesmo padrão de `useModuleNavItems`/`usePerfil`. */
export function useDashboardModulos() {
  const { modulos, usuario } = useHubAuth();
  return { modulos: ordenarModulos(modulos), usuario };
}

function ModuloCard({ modulo }: { modulo: HubModulo }) {
  // Lookup pura e determinística (mesmo comentário/justificativa de
  // components/hub/module-nav.tsx sobre o lint react-hooks/static-components).
  const Icon = resolveModuleIcon(modulo.icone, modulo.codigo);
  return (
    <Link
      href={moduloParaRota(modulo.codigo)}
      className="group block cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <Card className="h-full transition-shadow group-hover:bg-muted/50 group-hover:shadow-md">
        <CardHeader className="flex flex-row items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            {/* eslint-disable-next-line react-hooks/static-components -- lookup determinística, não criação de componente (mesmo padrão de module-nav.tsx) */}
            <Icon className="size-5" aria-hidden="true" />
          </span>
          <CardTitle as="h2" className="min-w-0 flex-1 truncate text-base">
            {modulo.nome}
          </CardTitle>
          <ChevronRight
            className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-primary"
            aria-hidden="true"
          />
        </CardHeader>
      </Card>
    </Link>
  );
}

function EstadoVazio() {
  const Icon = DEFAULT_MODULE_ICON;
  return (
    <div
      role="status"
      className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card/40 p-10 text-center sm:p-14"
    >
      <span className="flex size-14 items-center justify-center rounded-full bg-muted">
        <Icon className="size-7 text-muted-foreground" aria-hidden="true" />
      </span>
      <p className="max-w-sm text-sm text-muted-foreground">
        Nenhum módulo disponível para sua conta no momento. Fale com um administrador para
        solicitar acesso a um módulo.
      </p>
    </div>
  );
}

export default function DashboardPage() {
  const { modulos, usuario } = useDashboardModulos();

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <div>
        <h1 className="font-heading text-xl font-semibold text-foreground sm:text-2xl">
          {usuario ? `Olá, ${usuario.nome}` : 'Painel'}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">Selecione um módulo para começar.</p>
      </div>

      {modulos.length === 0 ? (
        <EstadoVazio />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {modulos.map((modulo) => (
            <ModuloCard key={modulo.codigo} modulo={modulo} />
          ))}
        </div>
      )}
    </div>
  );
}
