// hub-avisos — tasks.md FASE 9.4.1: E2E real de
// /hub/dashboard/avisos + /hub/dashboard/avisos/[id] (push-motorista).
// Mesmo molde ENXUTO de playwright.config.hub-motorista-360.ts: config
// isolada, sem global-setup. Roda via infra/hub/testes/hub-avisos-e2e-browser.sh
// contra o stack efêmero hub-test-<runid> (compose.hub.test.yml): o próprio
// `next build && next start` sobe DENTRO do mesmo container oficial do
// Playwright (bind mount do host, sem `npm install`/Dockerfile extra —
// BACKEND_URL/HUB_BACKEND_URL são lidos em runtime pelo proxy, nunca
// inlinados), então frontend e Playwright falam por localhost; só o
// `backend` é outro container, alcançado pelo nome de serviço na rede do
// projeto (`docker run --network <project>_default`). SEM TLS (APP_ENV=dev
// -> cookies não-secure), por isso baseURL é http://127.0.0.1.
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.HUB_E2E_BASE_URL || 'http://127.0.0.1:3005';

export default defineConfig({
  testDir: './tests/e2e-hub-avisos',
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
