// Helpers e env das fases do cenário "categorias: modo todas". Seeds vêm do driver por env var.
import { expect, type Locator, type Page } from '@playwright/test';

export const HUB = process.env.HUB_E2E_BASE_URL || 'http://127.0.0.1:3005';

export const env = (nome: string): string => {
  const v = process.env[nome];
  if (!v) throw new Error(`env var ${nome} ausente — o driver não a definiu para esta fase`);
  return v;
};

export const TITULO_PRODUCAO = 'Categorias que entram na produção';

export async function loginHub(page: Page, email: string, senha: string) {
  await page.goto(`${HUB}/hub/login`);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Senha', { exact: true }).fill(senha);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForURL('**/hub/dashboard', { timeout: 20_000 });
}

/** Abre as Configurações e espera o seletor de PRODUÇÃO (o 1º da página) carregar as categorias. */
export async function abrirConfiguracoes(page: Page) {
  await page.goto(`${HUB}/hub/dashboard/adiantamentos/configuracoes`);
  await expect(page.getByRole('group', { name: TITULO_PRODUCAO })).toBeVisible();
}

/** Fieldset "Como contar" do seletor de produção = o primeiro da página (ordem do DOM). */
export const comoContarProducao = (page: Page): Locator => page.getByRole('group', { name: 'Como contar' }).first();
export const chipsProducao = (page: Page): Locator => page.getByRole('group', { name: TITULO_PRODUCAO });
export const chip = (page: Page, rotulo: RegExp): Locator => chipsProducao(page).getByRole('button', { name: rotulo });
