// Helpers e env do cenário campanhas (compartilhado pelas fases). Seeds vêm do driver por env var.
import { expect, type Page } from '@playwright/test';

export const HUB = process.env.HUB_E2E_BASE_URL || 'http://127.0.0.1:3005';
export const APP = process.env.MOTORISTA_E2E_BASE_URL || 'http://127.0.0.1:3006';

export const env = (nome: string): string => {
  const v = process.env[nome];
  if (!v) throw new Error(`env var ${nome} ausente — o driver não a definiu para esta fase`);
  return v;
};

export const NOME_CAMPANHA = 'Rei do Jantar E2E';
export const NOME_EXTRATO = 'Melhor extrato E2E';

/** YYYY-MM-DD + n dias (aritmética em UTC, sem fuso). */
export function somaDias(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function loginHub(page: Page, email: string, senha: string) {
  await page.goto(`${HUB}/hub/login`);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Senha', { exact: true }).fill(senha);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForURL('**/hub/dashboard', { timeout: 20_000 });
}

export async function loginApp(page: Page, cnpjDigitos: string, senha: string) {
  await page.goto(`${APP}/login`);
  await page.getByLabel('CNPJ do Prestador').fill(cnpjDigitos);
  await page.getByLabel('Senha', { exact: true }).fill(senha);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
}

/** Chamada à API do hub pelo browser (cookies de sessão). */
export async function apiHub(page: Page, metodo: string, caminho: string, corpo?: unknown) {
  return page.evaluate(
    async ({ metodo, caminho, corpo }) => {
      const r = await fetch(`/api/v1${caminho}`, {
        method: metodo,
        credentials: 'include',
        headers: corpo === undefined ? {} : { 'Content-Type': 'application/json' },
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
      });
      const texto = await r.text();
      return { status: r.status, texto };
    },
    { metodo, caminho, corpo },
  );
}

export async function campanhaIdPorNome(page: Page, nome: string): Promise<number> {
  const r = await apiHub(page, 'GET', '/hub/campanhas');
  expect(r.status).toBe(200);
  const itens = (JSON.parse(r.texto).itens ?? []) as { id: number; nome: string; situacao: string }[];
  const achadas = itens.filter((c) => c.nome === nome && c.situacao !== 'rascunho');
  expect(achadas.length, `campanha lançada "${nome}" na lista`).toBeGreaterThanOrEqual(1);
  return Math.max(...achadas.map((c) => c.id));
}

/** Interruptor "Motoristas veem esta campanha no app" do detalhe do hub; espera o selo mudar. */
export function interruptorVisibilidade(page: Page) {
  return page.getByRole('switch', { name: 'Motoristas veem esta campanha no app' });
}

export async function definirVisibilidade(page: Page, visivel: boolean) {
  const sw = interruptorVisibilidade(page);
  await expect(sw).toBeVisible();
  if ((await sw.getAttribute('aria-checked')) === String(visivel)) return;
  await sw.click();
  await expect(page.getByText(visivel ? 'Visível no app' : 'Oculta no app', { exact: true })).toBeVisible();
  await expect(sw).toHaveAttribute('aria-checked', String(visivel));
}
