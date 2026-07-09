// hub-envio-massa (S8) FASE 5.2 — config ISOLADA para o smoke de a11y da
// montagem /hub/dashboard/envio_massa (tests/e2e-hub-envio-massa/). Separada
// de playwright.config.hub.ts (S3) de propósito: esta suíte não usa o
// global-setup/contas seedadas do shell — loga com a conta QA persistente do
// hub-homolog via env vars injetadas pelo driver
// infra/hub/testes/hub-envio-massa-a11y-smoke.sh.
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.HUB_E2E_BASE_URL || 'https://hub-homolog.todo-tips.com:8443';

export default defineConfig({
  testDir: './tests/e2e-hub-envio-massa',
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
