// hub-uiux-refresh FASE 1 (task 1.2.3) — leitura inicial, escrita e
// fallback sem localStorage (checklists/ux.md CHK004) do helper de
// persistência da preferência de colapso da sidebar (FR-003).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  gravarSidebarColapsada,
  lerSidebarColapsada,
  SIDEBAR_COLLAPSED_DEFAULT,
} from './sidebar-preference';

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('lerSidebarColapsada', () => {
  it('sem preferência salva: retorna o padrão (expandido)', () => {
    expect(lerSidebarColapsada()).toBe(SIDEBAR_COLLAPSED_DEFAULT);
    expect(lerSidebarColapsada()).toBe(false);
  });

  it('lê a preferência salva anteriormente', () => {
    gravarSidebarColapsada(true);
    expect(lerSidebarColapsada()).toBe(true);
    gravarSidebarColapsada(false);
    expect(lerSidebarColapsada()).toBe(false);
  });
});

describe('fallback sem localStorage disponível', () => {
  it('leitura com storage bloqueado (lança) degrada para o padrão, sem lançar', () => {
    vi.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
      throw new Error('storage bloqueado (modo privado)');
    });
    expect(() => lerSidebarColapsada()).not.toThrow();
    expect(lerSidebarColapsada()).toBe(SIDEBAR_COLLAPSED_DEFAULT);
  });

  it('escrita com storage bloqueado (lança) não propaga erro', () => {
    vi.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new Error('quota excedida');
    });
    expect(() => gravarSidebarColapsada(true)).not.toThrow();
  });
});
