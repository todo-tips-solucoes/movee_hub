// Fase 7 (extrato): depois de o driver semear Performance + faturamento e recalcular, o detalhe do hub
// mostra os cards (turnos válidos %, valor somado) e a tabela com turnos válidos / trabalhados / valor
// somado (nome completo), e o CSV sai com o cabeçalho do extrato. Números calculados à mão no driver.
import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { HUB, NOME_EXTRATO, campanhaIdPorNome, env, loginHub } from './_comum';

const kpi = (page: Page, titulo: string) =>
  page
    .locator('[data-slot="card"]')
    .filter({ has: page.locator('[data-slot="card-title"]', { hasText: new RegExp(`^${titulo}$`) }) });

test('extrato: detalhe do hub com cards, tabela e CSV', async ({ page }) => {
  await loginHub(page, env('CAMP_ADMIN_EMAIL'), env('CAMP_ADMIN_SENHA'));
  const id = await campanhaIdPorNome(page, NOME_EXTRATO);
  await page.goto(`${HUB}/hub/dashboard/campanhas/${id}`);
  await expect(page.getByRole('heading', { level: 1, name: NOME_EXTRATO })).toBeVisible();
  await expect(page.getByText('Melhor extrato').first()).toBeVisible();

  // cards: 10 de 13 turnos válidos; Σ do valor dos turnos válidos = R$ 425,00
  await expect(kpi(page, 'Participantes')).toContainText('5');
  await expect(kpi(page, 'Classificados')).toContainText('4');
  await expect(kpi(page, 'Turnos válidos')).toContainText('76,9%');
  await expect(kpi(page, 'Valor somado')).toContainText(/R\$\s*425,00/);

  // regras travadas: critério, valor do turno (família com rótulo de tela) e desempate
  await expect(page.getByText('Maior valor somado, depois mais turnos válidos')).toBeVisible();
  await expect(page.getByText(/Corridas, Promoção/)).toBeVisible();

  // abas do extrato: sem "Abaixo do corte"; "Sem o mínimo" com a contagem
  const abas = page.getByRole('tablist', { name: 'Lista' });
  await expect(abas.getByRole('tab', { name: /Abaixo do corte/ })).toHaveCount(0);
  await expect(abas.getByRole('tab', { name: 'Sem o mínimo · 1' })).toBeVisible();

  // tabela dos classificados
  const cab = page.locator('thead th');
  await expect(cab.filter({ hasText: 'Turnos válidos' })).toHaveCount(1);
  await expect(cab.filter({ hasText: 'Trabalhados' })).toHaveCount(1);
  await expect(cab.filter({ hasText: 'Valor somado' })).toHaveCount(1);
  const corpo = page.locator('tbody tr');
  await expect(corpo).toHaveCount(4);
  // [nome completo, turnos válidos, trabalhados, valor]
  const esperado: [string, string, string, RegExp][] = [
    ['Aline Ribeiro Santos', '3', '3', /R\$\s*150,00/],
    ['Bruno Teixeira Souza', '2', '3', /R\$\s*120,00/],
    ['Eva Costa Lima', '2', '2', /R\$\s*70,00/],
    ['Diego Pires Oliveira', '2', '3', /R\$\s*25,00/],
  ];
  for (let i = 0; i < esperado.length; i++) {
    const [nome, v, t, valor] = esperado[i];
    const celulas = corpo.nth(i).locator('td');
    await expect(celulas.nth(1)).toContainText(nome);
    await expect(celulas.nth(2)).toHaveText(v);
    await expect(celulas.nth(3)).toHaveText(t);
    await expect(celulas.nth(4)).toContainText(valor);
  }

  await abas.getByRole('tab', { name: 'Sem o mínimo · 1' }).click();
  await expect(corpo).toHaveCount(1);
  const c = corpo.first().locator('td');
  await expect(c.nth(1)).toContainText('Carla Dias Moreira');
  await expect(c.nth(2)).toHaveText('1');
  await expect(c.nth(3)).toHaveText('2');
  await expect(c.nth(4)).toContainText(/R\$\s*60,00/);

  // CSV
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar CSV' }).click()]);
  try {
    await dl.saveAs('/dl/extrato.csv');
  } catch {
    const txt = await page.evaluate(async (cid) => (await fetch(`/api/v1/hub/campanhas/${cid}/ranking.csv`, { credentials: 'include' })).text(), id);
    writeFileSync('/dl/extrato.csv', txt);
  }
});
