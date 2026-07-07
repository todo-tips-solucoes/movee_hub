// hub-shell (S3) FASE 6 — helpers compartilhados dos specs Playwright da
// onda BROWSER (6.2.1, 6.2.5, 6.3.1/6.3.2). Credenciais vêm de env vars
// injetadas pelo driver `infra/hub/testes/hub-shell-e2e-browser.sh` (contas
// sintéticas `e2e-teste-shell-browser-*@example.test`, seedadas antes do
// container Playwright rodar e removidas em `trap` no shell script — nunca
// hardcoded aqui).
import type { Page } from '@playwright/test';

export interface Credenciais {
  email: string;
  senha: string;
}

export function credenciaisAdmin(): Credenciais {
  const email = process.env.HUB_E2E_ADMIN_EMAIL;
  const senha = process.env.HUB_E2E_SENHA;
  if (!email || !senha) {
    throw new Error(
      'HUB_E2E_ADMIN_EMAIL/HUB_E2E_SENHA ausentes — rodar via infra/hub/testes/hub-shell-e2e-browser.sh (nunca hardcode credenciais no spec).'
    );
  }
  return { email, senha };
}

export function credenciaisOperador(): Credenciais {
  const email = process.env.HUB_E2E_OPERADOR_EMAIL;
  const senha = process.env.HUB_E2E_SENHA;
  if (!email || !senha) {
    throw new Error(
      'HUB_E2E_OPERADOR_EMAIL/HUB_E2E_SENHA ausentes — rodar via infra/hub/testes/hub-shell-e2e-browser.sh.'
    );
  }
  return { email, senha };
}

/** Login via UI real (form de /hub/login) — nunca via fetch direto (é isso que valida a tela). */
export async function loginViaUI(page: Page, cred: Credenciais): Promise<void> {
  await page.goto('/hub/login');
  // `exact: true` — sem isso, `getByLabel('Senha')` também casa (substring)
  // com o botão `aria-label="Mostrar senha"` (achado desta onda: strict
  // mode violation, 2 elementos).
  await page.getByLabel('Email', { exact: true }).fill(cred.email);
  await page.getByLabel('Senha', { exact: true }).fill(cred.senha);
  await page.getByRole('button', { name: 'Entrar' }).click();
  // Pós-login sempre encaminha a /selecionar-entidade (app/hub/login/page.tsx).
  await page.waitForURL('**/selecionar-entidade', { timeout: 10_000 });
}
