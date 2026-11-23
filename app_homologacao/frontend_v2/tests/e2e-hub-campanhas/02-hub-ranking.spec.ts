// Fase 2 (c): depois de o driver recalcular as campanhas ativas (RPC hub_campanhas_recalcular_ativas,
// como o gancho da importação faz), o detalhe mostra o ranking com as abas e as contagens corretas.
// admin_entidade e financeiro enxergam o mesmo. Notas calculadas à mão no driver (ver seed).
import { test, expect, type Page } from '@playwright/test';
import { HUB, NOME_CAMPANHA, campanhaIdPorNome, env, loginHub } from './_comum';

async function verRanking(page: Page) {
  const id = await campanhaIdPorNome(page, NOME_CAMPANHA);
  await page.goto(`${HUB}/hub/dashboard/campanhas/${id}`);
  await expect(page.getByRole('heading', { level: 1, name: NOME_CAMPANHA })).toBeVisible();
  await expect(page.getByText('Em andamento').first()).toBeVisible();

  // KPIs
  await expect(page.getByText('No ranking').first()).toBeVisible();

  // abas com as contagens (classificados 4, abaixo do corte 1, sem mínimo 0, sem modal 1)
  const abas = page.getByRole('tablist', { name: 'Lista' });
  await expect(abas.getByRole('tab', { name: 'Classificados' })).toHaveAttribute('aria-selected', 'true');
  await expect(abas.getByRole('tab', { name: 'Abaixo do corte · 1' })).toBeVisible();
  await expect(abas.getByRole('tab', { name: 'Sem mínimo · 0' })).toBeVisible();
  await expect(abas.getByRole('tab', { name: 'Sem modal · 1' })).toBeVisible();

  // classificados: ordem e notas (99,0 / 91,67 / 86,67 / 85,33), nome COMPLETO no hub
  const corpo = page.locator('tbody tr');
  await expect(corpo).toHaveCount(4);
  const esperado: [string, string][] = [
    ['Aline Ribeiro Santos', '99,0'],
    ['Bruno Teixeira Souza', '91,67'],
    ['Carla Dias Moreira', '86,67'],
    ['Eva Costa Lima', '85,33'],
  ];
  for (let i = 0; i < esperado.length; i++) {
    await expect(corpo.nth(i)).toContainText(esperado[i][0]);
    await expect(corpo.nth(i)).toContainText(esperado[i][1]);
    await expect(corpo.nth(i)).toContainText('MOTO');
  }
  // o motorista de modal CARRO nunca é gravado
  await expect(page.getByText('Gil Rocha Prado')).toHaveCount(0);

  await abas.getByRole('tab', { name: 'Abaixo do corte · 1' }).click();
  await expect(corpo).toHaveCount(1);
  await expect(corpo.first()).toContainText('Diego Pires Oliveira');
  await expect(corpo.first()).toContainText('77,33 (5º)');
  await expect(corpo.first()).toContainText(/aceita/i);

  await abas.getByRole('tab', { name: 'Sem modal · 1' }).click();
  await expect(corpo).toHaveCount(1);
  await expect(corpo.first()).toContainText('Fabio Nunes Pinto');

  await abas.getByRole('tab', { name: 'Sem mínimo · 0' }).click();
  await expect(page.getByText('Ninguém nesta lista')).toBeVisible();

  // regras travadas
  await expect(page.getByRole('heading', { name: 'Regras travadas' })).toBeVisible();
}

test('c) admin_entidade: detalhe com ranking, abas e contagens', async ({ page }) => {
  await loginHub(page, env('CAMP_ADMIN_EMAIL'), env('CAMP_ADMIN_SENHA'));
  await verRanking(page);
});

test('c) financeiro (papel com as permissões): enxerga o mesmo ranking', async ({ page }) => {
  await loginHub(page, env('CAMP_FIN_EMAIL'), env('CAMP_FIN_SENHA'));
  await page.getByRole('link', { name: 'Campanhas', exact: true }).first().click();
  await page.waitForURL('**/hub/dashboard/campanhas');
  await expect(page.getByRole('row', { name: new RegExp(NOME_CAMPANHA) })).toBeVisible();
  await verRanking(page);
});
