// hub-uiux-refresh FASE 2 (task 2.1.1) — store externo (useSyncExternalStore)
// que compartilha o colapso da sidebar entre `ModuleNav` e o botão da topbar.
// Cobre: leitura inicial do localStorage numa "nova sessão de página"
// (módulo fresco — `vi.resetModules()`, já que `colapsadaAtual` é lido do
// localStorage 1x na carga do módulo, não a cada render), sincronização
// entre múltiplas instâncias do hook na MESMA sessão (2 componentes
// independentes, ModuleNav + toggle) e persistência via
// `lib/hub/sidebar-preference.ts` através de recarregamentos simulados.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gravarSidebarColapsada } from '@/lib/hub/sidebar-preference';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('useSidebarCollapse', () => {
  it('primeira carga do módulo (nova sessão de página) lê o valor persistido em localStorage', async () => {
    gravarSidebarColapsada(true);

    const { useSidebarCollapse } = await import('./sidebar-collapse-context');
    const { result } = renderHook(() => useSidebarCollapse());

    expect(result.current.colapsada).toBe(true);
  });

  it('alternar() sincroniza TODAS as instâncias do hook na mesma sessão (ModuleNav + toggle da topbar)', async () => {
    const { useSidebarCollapse } = await import('./sidebar-collapse-context');
    const a = renderHook(() => useSidebarCollapse());
    const b = renderHook(() => useSidebarCollapse());

    expect(a.result.current.colapsada).toBe(false);
    expect(b.result.current.colapsada).toBe(false);

    act(() => {
      a.result.current.alternar();
    });

    expect(a.result.current.colapsada).toBe(true);
    expect(b.result.current.colapsada).toBe(true);
  });

  it('alternar() persiste — uma nova sessão de página (novo módulo) lê o valor já colapsado', async () => {
    const mod1 = await import('./sidebar-collapse-context');
    const first = renderHook(() => mod1.useSidebarCollapse());
    act(() => {
      first.result.current.alternar();
    });

    vi.resetModules();
    const mod2 = await import('./sidebar-collapse-context');
    const second = renderHook(() => mod2.useSidebarCollapse());
    expect(second.result.current.colapsada).toBe(true);
  });
});
