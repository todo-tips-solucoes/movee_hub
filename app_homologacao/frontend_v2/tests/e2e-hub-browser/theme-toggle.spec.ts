// hub-uiux-refresh FASE 3 (task 3.1.3) — E2E do ThemeToggle no header do
// hub (task 3.1.1, components/theme-toggle.tsx): alternar tema, navegar
// entre telas do hub, recarregar a página e confirmar persistência
// (next-themes grava em `localStorage["theme"]`, ThemeProvider
// attribute="class" em app/layout.tsx). Confirma também que o padrão
// (`defaultTheme="dark"`, FR-008) permanece intacto para uma sessão nova
// (US2 AC1, AC2).
//
// Sessão vem de `storageState` gravado 1x em `global-setup.ts` (mesmo
// padrão dos demais specs desta suíte).
import { test, expect } from '@playwright/test';
import { ADMIN_STATE } from './global-setup';

test.describe('3.1.3 — alternar tema: navegação e persistência', () => {
  test.use({ storageState: ADMIN_STATE, viewport: { width: 1280, height: 800 } });

  test('tema padrão é escuro (FR-008); alternar, navegar e recarregar preserva a escolha', async ({
    page,
  }) => {
    await page.goto('/hub/dashboard');

    const html = page.locator('html');
    // FR-008: defaultTheme="dark" — sessão nova (sem preferência salva) abre escura.
    await expect(html).toHaveClass(/dark/);

    const toggle = page.getByRole('button', { name: 'Alternar tema' });
    await toggle.click();
    await expect(html).not.toHaveClass(/dark/);
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem('theme')))
      .toBe('light');

    // Navega para outra tela do hub — a preferência não deve resetar por SPA nav.
    await page.getByRole('link', { name: 'Ir para o painel de módulos' }).click();
    await page.waitForURL('**/hub/dashboard');
    await expect(html).not.toHaveClass(/dark/);

    // Persistência (US2 AC2): recarrega e confirma que continua clara.
    await page.reload();
    await expect(html).not.toHaveClass(/dark/);
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem('theme')))
      .toBe('light');

    // Restaura o padrão escuro para não vazar entre specs/execuções (a
    // preferência é global via localStorage do browser context).
    await page.getByRole('button', { name: 'Alternar tema' }).click();
    await expect(html).toHaveClass(/dark/);
  });
});
