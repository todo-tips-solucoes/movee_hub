// Fase 3 (d) + parte do aviso (f): app do motorista. Login -> card na Início com a posição -> tela da
// campanha (pódio, top 10 com nome ABREVIADO, indicadores). Privacidade: nenhum sobrenome completo de
// terceiro aparece no DOM nem no JSON da API. Um 2º motorista (abaixo do corte) vê "fora do ranking"
// com nota hipotética. A notificação de início (criada pelo driver via hub_campanhas_avisar_inicio)
// aparece na central com link /campanhas/<id> clicável.
import { test, expect } from '@playwright/test';
import { APP, env, loginApp } from './_comum';

// sobrenomes dos TERCEIROS vistos por quem loga como Eva (4ª) — nenhum pode vazar
const SOBRENOMES_DE_TERCEIROS = ['Ribeiro', 'Santos', 'Teixeira', 'Souza', 'Moreira', 'Dias', 'Oliveira', 'Pinto', 'Prado'];

test('d) classificada: card na Início, tela da campanha, pódio, top 10 abreviado, indicadores', async ({ page }) => {
  const id = env('CAMP_ID');
  await loginApp(page, env('CAMP_MOT_A_CNPJ'), env('CAMP_MOT_SENHA'));
  await page.goto(`${APP}/movimento`);

  // card da Início: posição 4º de 4
  const card = page.getByRole('link', { name: /Rei do Jantar E2E/ });
  await expect(card).toBeVisible();
  await expect(card).toContainText('4º');
  await expect(card).toContainText('de 4 motoristas');
  await expect(card).toContainText('Ver ranking');
  expect(await card.getAttribute('href')).toBe(`/campanhas/${id}`);
  await card.click();
  await page.waitForURL(`**/campanhas/${id}`);

  await expect(page.getByRole('heading', { level: 1, name: 'Rei do Jantar E2E' })).toBeVisible();
  const minha = page.getByRole('region', { name: 'Minha posição' });
  await expect(minha).toBeVisible();
  await expect(minha).toContainText('4º');

  // pódio (1º–3º) e top 10 com nome + inicial
  const podio = page.getByRole('region', { name: 'Pódio' });
  await expect(podio).toBeVisible();
  for (const abrev of ['Aline S.', 'Bruno S.', 'Carla M.']) await expect(podio).toContainText(abrev);
  const top = page.getByRole('region', { name: /Top 10/ });
  await expect(top).toBeVisible();
  await expect(top).toContainText(/Você|Eva L\./); // a própria linha pode vir como "Você"

  // seus indicadores (leituras: aceitação 80,0%; conclusão 100,0%; tempo 90,0%; pedidos 8)
  const meus = page.getByRole('region', { name: /Seus indicadores|Meus indicadores/ });
  await expect(meus).toBeVisible();
  await expect(page.getByRole('meter')).toHaveCount(4);

  // PRIVACIDADE: nenhum sobrenome completo de terceiro no texto, no HTML nem no JSON da API
  const html = await page.content();
  const texto = await page.locator('body').innerText();
  for (const s of SOBRENOMES_DE_TERCEIROS) {
    expect(texto, `sobrenome "${s}" no texto visível`).not.toContain(s);
    expect(html, `sobrenome "${s}" no HTML`).not.toContain(s);
  }
  const api = await page.evaluate(async (cid) => {
    const r = await fetch(`/api/motorista/campanhas/${cid}`, { credentials: 'include' });
    return { status: r.status, texto: await r.text() };
  }, id);
  expect(api.status).toBe(200);
  for (const s of SOBRENOMES_DE_TERCEIROS) expect(api.texto, `sobrenome "${s}" no JSON do app`).not.toContain(s);
  const lista = await page.evaluate(async () => (await fetch('/api/motorista/campanhas', { credentials: 'include' })).text());
  for (const s of SOBRENOMES_DE_TERCEIROS) expect(lista).not.toContain(s);
});

test('d) abaixo do corte: "fora do ranking" com nota hipotética e o que fazer', async ({ page }) => {
  const id = env('CAMP_ID');
  await loginApp(page, env('CAMP_MOT_B_CNPJ'), env('CAMP_MOT_SENHA'));
  await page.goto(`${APP}/movimento`);
  const card = page.getByRole('link', { name: /Rei do Jantar E2E/ });
  await expect(card).toContainText('Fora do ranking por enquanto');
  await card.click();
  await page.waitForURL(`**/campanhas/${id}`);

  const sit = page.getByRole('region', { name: 'Sua situação' });
  await expect(sit.getByRole('heading', { name: 'Você está fora do ranking por enquanto' })).toBeVisible();
  await expect(sit).toContainText('Sua nota seria');
  await expect(sit).toContainText('77,3');
  await expect(sit).toContainText('5º lugar');
  // K = ceil((0,8*10 - 7)/(1-0,8)) = 5 corridas
  await expect(sit).toContainText('aceite as próximas 5 corridas');
  // ele também não vê sobrenome de ninguém
  const texto = await page.locator('body').innerText();
  for (const s of ['Ribeiro', 'Teixeira', 'Moreira', 'Santos', 'Souza']) expect(texto).not.toContain(s);
});

test('f) notificação de início na central, com link /campanhas/<id> clicável', async ({ page }) => {
  const id = env('CAMP_ID');
  await loginApp(page, env('CAMP_MOT_A_CNPJ'), env('CAMP_MOT_SENHA'));
  await page.goto(`${APP}/notificacoes`);
  await expect(page.getByRole('heading', { name: 'Notificações' })).toBeVisible();
  const item = page.locator(`a[href="/campanhas/${id}"]`).first();
  await expect(item).toBeVisible();
  await expect(item).toContainText('Nova campanha');
  await expect(item).toContainText('Rei do Jantar E2E');
  await item.click();
  await page.waitForURL(`**/campanhas/${id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Rei do Jantar E2E' })).toBeVisible();
});
