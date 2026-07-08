// hub-faturamento (S6) — FASE 6/7 task 6.2.7/7.1.14: Cenário 14
// (branding/dark-light, SC-008/FR-013) da tela `/hub/dashboard/faturamento`.
// Mesmo molde do Cenário 12 da S5 (cenario12-branding.spec.ts) — login
// inline contra o usuário QA sintético dedicado (empresa 9001, papel
// admin_entidade, único vínculo), tema alternado via localStorage ANTES da
// navegação.
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
  test(`Cenário 14 — tela de faturamento (${theme})`, async ({ page }) => {
    await page.addInitScript((t) => {
      window.localStorage.setItem('theme', t);
    }, theme);
    await login(page);
    await page.goto('/hub/dashboard/faturamento');
    await expect(page.locator('html')).toHaveClass(new RegExp(theme));
    await expect(page.getByRole('heading', { name: 'Faturamento' })).toBeVisible();
    await expect(page.getByText('Carregando')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText('Total geral')).toBeVisible();
    await page.screenshot({
      path: `tests/e2e-hub-cenario14/.evidencias/cenario14-faturamento-${theme}.png`,
      fullPage: true,
    });
  });
}
