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
  // Retry por TESTE, não por suíte. Medido em 2026-10-10, 7 rodadas: 8 testes
  // distintos falharam e NENHUM falhou duas vezes — ruído, não regressão. Com
  // 142 testes, ~0,5% de flake por teste dá ~50% de chance de a rodada inteira
  // falhar, e foi isso que cegou o gate (o `e2e-guard` alertava sem haver
  // defeito). As causas medidas são todas do arnês: `ERR_NETWORK_CHANGED` do
  // Chromium sob `--network host` (este host roda ~50 containers de vários
  // clientes), e medição antes do render.
  //
  // Repetir a suíte inteira — o que o guard fazia sozinho — custa ~4 min e
  // mede de novo os 142; repetir só o teste que caiu custa segundos. O ganho
  // de confiança é o mesmo e o relatório passa a separar `flaky` de `failed`,
  // que é o sinal que faltava.
  //
  // ⚠️ Retry MASCARA degradação se ninguém olhar o `flaky`. Por isso o
  // `e2e-guard` alerta quando o número de flaky passa do teto (ver
  // infra/producao/e2e-guard.js) — a rede de segurança não pode virar tapete.
  retries: process.env.CI ? 2 : 0,
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
