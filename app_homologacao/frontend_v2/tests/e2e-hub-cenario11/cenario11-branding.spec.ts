// hub-importacoes (S4) — FASE 7, task 7.2: Cenário 11 (branding/dark-light,
// SC-007). Resolve CHK006 (nenhum dos 10 cenários originais do quickstart
// testava tema/branding explicitamente nas telas novas de importações).
//
// Login inline (sem storageState compartilhado) contra 1 usuário sintético
// dedicado (`e2e-teste-branding-admin-*`, empresa 950201, papel
// admin_entidade, único vínculo) seedado por
// /root/.claude/jobs/9eb48a85/tmp/seed-cenario11.sh antes desta execução.
//
// Tema: `next-themes` (attribute="class", defaultTheme="dark", sem toggle
// dentro do shell do hub) — alternado via localStorage (`theme`, storageKey
// padrão da lib) ANTES da navegação (`addInitScript`), não por clique de UI.
import { test, expect } from '@playwright/test';

const EMAIL = process.env.HUB_E2E_ADMIN_EMAIL;
const SENHA = process.env.HUB_E2E_SENHA;
const IMPORT_ID = process.env.HUB_E2E_IMPORT_ID;

if (!EMAIL || !SENHA || !IMPORT_ID) {
  throw new Error(
    'HUB_E2E_ADMIN_EMAIL/HUB_E2E_SENHA/HUB_E2E_IMPORT_ID ausentes — rodar via driver do Cenário 11.'
  );
}

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/hub/login');
  await page.getByLabel('Email', { exact: true }).fill(EMAIL!);
  await page.getByLabel('Senha', { exact: true }).fill(SENHA!);
  await page.getByRole('button', { name: 'Entrar' }).click();
  // Pós-login sempre encaminha a /selecionar-entidade (app/hub/login/page.tsx,
  // padrão da suíte S3 tests/e2e-hub-browser/helpers.ts). Vínculo único
  // auto-seleciona; se por algum motivo o botão de entidade estiver visível,
  // clicamos nele (robustez — mesma técnica de global-setup.ts).
  await page.waitForURL('**/selecionar-entidade', { timeout: 15_000 });
  const botaoEntidade = page.getByRole('button', { name: /^Empresa #/ }).first();
  if (await botaoEntidade.isVisible().catch(() => false)) {
    await botaoEntidade.click();
  }
  await page.waitForURL('**/hub/dashboard', { timeout: 15_000 });
}

for (const theme of ['light', 'dark'] as const) {
  test(`Cenário 11 — lista de importações (${theme})`, async ({ page }) => {
    await page.addInitScript((t) => {
      window.localStorage.setItem('theme', t);
    }, theme);
    await login(page);
    await page.goto('/hub/dashboard/importacoes');
    await expect(page.locator('html')).toHaveClass(new RegExp(theme));
    // A tela de importações faz polling (use-importacao-polling) — a rede
    // NUNCA fica idle, então `networkidle` estoura o timeout. Esperamos o
    // heading concreto renderizar (prática correta p/ páginas com polling).
    await expect(page.getByRole('heading', { name: 'Importações' })).toBeVisible();
    // O heading renderiza ANTES da tabela (h.carregando ainda true no 1º
    // paint) — sem esperar o spinner "Carregando importações..." sumir, a
    // screenshot corre risco de capturar o estado de loading em vez da
    // tabela populada (raça observada na 1ª captura).
    await expect(page.getByText('Carregando importações...')).toHaveCount(0, { timeout: 10_000 });
    await page.screenshot({
      path: `tests/e2e-hub-cenario11/.evidencias/cenario11-lista-${theme}.png`,
      fullPage: true,
    });
  });

  test(`Cenário 11 — detalhe de importação (${theme})`, async ({ page }) => {
    await page.addInitScript((t) => {
      window.localStorage.setItem('theme', t);
    }, theme);
    await login(page);
    await page.goto(`/hub/dashboard/importacoes/${IMPORT_ID}`);
    await expect(page.locator('html')).toHaveClass(new RegExp(theme));
    // Detalhe faz polling (useImportacaoPolling) — networkidle nunca resolve.
    // Espera o heading da importação ("Importação #<id> — <tipo>") renderizar.
    await expect(page.getByRole('heading', { name: /^Importação #/ })).toBeVisible();
    await page.screenshot({
      path: `tests/e2e-hub-cenario11/.evidencias/cenario11-detalhe-${theme}.png`,
      fullPage: true,
    });
  });
}
