// hub-faturamento (S6) — FASE 6/7 task 6.2.7/7.1.14: config Playwright
// ISOLADA e dedicada à captura de evidência de branding dark/light da tela
// `/hub/dashboard/faturamento` (Cenário 14 do quickstart.md). Mesmo molde de
// `playwright.config.cenario12.ts` (S5) — spec faz login inline, não reusa
// storageState/globalSetup de playwright.config.hub.ts.
//
// baseURL aponta para o domínio público do ambiente ISOLADO hub-homolog
// (nunca produção). `ignoreHTTPSErrors: true` porque o TLS é self-signed.
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.HUB_E2E_BASE_URL || 'https://hub-homolog.todo-tips.com:8443';

export default defineConfig({
  testDir: './tests/e2e-hub-cenario14',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL,
    ignoreHTTPSErrors: true,
    trace: 'off',
    screenshot: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
