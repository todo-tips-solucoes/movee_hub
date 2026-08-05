// hub-uiux-refresh FASE 2 (task 2.1.5) — E2E do colapso da sidebar fixa
// (>= lg): colapsar via o botão da topbar (task 2.2.1,
// components/hub/sidebar-collapse-toggle.tsx), recarregar a página e
// confirmar que a preferência persiste (localStorage,
// lib/hub/sidebar-preference.ts, FR-003), e que o tooltip com o nome do
// módulo fica acessível tanto por foco de teclado quanto por hover quando
// colapsado (checklists/ux.md CHK001).
//
// Sessão vem de `storageState` gravado 1x em `global-setup.ts` (mesmo
// padrão dos demais specs desta suíte — evita esgotar o rate limiter de
// `/auth/login`, ver comentário em global-setup.ts).
import { test, expect } from '@playwright/test';
import { ADMIN_STATE } from './global-setup';

const NAV = 'nav[aria-label="Navegação de módulos"]';
const TOGGLE_EXPANDIDO = 'Colapsar navegação';
const TOGGLE_COLAPSADO = 'Expandir navegação';

test.describe('2.1.5 — sidebar colapsável: persistência e acessibilidade do tooltip', () => {
  test.use({ storageState: ADMIN_STATE, viewport: { width: 1280, height: 800 } });

  test('colapsar via topbar reduz a largura da sidebar fixa e persiste após recarregar', async ({
    page,
  }) => {
    await page.goto('/hub/dashboard');

    const nav = page.locator(NAV).last(); // sidebar fixa (>= lg) — última ocorrência (a primeira é o drawer mobile, oculto em lg)
    await expect(nav).toBeVisible();
    const larguraExpandida = (await nav.boundingBox())?.width ?? 0;
    expect(larguraExpandida).toBeGreaterThan(200); // w-60 = 240px

    const toggle = page.getByRole('button', { name: TOGGLE_EXPANDIDO });
    await toggle.click();

    await expect(page.getByRole('button', { name: TOGGLE_COLAPSADO })).toBeVisible();
    // A largura anima via `transition-[width] duration-200` — o botão troca
    // de rótulo antes da transição CSS terminar, então ler `boundingBox()`
    // uma única vez pode capturar um valor intermediário (achado desta
    // onda: 159px, entre 64 e 240). `expect.poll` reavalia até assentar.
    await expect
      .poll(async () => (await nav.boundingBox())?.width ?? 0, { timeout: 2_000 })
      .toBeLessThan(100); // w-16 = 64px — SC-001 (ganho de 176px)

    // Persistência (FR-003): recarrega e confirma que continua colapsada.
    await page.reload();
    await expect(page.getByRole('button', { name: TOGGLE_COLAPSADO })).toBeVisible();
    await expect
      .poll(async () => (await page.locator(NAV).last().boundingBox())?.width ?? 0, {
        timeout: 2_000,
      })
      .toBeLessThan(100);

    // Restaura o estado padrão para não vazar entre specs/execuções (a
    // preferência é global via localStorage do browser context).
    await page.getByRole('button', { name: TOGGLE_COLAPSADO }).click();
  });

  test('colapsada: tooltip com o nome do módulo aparece por foco de teclado E por hover (CHK001)', async ({
    page,
  }) => {
    await page.goto('/hub/dashboard');

    const toggle = page.getByRole('button', { name: TOGGLE_EXPANDIDO });
    await toggle.click();
    await expect(page.getByRole('button', { name: TOGGLE_COLAPSADO })).toBeVisible();

    const nav = page.locator(NAV).last();
    const primeiroItem = nav.getByRole('link').first();
    const nomeAcessivel = await primeiroItem.textContent();
    expect(nomeAcessivel?.trim().length).toBeGreaterThan(0);

    // Foco de teclado real (Tab), não `.focus()` programático: o browser só
    // marca o elemento como "focus-visible" (heurística de modalidade que o
    // Base UI Tooltip usa para decidir se abre por foco) quando o foco chega
    // via teclado — `.focus()` direto herda a modalidade "mouse" do clique
    // anterior no toggle e o tooltip nunca abre (achado desta onda, FASE 6).
    for (let tentativas = 0; tentativas < 20; tentativas += 1) {
      const focado = await primeiroItem.evaluate((el) => el === document.activeElement);
      if (focado) break;
      await page.keyboard.press('Tab');
    }
    await expect(primeiroItem).toBeFocused();
    await expect(page.getByRole('tooltip')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('tooltip')).toContainText(nomeAcessivel!.trim());

    // Restaura o estado padrão (expandido) para os specs seguintes.
    await page.getByRole('button', { name: TOGGLE_COLAPSADO }).click();
  });
});
