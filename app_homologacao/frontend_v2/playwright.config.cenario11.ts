// hub-importacoes (S4) — FASE 7, task 7.2 (Cenário 11, SC-007/CHK006):
// config Playwright ISOLADA e dedicada a esta captura de evidência de
// branding dark/light — não reusa playwright.config.hub.ts (S3) porque este
// spec faz seu próprio login inline (sem globalSetup/storageState
// compartilhado) para não depender das contas admin/operador daquela suíte.
//
// baseURL aponta para o domínio público do ambiente ISOLADO hub-homolog
// (nunca produção). `ignoreHTTPSErrors: true` porque o TLS é self-signed.
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.HUB_E2E_BASE_URL || 'https://hub-homolog.todo-tips.com:8443';

export default defineConfig({
  testDir: './tests/e2e-hub-cenario11',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
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
