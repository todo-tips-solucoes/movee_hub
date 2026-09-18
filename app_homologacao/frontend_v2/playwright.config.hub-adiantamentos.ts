// adiantamento-motorista — tasks.md 7.10 ("Driver Playwright no container
// oficial cobrindo US3/US4/US5/US6 ponta a ponta").
//
// Mesmo padrão "sem stack" de playwright.config.motorista-adiantamento.ts
// (dec-107): mas aqui o alvo É o próprio frontend_v2 — não há segundo
// projeto para montar. `next build && next start` roda dentro do MESMO
// container oficial do Playwright, numa porta isolada; nenhum node_modules/
// package.json é alterado por este spec. Todo `/api/**` do browser é
// stubado via page.route (installApiStubs, adiantamentos.spec.ts) — o
// backend real (hub-homolog) nunca é exercitado por esta suíte (isso já é
// coberto por infra/hub/testes/hub-adiantamentos-integration.sh).
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.HUB_ADIANTAMENTOS_E2E_BASE_URL || 'http://127.0.0.1:3020';

export default defineConfig({
  testDir: './tests/e2e-hub-adiantamentos',
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
