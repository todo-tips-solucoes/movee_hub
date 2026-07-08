// hub-motoristas (S5) — FASE 8, task 8.1.5: Cenário 12 (branding/dark-light,
// SC-008) das 2 telas novas do módulo de motoristas. Mesmo molde do
// Cenário 11 da S4 (cenario11-branding.spec.ts) — login inline contra o
// usuário QA sintético dedicado (empresa 9001, papel admin_entidade, único
// vínculo), tema alternado via localStorage ANTES da navegação.
import { test, expect } from '@playwright/test';

const EMAIL = process.env.HUB_E2E_ADMIN_EMAIL || 'qa.importacoes@moveelog.local';
const SENHA = process.env.HUB_E2E_SENHA || 'Teste@Hub2026';
const ENTREGADOR_ID = process.env.HUB_E2E_ENTREGADOR_ID || '305';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/hub/login');
  await page.getByLabel('Email', { exact: true }).fill(EMAIL);
  await page.getByLabel('Senha', { exact: true }).fill(SENHA);
  await page.getByRole('button', { name: 'Entrar' }).click();
  // Único vínculo (empresa 9001) -> auto-seleciona e vai direto pro dashboard;
  // se por algum motivo /selecionar-entidade aparecer, clicamos no botão.
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
  test(`Cenário 12 — lista de motoristas (${theme})`, async ({ page }) => {
    await page.addInitScript((t) => {
      window.localStorage.setItem('theme', t);
    }, theme);
    await login(page);
    await page.goto('/hub/dashboard/motoristas');
    await expect(page.locator('html')).toHaveClass(new RegExp(theme));
    await expect(page.getByRole('heading', { name: 'Motoristas' })).toBeVisible();
    await expect(page.getByText('Carregando')).toHaveCount(0, { timeout: 10_000 });
    await page.screenshot({
      path: `tests/e2e-hub-cenario12/.evidencias/cenario12-lista-${theme}.png`,
      fullPage: true,
    });
  });

  test(`Cenário 12 — detalhe de motorista (${theme})`, async ({ page }) => {
    await page.addInitScript((t) => {
      window.localStorage.setItem('theme', t);
    }, theme);
    await login(page);
    await page.goto(`/hub/dashboard/motoristas/${ENTREGADOR_ID}`);
    await expect(page.locator('html')).toHaveClass(new RegExp(theme));
    await expect(page.getByText('Carregando')).toHaveCount(0, { timeout: 10_000 });
    await page.screenshot({
      path: `tests/e2e-hub-cenario12/.evidencias/cenario12-detalhe-${theme}.png`,
      fullPage: true,
    });
  });
}
