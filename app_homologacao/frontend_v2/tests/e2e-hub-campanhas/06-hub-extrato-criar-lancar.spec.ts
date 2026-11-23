// Fase 6 (extrato): admin cria a campanha "Melhor extrato" pelo formulário (tipo, mínimo no turno em
// 2 critérios, categorias pelo seletor — nome exato + família —, base do mínimo "válidos"), salva o
// rascunho, reabre para conferir que tudo foi gravado e lança. O driver confere o banco depois.
import { test, expect, type Page } from '@playwright/test';
import { ROTULO_INDICADOR_CAMPANHA } from '../../lib/hub/campanhas-dto';
import { HUB, NOME_EXTRATO, apiHub, campanhaIdPorNome, env, loginHub, somaDias } from './_comum';

const R = ROTULO_INDICADOR_CAMPANHA;

async function marcar(page: Page, legenda: RegExp, texto: string) {
  const grupo = page.getByRole('group', { name: legenda });
  await grupo.locator('label', { hasText: new RegExp(`^${texto}$`) }).click();
}

test('extrato: rascunho -> reabrir -> lançar', async ({ page }, testInfo) => {
  const INI = env('CAMP_X_INI');
  const FIM = somaDias(INI, 3);
  const nomeRascunho = `${NOME_EXTRATO} rascunho r${testInfo.retry}`;

  await loginHub(page, env('CAMP_ADMIN_EMAIL'), env('CAMP_ADMIN_SENHA'));
  await page.goto(`${HUB}/hub/dashboard/campanhas/nova`);

  // tipo: troca para "Melhor extrato" e o formulário muda (sem peso; "Mínimo no turno")
  await page.getByRole('radio', { name: /Melhor extrato/ }).check();
  await expect(page.getByLabel(`Peso (%) — ${R.aceitacao}`)).toHaveCount(0);

  await page.getByLabel('Nome da campanha').fill(nomeRascunho);
  await page.getByLabel(/Regras e descrição/).fill('Turno bom soma o valor do turno no extrato.');
  await page.getByLabel('Início', { exact: true }).fill(INI);
  await page.getByLabel('Fim', { exact: true }).fill(FIM);
  await marcar(page, /^Praças/, 'SAO PAULO');
  await marcar(page, /^Turnos/, 'JANTAR 18H-22H');
  await marcar(page, /^Modal/, 'MOTO');
  await page.getByLabel('Mínimo de turnos para entrar no ranking').fill('2');
  await page.getByRole('radio', { name: 'turnos válidos' }).check();

  // critérios do turno: aceitação >= 90% e tempo disponível >= 70%
  await page.getByText(R.aceitacao, { exact: true }).first().click();
  await page.getByLabel(`Mínimo no turno (%) — ${R.aceitacao}`, { exact: true }).fill('90');
  await page.getByText(R.tempo, { exact: true }).first().click();
  await page.getByLabel(`Mínimo no turno (%) — ${R.tempo}`, { exact: true }).fill('70');

  // categorias: seletor do adiantamento. Gorjeta (sem turno) nem aparece; "Corridas" (nome) + Promoção (família)
  const cats = page.getByRole('group', { name: 'Categorias do faturamento' });
  await expect(cats.getByRole('button', { name: /^Corridas/ })).toBeVisible();
  await expect(cats.getByRole('button', { name: /^Ajuste fora da campanha/ })).toBeVisible();
  await expect(cats.getByRole('button', { name: /^Gorjeta/ })).toHaveCount(0);
  await cats.getByRole('button', { name: /^Corridas/ }).click();
  await cats.getByRole('button', { name: /^Promoção/ }).click();
  await expect(cats.getByRole('button', { name: /^Corridas/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(cats.getByRole('button', { name: /^Promoção/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(cats.getByRole('button', { name: /^Ajuste fora da campanha/ })).toHaveAttribute('aria-pressed', 'false');

  // 1 faixa: 1º ao 3º, objeto
  await page.getByRole('button', { name: 'Adicionar faixa' }).click();
  await page.getByLabel('Até a posição').nth(0).fill('3');
  await page.getByLabel('Descrição do prêmio').nth(0).fill('Vale-combustível');

  await page.getByRole('button', { name: 'Salvar rascunho' }).click();
  await page.waitForURL('**/hub/dashboard/campanhas');
  const linha = page.getByRole('row', { name: new RegExp(nomeRascunho) });
  await expect(linha).toBeVisible();
  await expect(linha).toContainText('Rascunho');
  await expect(linha).toContainText('Melhor extrato'); // selo do tipo na lista

  // reabrir: tudo o que foi digitado voltou
  await linha.getByRole('link').click();
  await page.waitForURL('**/campanhas/*/editar');
  await expect(page.getByRole('radio', { name: /Melhor extrato/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'turnos válidos' })).toBeChecked();
  await expect(page.getByLabel('Mínimo de turnos para entrar no ranking')).toHaveValue('2');
  await expect(page.getByLabel(`Mínimo no turno (%) — ${R.aceitacao}`, { exact: true })).toHaveValue('90');
  await expect(page.getByLabel(`Mínimo no turno (%) — ${R.tempo}`, { exact: true })).toHaveValue('70');
  const cats2 = page.getByRole('group', { name: 'Categorias do faturamento' });
  await expect(cats2.getByRole('button', { name: /^Corridas/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(cats2.getByRole('button', { name: /^Promoção/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('Nome da campanha').fill(NOME_EXTRATO);

  await page.getByRole('button', { name: 'Revisar e lançar' }).click();
  const dialogo = page.getByRole('dialog');
  await expect(dialogo.getByText(`Lançar “${NOME_EXTRATO}”?`)).toBeVisible();
  await expect(dialogo.getByText('Critério do turno')).toBeVisible();
  await expect(dialogo.getByText('Valor do turno')).toBeVisible();
  await expect(dialogo.getByText(/mín\. 2 turnos válidos/)).toBeVisible();
  const botaoLancar = dialogo.getByRole('button', { name: 'Lançar campanha' });
  await expect(botaoLancar).toBeDisabled();
  await dialogo.getByText(/Revisei tudo e entendo/).click();
  await botaoLancar.click();

  await page.waitForURL(/\/hub\/dashboard\/campanhas\/\d+$/);
  await expect(page.getByRole('heading', { level: 1, name: NOME_EXTRATO })).toBeVisible();
  await expect(page.getByText('Imutável desde então.')).toBeVisible();
  const id = await campanhaIdPorNome(page, NOME_EXTRATO);
  const det = JSON.parse((await apiHub(page, 'GET', `/hub/campanhas/${id}`)).texto);
  expect(det.tipo).toBe('extrato');
  expect(det.minTurnosBase).toBe('validos');
  expect(det.categorias).toEqual(['Corridas', 'familia:promocao']);
});
