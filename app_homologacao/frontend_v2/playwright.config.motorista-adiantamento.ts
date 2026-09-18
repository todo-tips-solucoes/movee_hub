// adiantamento-motorista — tasks.md 6.9 ("Driver Playwright no container
// oficial cobrindo US1/US2/US7 ponta a ponta") e 6.8.3 (axe-core/contraste).
//
// Mesmo padrão de playwright.config.motorista-push.ts (dec-107): specs em
// ./tests/e2e-motorista-adiantamento vivem aqui só para reusar
// @playwright/test + @axe-core/playwright, já instalados neste projeto. O
// app testado (frontend_motorista, next start -p 3006) roda como outro
// processo Next.js no MESMO container — Playwright fala com ele via
// baseURL HTTP, sem acoplamento de código entre os dois projetos.
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.MOTORISTA_E2E_BASE_URL || 'http://127.0.0.1:3006';

export default defineConfig({
  testDir: './tests/e2e-motorista-adiantamento',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL,
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
