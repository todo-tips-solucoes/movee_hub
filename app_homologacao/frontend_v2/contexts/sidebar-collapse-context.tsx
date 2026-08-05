'use client';

// hub-uiux-refresh FASE 2 (task 2.1.1) — estado de colapso da sidebar
// compartilhado entre `ModuleNav` (sidebar fixa, components/hub/module-nav.tsx)
// e o botão de colapso da topbar (components/hub/sidebar-collapse-toggle.tsx),
// ambos client components irmãos sob `app/hub/dashboard/layout.tsx`.
// Persistência via `lib/hub/sidebar-preference.ts` (FR-003).
//
// Sem Provider/Context: um store externo module-level lido via
// `useSyncExternalStore`, o hook do React feito exatamente para isto —
// sincronizar componentes com um valor externo mutável (aqui, localStorage
// + uma variável de módulo compartilhada) sem os riscos de mismatch de
// hidratação SSR/CSR que `useState` + `useEffect` teriam (é também o que
// resolve o next-themes por trás dos panos). `getServerSnapshot` sempre
// retorna o padrão (expandido); no cliente, `colapsadaAtual` já reflete o
// localStorage desde a carga do módulo — sem efeito extra, sem cascata de
// re-render.
import { useSyncExternalStore } from 'react';
import {
  gravarSidebarColapsada,
  lerSidebarColapsada,
  SIDEBAR_COLLAPSED_DEFAULT,
} from '@/lib/hub/sidebar-preference';

const listeners = new Set<() => void>();

let colapsadaAtual: boolean =
  typeof window === 'undefined' ? SIDEBAR_COLLAPSED_DEFAULT : lerSidebarColapsada();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
  return colapsadaAtual;
}

function getServerSnapshot(): boolean {
  return SIDEBAR_COLLAPSED_DEFAULT;
}

export function alternarSidebarColapsada(): void {
  colapsadaAtual = !colapsadaAtual;
  gravarSidebarColapsada(colapsadaAtual);
  listeners.forEach((listener) => listener());
}

export function useSidebarCollapse(): { colapsada: boolean; alternar: () => void } {
  const colapsada = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { colapsada, alternar: alternarSidebarColapsada };
}
