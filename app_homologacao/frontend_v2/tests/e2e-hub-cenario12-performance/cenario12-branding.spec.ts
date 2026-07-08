// hub-performance (S7) — FASE 6 task 6.1.12: Cenário 12 (identidade visual
// claro/escuro/branding, SC-008) da tela `/hub/dashboard/performance`. Mesmo
// molde do Cenário 14 de hub-faturamento (S6) / Cenário 12 da S5 — login
// inline contra o usuário QA sintético já existente (empresa 9001, papel
// admin_entidade), tema alternado via localStorage ANTES da navegação.
import { test, expect } from '@playwright/test';

const EMAIL = process.env.HUB_E2E_ADMIN_EMAIL || 'qa.importacoes@moveelog.local';
const SENHA = process.env.HUB_E2E_SENHA || 'Teste@Hub2026';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/hub/login');
  await page.getByLabel('Email', { exact: true }).fill(EMAIL);
  await page.getByLabel('Senha', { exact: true }).fill(SENHA);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await Promise.race([
    page.waitForURL('**/hub/dashboard', { timeout: 30_000 }),
    page.waitForURL('**/selecionar-entidade', { timeout: 30_000 }),
  ]).catch(() => {});
  const botaoEntidade = page.getByRole('button', { name: /^Empresa #/ }).first();
  if (await botaoEntidade.isVisible().catch(() => false)) {
    await botaoEntidade.click();
  }
  await page.waitForURL('**/hub/dashboard', { timeout: 30_000 });
}

for (const theme of ['light', 'dark'] as const) {
  test(`Cenário 12 — tela de performance (${theme})`, async ({ page }) => {
    await page.addInitScript((t) => {
      window.localStorage.setItem('theme', t);
    }, theme);
    await login(page);
    await page.goto('/hub/dashboard/performance');
    await expect(page.locator('html')).toHaveClass(new RegExp(theme));
    await expect(page.getByRole('heading', { name: 'Performance' })).toBeVisible();
    await expect(page.getByText('Carregando performance')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText('Taxa de aceitação')).toBeVisible();
    await page.screenshot({
      path: `tests/e2e-hub-cenario12-performance/.evidencias/cenario12-performance-${theme}.png`,
      fullPage: true,
    });
  });
}
