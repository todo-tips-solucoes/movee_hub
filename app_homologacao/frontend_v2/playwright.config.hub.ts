// hub-shell (S3) — FASE 6 (E2E browser). Config ISOLADA do que a S8+ possa
// vir a criar para o painel legado (playwright.config.ts) — este arquivo
// tem sufixo `.hub` de propósito (dec dessa onda) e só é usado pelo driver
// `infra/hub/testes/hub-shell-e2e-browser.sh`, dentro do container oficial
// `mcr.microsoft.com/playwright` (nunca instalado via apt no host — ver
// docs/specs/hub-shell/e2e-plan.md §4).
//
// baseURL aponta para o domínio público do ambiente ISOLADO hub-homolog
// (nunca produção). `ignoreHTTPSErrors: true` porque o TLS é self-signed
// (gen-secrets.sh, infra/hub/RUNBOOK.md §TLS).
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.HUB_E2E_BASE_URL || 'https://hub-homolog.todo-tips.com:8443';

export default defineConfig({
  testDir: './tests/e2e-hub-browser',
  // 1 login por papel (admin/operador), storageState reusado pelos specs —
  // ver comentário em global-setup.ts (evita esgotar o rate limiter de
  // /auth/login, que é IP+email, compartilhado por toda a suíte).
  globalSetup: './tests/e2e-hub-browser/global-setup.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // contas seedadas são compartilhadas entre specs — evita corrida
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'tests/e2e-hub-browser/.report.json' }]],
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
