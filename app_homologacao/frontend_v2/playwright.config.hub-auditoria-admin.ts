// hub-auditoria-admin (S9) FASE 6.3 — config ISOLADA para o smoke de a11y
// das 4 telas NOVAS/evoluídas (/hub/dashboard/auditoria, /usuarios,
// /usuarios/papeis, /admin). Mesmo molde de playwright.config.hub-envio-massa.ts
// (S8) — suíte própria, sem o global-setup/contas seedadas do shell (S3);
// loga com as contas QA persistentes do hub-homolog via env vars injetadas
// pelo driver infra/hub/testes/hub-auditoria-admin-a11y-smoke.sh.
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.HUB_E2E_BASE_URL || 'https://hub-homolog.todo-tips.com:8443';

export default defineConfig({
  testDir: './tests/e2e-hub-auditoria-admin',
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
