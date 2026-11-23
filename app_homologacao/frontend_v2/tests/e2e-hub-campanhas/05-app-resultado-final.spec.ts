// Fase 5 (e): app do motorista depois do fechamento — card e tela mostram "Resultado final".
import { test, expect } from '@playwright/test';
import { APP, env, loginApp } from './_comum';

test('e) app: card "Resultado final" e a tela do resultado', async ({ page }) => {
  const id = env('CAMP_ID');
  await loginApp(page, env('CAMP_MOT_A_CNPJ'), env('CAMP_MOT_SENHA'));
  await page.goto(`${APP}/movimento`);
  const card = page.getByRole('link', { name: /Rei do Jantar E2E/ });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Resultado final');
  await expect(card).toContainText('Você ficou em');
  await expect(card).toContainText('4º');
  await expect(card).toContainText('de 4');
  await card.click();
  await page.waitForURL(`**/campanhas/${id}`);
  await expect(page.getByText('Resultado final', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Você ficou em 4º lugar');
  const lista = page.getByRole('list', { name: 'Classificação final' });
  await expect(lista).toContainText('Aline S.');
  await expect(lista).toContainText('Você');
  const texto = await page.locator('body').innerText();
  for (const s of ['Ribeiro', 'Teixeira', 'Moreira', 'Santos', 'Souza']) expect(texto).not.toContain(s);
});

test('e) app: o vencedor (1º, objeto) vê o prêmio e a entrega registrada', async ({ page }) => {
  const id = env('CAMP_ID');
  await loginApp(page, env('CAMP_MOT_W_CNPJ'), env('CAMP_MOT_SENHA'));
  await page.goto(`${APP}/campanhas/${id}`);
  await expect(page.getByText('Resultado final', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Você ficou em 1º lugar!');
  await expect(page.getByText('Seu prêmio')).toBeVisible();
  await expect(page.getByText('Bag térmica Movee')).toBeVisible();
});
