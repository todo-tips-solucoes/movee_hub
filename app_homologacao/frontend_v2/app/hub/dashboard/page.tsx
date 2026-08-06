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
import {
  DEFAULT_MODULE_ICON,
  moduloParaRota,
  resolveModuleDescription,
  resolveModuleIcon,
} from '@/lib/hub/module-nav';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';

// Mesmo critério defensivo do ModuleNav (lib/hub/module-nav.ts): o backend já
// promete vir ordenado por `ordem`, mas o componente não depende disso.
function ordenarModulos(modulos: HubModulo[]): HubModulo[] {
  return [...modulos].sort((a, b) => a.ordem - b.ordem);
}

/** Lógica isolada do JSX — mesmo padrão de `useModuleNavItems`/`usePerfil`. */
export function useDashboardModulos() {
  const { modulos, usuario, carregando, entidades, entidadeAtiva } = useHubAuth();
  // impeccable rodada 3: o estado vazio dizia só "fale com um administrador",
  // sem dizer DE ONDE o acesso falta — e o acesso é por entidade. Desde a
  // rodada 2 o `/me` traz o nome, então dá para nomear a entidade em vez de
  // inventar um contato que o produto não conhece.
  const entidade = entidades.find((e) => e.empresaId === entidadeAtiva) ?? null;
  const entidadeLabel =
    entidade?.nome ?? (entidadeAtiva !== null ? `Empresa #${entidadeAtiva}` : null);
  return { modulos: ordenarModulos(modulos), usuario, carregando, entidadeLabel };
}

function ModuloCard({ modulo }: { modulo: HubModulo }) {
  // Lookup pura e determinística (mesmo comentário/justificativa de
  // components/hub/module-nav.tsx sobre o lint react-hooks/static-components).
  const Icon = resolveModuleIcon(modulo.icone, modulo.codigo);
  // impeccable rodada 3 (h10 "Ajuda e documentação" 1/4): o card só dizia o
  // NOME do módulo — quem entra convidado pela primeira vez não tinha como
  // saber o que cada um faz sem clicar nos nove. Módulo sem descrição no mapa
  // renderiza exatamente como antes, sem buraco no layout.
  const descricao = resolveModuleDescription(modulo.codigo);
  return (
    <Link
      href={moduloParaRota(modulo.codigo)}
      className="group block cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <Card className="h-full transition-shadow group-hover:bg-muted/50 group-hover:shadow-md">
        <CardHeader className="flex flex-row items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            {/* eslint-disable-next-line react-hooks/static-components -- lookup determinística, não criação de componente (mesmo padrão de module-nav.tsx) */}
            <Icon className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <CardTitle as="h2" className="truncate text-base">
              {modulo.nome}
            </CardTitle>
            {descricao && (
              <p className="mt-1 text-sm leading-snug text-muted-foreground">{descricao}</p>
            )}
          </div>
          <ChevronRight
            className="mt-2.5 size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-primary"
            aria-hidden="true"
          />
        </CardHeader>
      </Card>
    </Link>
  );
}

// Skeleton com o mesmo shape dos cards (impeccable harden 2026-08-06):
// enquanto o `/me` está em voo, `modulos` ainda é `[]` — sem este estado, o
// EstadoVazio ("nenhum módulo") aparecia por engano na primeira carga.
function EstadoCarregando() {
  return (
    <div role="status" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <span className="sr-only">Carregando módulos...</span>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} aria-hidden="true" className="rounded-xl border bg-card p-6">
          <div className="flex items-start gap-3">
            <div className="size-11 shrink-0 animate-pulse rounded-lg bg-muted" />
            <div className="min-w-0 flex-1">
              <div className="h-4 w-32 animate-pulse rounded bg-muted" />
              {/* A linha de descrição também entra no skeleton — sem ela, os
                  cards saltavam de altura quando o /me assentava. */}
              <div className="mt-2 h-3 w-full animate-pulse rounded bg-muted" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function EstadoVazio({ entidadeLabel }: { entidadeLabel: string | null }) {
  const Icon = DEFAULT_MODULE_ICON;
  return (
    <div
      role="status"
      className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card/40 p-10 text-center sm:p-14"
    >
      <span className="flex size-14 items-center justify-center rounded-full bg-muted">
        <Icon className="size-7 text-muted-foreground" aria-hidden="true" />
      </span>
      <div className="flex max-w-md flex-col gap-2">
        <p className="text-sm font-medium text-foreground">
          {entidadeLabel
            ? `Sua conta ainda não tem módulos liberados em ${entidadeLabel}.`
            : 'Sua conta ainda não tem módulos liberados.'}
        </p>
        {/* Nomeia a AÇÃO que destrava, em vez de mandar "falar com um
            administrador" sem dizer quem nem o quê (critique #2, persona do
            recém-convidado). O produto não conhece o contato do admin da
            entidade — inventar um seria pior que não ter. */}
        <p className="text-sm text-muted-foreground">
          O acesso é concedido por módulo e por entidade. Peça a quem administra
          {entidadeLabel ? ` ${entidadeLabel}` : ' sua entidade'} para liberar os módulos que você
          precisa usar — o acesso vale na hora, sem precisar entrar de novo.
        </p>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { modulos, usuario, carregando, entidadeLabel } = useDashboardModulos();

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <div>
        <h1 className="font-heading text-xl font-semibold text-foreground sm:text-2xl">
          {usuario ? `Olá, ${usuario.nome}` : 'Painel'}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {entidadeLabel
            ? `Você está operando ${entidadeLabel}. Escolha um módulo para começar.`
            : 'Escolha um módulo para começar.'}
        </p>
      </div>

      {carregando ? (
        <EstadoCarregando />
      ) : modulos.length === 0 ? (
        <EstadoVazio entidadeLabel={entidadeLabel} />
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
