// adiantamento-motorista — frente "Categorias: modo Todas, exceto as marcadas" (W4).
// Roda via infra/hub/testes/hub-adiantamentos-categorias-e2e-browser.sh contra o stack EFÊMERO
// hub-test-<runid> (backend + PostgREST + banco REAIS; nenhum stub de rede). O driver mantém um
// container oficial do Playwright de pé com o frontend_v2 (:3005) e roda cada fase (um spec) com
// `docker exec`, mexendo no banco ENTRE as fases (specs não têm psql).
// retries: 0 de propósito — as fases GRAVAM (nova versão da configuração); repetir um spec
// depois de ele ter salvo partiria de um estado diferente e mascararia a falha.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e-hub-adiantamentos-categorias',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
