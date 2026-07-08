// hub-motoristas (S5) — FASE 8, task 8.1.5: config Playwright ISOLADA e
// dedicada à captura de evidência de branding dark/light das telas novas de
// motoristas (Cenário 12 do quickstart.md). Mesmo molde de
// playwright.config.cenario11.ts (S4) — spec faz login inline, não reusa
// storageState/globalSetup de playwright.config.hub.ts.
//
// baseURL aponta para o domínio público do ambiente ISOLADO hub-homolog
// (nunca produção). `ignoreHTTPSErrors: true` porque o TLS é self-signed.
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.HUB_E2E_BASE_URL || 'https://hub-homolog.todo-tips.com:8443';

export default defineConfig({
  testDir: './tests/e2e-hub-cenario12',
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
