// hub-motorista-360 — FASE 8 (tasks.md 8.2): E2E dos cenários "gestor busca
// enriquecimento EntreGô" e "leitura não vê campos sensíveis" na tela de
// detalhe do motorista. Mesmo molde de playwright.config.hub-auditoria-admin.ts
// (S9): config ISOLADA, sem global-setup — loga com as contas QA persistentes
// do hub-homolog via env vars injetadas pelo driver
// infra/hub/testes/hub-motorista-360-e2e-browser.sh.
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.HUB_E2E_BASE_URL || 'https://hub-homolog.todo-tips.com:8443';

export default defineConfig({
  testDir: './tests/e2e-hub-motorista-360',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
