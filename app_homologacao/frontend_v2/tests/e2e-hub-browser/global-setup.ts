// hub-shell (S3) FASE 6 — global setup do Playwright: loga UMA VEZ por papel
// (admin_entidade, operador) e persiste `storageState` (cookies httpOnly
// accessToken/refreshToken) em arquivo, para os specs REUSAREM a sessão via
// `test.use({ storageState })` em vez de repetir o login via UI em cada
// teste/página.
//
// Achado desta onda: `routes/hub-auth.js` tem rate limiter em `/auth/login`
// (`authRateLimiter`, chave `IP:email`, max=10/15min) — como TODOS os specs
// desta suíte compartilham a MESMA IP de origem (container Playwright,
// `--network host`) e os MESMOS 2 e-mails sintéticos, repetir o login via UI
// em cada teste (6+ logins por execução completa da suíte) esgota o limite
// em poucas rodadas de debug e produz falhas em cascata que NADA têm a ver
// com bugs reais do shell (mensagem 429 confirmada em `docker logs
// hub_homolog_traefik`). Logar 1x por papel aqui reduz para exatamente 2
// logins por execução da suíte inteira — folga ampla sob o limite de 10.
//
// storageState grava em `/tmp` (fora do bind mount do repo) — artefato
// efêmero do container `--rm`, nunca commitado.
import { chromium, type FullConfig } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { credenciaisAdmin, credenciaisOperador, loginViaUI } from './helpers';

const AUTH_DIR = '/tmp/hub-e2e-auth';
export const ADMIN_STATE = path.join(AUTH_DIR, 'admin.json');
export const OPERADOR_STATE = path.join(AUTH_DIR, 'operador.json');

async function loginESalvar(
  baseURL: string,
  cred: { email: string; senha: string },
  statePath: string,
  selecionarPrimeiraEntidade: boolean
): Promise<void> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await loginViaUI(page, cred);
    if (selecionarPrimeiraEntidade) {
      // admin_entidade tem 2 vínculos -> ramo "escolha", precisa de 1 clique
      // para chegar ao dashboard (operador tem 1 só -> auto-seleciona sozinho).
      await page.getByRole('button', { name: /^Empresa #/ }).first().click();
    }
    await page.waitForURL('**/hub/dashboard', { timeout: 15_000 });
    await context.storageState({ path: statePath });
    await context.close();
  } finally {
    await browser.close();
  }
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  // Lido direto do env (mesma fonte que playwright.config.hub.ts usa para
  // `use.baseURL`) — mais simples/robusto que navegar a árvore de config.
  const baseURL = process.env.HUB_E2E_BASE_URL || 'https://hub-homolog.todo-tips.com:8443';

  await loginESalvar(baseURL, credenciaisAdmin(), ADMIN_STATE, true);
  await loginESalvar(baseURL, credenciaisOperador(), OPERADOR_STATE, false);
}
