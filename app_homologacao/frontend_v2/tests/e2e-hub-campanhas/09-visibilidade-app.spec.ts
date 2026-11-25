// Fase 9: interruptor de visibilidade no app. Roda por último, sobre a campanha de extrato (em andamento,
// ligada na fase 6 pela tela do hub). Desliga -> o app não a vê (lista/Início, detalhe por URL, API) ->
// liga -> o app vê só a posição ("3º"), sem "de N", e o payload não traz o total -> desliga de novo.
// O driver confere a Auditoria no banco depois.
import { test, expect, type Page } from '@playwright/test';
import { APP, HUB, NOME_EXTRATO, apiHub, definirVisibilidade, env, loginApp, loginHub } from './_comum';

async function apiApp(page: Page, caminho: string) {
  return page.evaluate(async (c) => {
    const r = await fetch(`/api/motorista${c}`, { credentials: 'include' });
    return { status: r.status, texto: await r.text() };
  }, caminho);
}

test.describe.serial('campanhas — interruptor de visibilidade no app', () => {
  test('hub: desliga (selo Oculta no detalhe e na lista)', async ({ page }) => {
    const id = env('CAMP_X_ID');
    await loginHub(page, env('CAMP_ADMIN_EMAIL'), env('CAMP_ADMIN_SENHA'));
    await page.goto(`${HUB}/hub/dashboard/campanhas/${id}`);
    await expect(page.getByText('Visível no app', { exact: true })).toBeVisible();
    await definirVisibilidade(page, false);
    await expect(page.getByText('Visível no app', { exact: true })).toHaveCount(0);
    expect(JSON.parse((await apiHub(page, 'GET', `/hub/campanhas/${id}`)).texto).visivelApp).toBe(false);
    await page.goto(`${HUB}/hub/dashboard/campanhas`);
    await expect(page.getByRole('row', { name: new RegExp(NOME_EXTRATO) })).toContainText('Oculta no app');
  });

  test('app: oculta, a campanha some (Início, detalhe por URL, API)', async ({ page }) => {
    const id = env('CAMP_X_ID');
    await loginApp(page, env('CAMP_MOT_A_CNPJ'), env('CAMP_MOT_SENHA'));
    const carregou = page.waitForResponse((r) => r.url().includes('/api/motorista/campanhas') && r.status() === 200);
    await page.goto(`${APP}/movimento`);
    await carregou; // a lista chegou (sem isso a ausência do card seria vácuo)
    await expect(page.getByRole('link', { name: new RegExp(NOME_EXTRATO) })).toHaveCount(0);
    await page.goto(`${APP}/campanhas/${id}`);
    await expect(page.getByText('Campanha não encontrada')).toBeVisible();
    expect((await apiApp(page, `/campanhas/${id}`)).status).toBe(404);
    const lista = await apiApp(page, '/campanhas');
    expect(lista.status).toBe(200);
    expect(lista.texto).not.toContain(NOME_EXTRATO);
  });

  test('hub: liga pelo interruptor (selo vira Visível no app)', async ({ page }) => {
    const id = env('CAMP_X_ID');
    await loginHub(page, env('CAMP_ADMIN_EMAIL'), env('CAMP_ADMIN_SENHA'));
    await page.goto(`${HUB}/hub/dashboard/campanhas/${id}`);
    await expect(page.getByText('Oculta no app', { exact: true })).toBeVisible();
    await definirVisibilidade(page, true);
    await expect(page.getByText('Oculta no app', { exact: true })).toHaveCount(0);
    await page.goto(`${HUB}/hub/dashboard/campanhas`);
    await expect(page.getByRole('row', { name: new RegExp(NOME_EXTRATO) })).toContainText('Visível no app');
  });

  test('app: visível, só a posição (topo e card) e payload sem total', async ({ page }) => {
    const id = env('CAMP_X_ID');
    await loginApp(page, env('CAMP_MOT_A_CNPJ'), env('CAMP_MOT_SENHA'));
    await page.goto(`${APP}/movimento`);
    const card = page.getByRole('link', { name: new RegExp(NOME_EXTRATO) });
    await expect(card).toBeVisible();
    await expect(card).toContainText('3º');
    await expect(card).not.toContainText(/\bde \d/);
    await page.goto(`${APP}/campanhas/${id}`);
    const meu = page.getByRole('region', { name: 'Meu extrato' });
    await expect(meu).toContainText('3º');
    await expect(meu).not.toContainText(/\bde \d/);

    const det = await apiApp(page, `/campanhas/${id}`);
    expect(det.status).toBe(200);
    expect(JSON.parse(det.texto)).not.toHaveProperty('totalClassificados');
    expect(det.texto).not.toContain('totalClassificados');
    const lista = await apiApp(page, '/campanhas');
    expect(lista.status).toBe(200);
    const itens = JSON.parse(lista.texto).itens ?? JSON.parse(lista.texto);
    expect(Array.isArray(itens) && itens.length).toBeGreaterThan(0);
    for (const it of itens) expect(it).not.toHaveProperty('total');
  });

  test('hub: desliga de novo e a campanha some do app', async ({ page, browser }) => {
    const id = env('CAMP_X_ID');
    await loginHub(page, env('CAMP_ADMIN_EMAIL'), env('CAMP_ADMIN_SENHA'));
    await page.goto(`${HUB}/hub/dashboard/campanhas/${id}`);
    await definirVisibilidade(page, false);
    const app = await browser.newPage();
    await loginApp(app, env('CAMP_MOT_A_CNPJ'), env('CAMP_MOT_SENHA'));
    await app.goto(`${APP}/campanhas/${id}`);
    await expect(app.getByText('Campanha não encontrada')).toBeVisible();
    await app.close();
  });
});
