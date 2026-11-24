// Fase 2 (itens 5 e 4 do plano):
//  - o detalhe de uma solicitação calculada com a config em modo todas mostra "Todas, exceto: …"
//    traduzido, sem token cru (`modo:`/`familia:`) no DOM;
//  - voltar para "Só as marcadas" converte para a seleção equivalente e salva.
import { test, expect } from '@playwright/test';
import { HUB, abrirConfiguracoes, chip, chipsProducao, comoContarProducao, env, loginHub } from './_comum';

test('detalhe da solicitação traduz o modo; voltar a "Só as marcadas" converte e salva', async ({ page }) => {
  await loginHub(page, env('CAT_ADMIN_EMAIL'), env('CAT_ADMIN_SENHA'));

  // (5) detalhe
  await page.goto(`${HUB}/hub/dashboard/adiantamentos/${env('CAT_SOL_ID')}`);
  await expect(page.getByText('Todas, exceto: Indicadores, Bonus Extra E2E', { exact: true })).toBeVisible();
  const html = await page.content();
  expect(html, 'token cru no HTML do detalhe').not.toMatch(/modo:todas|familia:indicador|familia:promocao/);
  await expect(page.locator('body')).not.toContainText(/modo:|familia:/);

  // (4) voltar a "Só as marcadas"
  await abrirConfiguracoes(page);
  const modo = comoContarProducao(page);
  await expect(modo.getByRole('radio', { name: 'Todas, exceto as marcadas' })).toBeChecked();
  await expect(chipsProducao(page).getByRole('button', { pressed: true })).toHaveCount(2);
  await modo.getByRole('radio', { name: 'Só as marcadas' }).check();
  await expect(modo.getByRole('radio', { name: 'Só as marcadas' })).toBeChecked();
  // converte para a seleção EQUIVALENTE: fica marcado tudo o que estava entrando (Corrida + a nova) e as
  // famílias que não eram exceção (Promoção e Missões, mesmo sem membros na janela: seguem entrando se surgirem)
  await expect(chipsProducao(page).getByRole('button', { pressed: true })).toHaveCount(4);
  await expect(chip(page, /^Promoção/)).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, /^Missões/)).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, /^Corrida E2E/)).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, /^Incentivo chuva E2E/)).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, /^Indicadores/)).toHaveAttribute('aria-pressed', 'false');
  await expect(chip(page, /^Bonus Extra E2E/)).toHaveAttribute('aria-pressed', 'false');
  await expect(modo).toContainText('ao voltar para “Só as marcadas”, fica marcado tudo o que estava entrando');
  await expect(page.locator('body')).not.toContainText(/modo:|familia:/);
  await page.getByRole('button', { name: 'Salvar versão 4' }).click();
  await expect(page.getByRole('button', { name: 'Salvar versão 5' })).toBeVisible();
});
