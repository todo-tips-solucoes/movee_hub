// hub-uiux-refresh FASE 1 (task 1.2) — persistência da preferência de
// colapso da sidebar do hub (FR-003). Mesmo padrão fail-safe já usado em
// `app/hub/dashboard/admin/page.tsx` (lerHistorico/gravarHistorico) e o
// mesmo mecanismo de storage do `next-themes` (chave simples em
// localStorage, sem SSR): qualquer erro (modo privado, quota, storage
// bloqueado) degrada para o padrão expandido, sem lançar (checklists/ux.md
// CHK004).

const SIDEBAR_COLLAPSED_KEY = 'hub_sidebar_colapsada';

/** Padrão quando não há preferência salva ou o storage está indisponível. */
export const SIDEBAR_COLLAPSED_DEFAULT = false;

export function lerSidebarColapsada(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
  } catch {
    return SIDEBAR_COLLAPSED_DEFAULT;
  }
}

export function gravarSidebarColapsada(colapsada: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, colapsada ? 'true' : 'false');
  } catch {
    // storage indisponível — preferência só dura a sessão de página atual
  }
}
