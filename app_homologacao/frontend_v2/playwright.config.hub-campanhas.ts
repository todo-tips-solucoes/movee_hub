// campanhas do motorista (W4) — E2E de browser do fluxo ponta a ponta: hub (criar -> editar ->
// lançar -> ranking -> fechar -> vencedores/entrega/planilha) + app do motorista (card, tela,
// privacidade, resultado final) + aviso de início. Roda via
// infra/hub/testes/hub-campanhas-e2e-browser.sh contra o stack efêmero hub-test-<runid>:
// o driver mantém UM container oficial do Playwright de pé com os DOIS frontends (hub :3005,
// app motorista :3006) e roda cada fase (um spec) com `docker exec`, mexendo no banco ENTRE as
// fases (specs não têm acesso a psql). Por isso o testDir é um diretório só de fases numeradas,
// e o driver passa o arquivo da fase como argumento.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e-hub-campanhas',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  // Retry só em CI (guard); justificativa completa em playwright.config.hub.ts.
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
  use: {
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
