// motorista-push — tasks.md FASE 9.4.2/9.4.3 (feature "Notificações push no
// app do motorista"): E2E de BROWSER do app_homologacao/frontend_motorista
// cobrindo 3.3.3 (redirecionamento seguro de `next`), 6.2.4 (5 estados do
// passo de contexto de notificações), 6.5.3 (sessão/aviso), 8.1.3 (teclado),
// 8.1.4 (axe-core).
//
// dec-107 (block-009, respondido 2026-09-12): o operador autorizou cobrir
// 6.2.4/6.5.3 via Playwright em container oficial SEM instalar dependência
// nova no app motorista. frontend_motorista não tem @playwright/test nem
// @axe-core/playwright — ambos JÁ estão instalados aqui em frontend_v2
// (usados por playwright.config.hub-avisos.ts / hub.ts). Esta config e os
// specs em ./tests/e2e-motorista-push vivem em frontend_v2 só para REUSAR
// esse devDependency já aprovado; o app testado é outro processo Next.js
// (frontend_motorista, next start -p 3006) rodando no mesmo container —
// Playwright fala com ele via HTTP (baseURL), sem qualquer acoplamento de
// código entre os dois projetos.
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.MOTORISTA_E2E_BASE_URL || 'http://127.0.0.1:3006';

export default defineConfig({
  testDir: './tests/e2e-motorista-push',
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
