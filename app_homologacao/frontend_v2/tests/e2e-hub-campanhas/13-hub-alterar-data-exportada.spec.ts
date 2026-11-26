// Fase 13 (0133): depois da planilha, "Alterar data" muda a data do prêmio mas NÃO a já exportada:
// a coluna "Pagamento em" segue em T+6 e o re-download reproduz a mesma planilha (o driver compara os bytes lidos).
import { test, expect } from '@playwright/test';
import { HUB, NOME_PARAM_LIVRE, apiHub, baixar, campanhaIdPorPrefixo, ddmm, env, loginHub, somaDias } from './_comum';

test('e) alterar a data depois de exportar: a data gravada não muda e o re-download é igual', async ({ page }) => {
  const T = env('CAMP_T');
  await loginHub(page, env('CAMP_ADMIN_EMAIL'), env('CAMP_ADMIN_SENHA'));
  const id = await campanhaIdPorPrefixo(page, NOME_PARAM_LIVRE);
  await page.goto(`${HUB}/hub/dashboard/campanhas/${id}`);
  const vencedores = page.getByRole('region', { name: 'Vencedores' });
  const carla = vencedores.locator('tbody tr').nth(1);
  await expect(carla).toContainText(ddmm(somaDias(T, 6)));

  await page.getByRole('button', { name: 'Alterar data' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Nova data').fill(somaDias(T, 8));
  await dlg.getByRole('button', { name: 'Salvar' }).click();
  await expect(dlg).toBeHidden();
  const det = JSON.parse((await apiHub(page, 'GET', `/hub/campanhas/${id}`)).texto);
  expect(det.dataPremio).toBe(somaDias(T, 8));
  await expect(page.getByText(ddmm(somaDias(T, 8))).first()).toBeVisible();
  // a linha do dinheiro continua na data em que foi exportada
  await expect(carla).toContainText(ddmm(somaDias(T, 6)));
  await expect(carla).not.toContainText(ddmm(somaDias(T, 8)));

  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Baixar planilha de prêmios em dinheiro' }).click(),
  ]);
  await baixar(page, dl, id, '/dl/param-2.xlsx');
  await expect(carla).toContainText(ddmm(somaDias(T, 6)));
});
