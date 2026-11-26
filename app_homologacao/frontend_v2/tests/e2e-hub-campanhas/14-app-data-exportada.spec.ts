// Fase 13 (0133, M1): depois de EXPORTAR a planilha (T+6) e alterar a data do prêmio para T+8, o app da Carla
// (dinheiro) mostra a data EXPORTADA (T+6) no status E no rodapé de dinheiro — nunca a nova no pagamento dela.
// O objeto (Bruno, sem planilha) segue a data da campanha (T+8).
import { test, expect } from '@playwright/test';
import { APP, ddmm, env, loginApp, somaDias } from './_comum';

test('e) app: Carla vê Pagamento previsto na data exportada (T+6), status e rodapé iguais', async ({ page }) => {
  await loginApp(page, env('CAMP_MOT_CARLA_CNPJ'), env('CAMP_MOT_SENHA'));
  await page.goto(`${APP}/campanhas/${env('CAMP_ID')}`);
  await expect(page.getByText('Resultado final', { exact: true })).toBeVisible();
  const t6 = ddmm(somaDias(env('CAMP_T'), 6));
  const t8 = ddmm(somaDias(env('CAMP_T'), 8));
  await expect(page.getByText(`Pagamento previsto em ${t6}`, { exact: true })).toBeVisible();
  await expect(page.getByText(`Prêmio em dinheiro: pagamento previsto em ${t6}.`)).toBeVisible();
  await expect(page.getByText(`Pagamento previsto em ${t8}`)).toHaveCount(0);
  await expect(page.getByText(`pagamento previsto em ${t8}`)).toHaveCount(0);
});

test('e) app: Bruno (objeto) segue a data nova da campanha (T+8)', async ({ page }) => {
  await loginApp(page, env('CAMP_MOT_BRUNO_CNPJ'), env('CAMP_MOT_SENHA'));
  await page.goto(`${APP}/campanhas/${env('CAMP_ID')}`);
  const t8 = ddmm(somaDias(env('CAMP_T'), 8));
  await expect(page.getByText(`Entrega prevista em ${t8}`, { exact: true })).toBeVisible();
});
