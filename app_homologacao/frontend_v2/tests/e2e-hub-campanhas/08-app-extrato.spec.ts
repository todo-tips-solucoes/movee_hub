// Fase 8 (extrato): app do motorista. Privacidade (X2/E7): o motorista vê o PRÓPRIO valor e os próprios
// turnos; ranking só com posição e nome abreviado; nenhum valor/turno de terceiro no DOM nem no JSON.
// A: Eva (3ª, R$ 70,00, 2 turnos válidos). B: Diego (4º, R$ 25,00: 1 válido, 1 que não valeu, 1 aguardando).
import { test, expect, type Page } from '@playwright/test';
import { APP, NOME_EXTRATO, env, loginApp } from './_comum';

const SOBRENOMES_DE_TERCEIROS = ['Ribeiro', 'Santos', 'Teixeira', 'Souza', 'Moreira', 'Dias'];
// valores de terceiros (centavos / texto): Aline 150, Bruno 120, Carla 60, Diego 25 e 500 (turno que não valeu)
const VALORES_ALHEIOS_TEXTO = ['R$ 150,00', 'R$ 120,00', 'R$ 60,00', 'R$ 500,00'];
const VALORES_ALHEIOS_CENTAVOS = [15000, 12000, 6000, 50000];
const CHAVE_DE_VALOR = /valor|centavo|nota|turnos|lido|minimo|motivo/i;

async function getJson(page: Page, caminho: string) {
  return page.evaluate(async (c) => {
    const r = await fetch(`/api/motorista${c}`, { credentials: 'include' });
    return { status: r.status, texto: await r.text() };
  }, caminho);
}

/** Todas as chaves de um objeto JSON, em qualquer profundidade. */
function chaves(o: unknown, acc: string[] = []): string[] {
  if (Array.isArray(o)) o.forEach((x) => chaves(x, acc));
  else if (o && typeof o === 'object')
    for (const [k, v] of Object.entries(o)) {
      acc.push(k);
      chaves(v, acc);
    }
  return acc;
}

test('A) classificada: "Seu extrato na campanha", ranking sem valor alheio, turnos só dela', async ({ page }) => {
  const id = env('CAMP_X_ID');
  await loginApp(page, env('CAMP_MOT_A_CNPJ'), env('CAMP_MOT_SENHA'));
  await page.goto(`${APP}/movimento`);
  const card = page.getByRole('link', { name: new RegExp(NOME_EXTRATO) });
  await expect(card).toBeVisible();
  expect(await card.getAttribute('href')).toBe(`/campanhas/${id}`);
  await page.goto(`${APP}/campanhas/${id}`);

  await expect(page.getByRole('heading', { level: 1, name: NOME_EXTRATO })).toBeVisible();
  const meu = page.getByRole('region', { name: 'Meu extrato' });
  await expect(meu).toBeVisible();
  await expect(meu).toContainText('3º');
  await expect(meu).toContainText('de 4');
  await expect(meu).toContainText('Seu extrato na campanha');
  await expect(meu).toContainText('R$ 70,00');
  await expect(meu).toContainText('2 turnos válidos');
  await expect(meu).toContainText('Na zona de prêmio: Vale-combustível');

  // pódio e top 10: só posição + nome abreviado ("Você" para ela mesma)
  const podio = page.getByTestId('podio');
  await expect(podio).toContainText('Aline S.');
  await expect(podio).toContainText('Bruno S.');
  await expect(podio).toContainText('Você');
  const top = page.getByTestId('top10');
  await expect(top).toContainText('Diego O.');

  // seus turnos: 2 válidos (✓), do mais recente ao mais antigo, sem turno de terceiro
  const turnos = page.getByRole('region', { name: 'Seus turnos' });
  const itens = turnos.locator('li');
  await expect(itens).toHaveCount(2);
  await expect(turnos.getByRole('img', { name: 'Turno válido' })).toHaveCount(2);
  await expect(itens.nth(0)).toContainText('R$ 30,00');
  await expect(itens.nth(1)).toContainText('R$ 40,00');
  await expect(itens.nth(0)).toContainText('Somou no seu extrato');

  // PRIVACIDADE no DOM/HTML
  const texto = await page.locator('body').innerText();
  const html = await page.content();
  for (const s of SOBRENOMES_DE_TERCEIROS) {
    expect(texto, `sobrenome ${s} no texto`).not.toContain(s);
    expect(html, `sobrenome ${s} no HTML`).not.toContain(s);
  }
  for (const v of VALORES_ALHEIOS_TEXTO) {
    expect(texto, `valor alheio ${v} no texto`).not.toContain(v);
    expect(html, `valor alheio ${v} no HTML`).not.toContain(v);
  }

  // PRIVACIDADE no JSON: top10/podio só com posicao + nomeAbreviado; fora de `eu`/`premios`/`campanha`,
  // nenhuma chave de valor/nota/turnos; nenhum valor de terceiro em lugar nenhum.
  const r = await getJson(page, `/campanhas/${id}`);
  expect(r.status).toBe(200);
  const j = JSON.parse(r.texto) as Record<string, unknown>;
  expect(Array.isArray(j.top10) && (j.top10 as unknown[]).length).toBeGreaterThan(0);
  for (const lista of [j.top10, j.podio]) {
    if (lista === undefined) continue;
    for (const linha of lista as Record<string, unknown>[]) expect(Object.keys(linha).sort()).toEqual(['nomeAbreviado', 'posicao']);
  }
  const { eu, premios: _p, campanha: _c, ...resto } = j;
  void _p; void _c;
  expect(chaves(resto).filter((k) => CHAVE_DE_VALOR.test(k)), 'chaves de valor fora de eu/premios/campanha').toEqual([]);
  expect((eu as { valorCentavos: number }).valorCentavos).toBe(7000);
  for (const v of VALORES_ALHEIOS_CENTAVOS) expect(r.texto, `centavos de terceiro ${v}`).not.toMatch(new RegExp(`\\b${v}\\b`));
  for (const s of SOBRENOMES_DE_TERCEIROS) expect(r.texto).not.toContain(s);

  // /turnos: só os dela, e um parâmetro de motorista na query é ignorado (identidade só pela sessão)
  const t1 = await getJson(page, `/campanhas/${id}/turnos`);
  const t2 = await getJson(page, `/campanhas/${id}/turnos?cnpj=${env('CAMP_MOT_B_CNPJ')}&entregadorId=1`);
  expect(t1.status).toBe(200);
  expect(t2.texto).toBe(t1.texto);
  const itensApi = (JSON.parse(t1.texto).itens ?? []) as { valorCentavos: number; valido: boolean }[];
  expect(itensApi.map((x) => x.valorCentavos).sort()).toEqual([3000, 4000]);
  expect(itensApi.every((x) => x.valido)).toBe(true);
  for (const v of VALORES_ALHEIOS_CENTAVOS) expect(t1.texto).not.toMatch(new RegExp(`\\b${v}\\b`));
});

test('B) turnos ✓ / ✕ / …: o que não valeu mostra o motivo e o valor que deixou de somar', async ({ page }) => {
  const id = env('CAMP_X_ID');
  await loginApp(page, env('CAMP_MOT_B_CNPJ'), env('CAMP_MOT_SENHA'));
  await page.goto(`${APP}/campanhas/${id}`);

  const meu = page.getByRole('region', { name: 'Meu extrato' });
  await expect(meu).toContainText('4º');
  await expect(meu).toContainText('R$ 25,00');
  await expect(meu).toContainText('2 turnos válidos');
  await expect(meu).toContainText('1 não valeu');

  const turnos = page.getByRole('region', { name: 'Seus turnos' });
  const itens = turnos.locator('li');
  await expect(itens).toHaveCount(3);
  // mais recente primeiro: D2 aguardando faturamento, D1 não valeu, D0 válido
  await expect(itens.nth(0).getByRole('img', { name: 'Aguardando faturamento' })).toBeVisible();
  await expect(itens.nth(0)).toContainText('Aguardando faturamento');
  await expect(itens.nth(1).getByRole('img', { name: 'Turno que não valeu' })).toBeVisible();
  await expect(itens.nth(1)).toContainText('Aceitação 70% (mínimo 90%)');
  await expect(itens.nth(1)).toContainText('R$ 500,00'); // o PRÓPRIO valor que deixou de somar
  await expect(itens.nth(2).getByRole('img', { name: 'Turno válido' })).toBeVisible();
  await expect(itens.nth(2)).toContainText('R$ 25,00');

  // valor de terceiro continua fora (o 500 é dele)
  const texto = await page.locator('body').innerText();
  for (const v of ['R$ 150,00', 'R$ 120,00', 'R$ 70,00', 'R$ 60,00']) expect(texto).not.toContain(v);
  for (const s of SOBRENOMES_DE_TERCEIROS) expect(texto).not.toContain(s);

  const t = await getJson(page, `/campanhas/${id}/turnos`);
  const api = JSON.parse(t.texto).itens as { valido: boolean; temValor: boolean; valorCentavos: number; motivos: { criterio: string }[] }[];
  expect(api).toHaveLength(3);
  expect(api.map((x) => [x.valido, x.temValor])).toEqual([[true, false], [false, true], [true, true]]);
  expect(api[1].motivos.map((m) => m.criterio)).toEqual(['aceitacao']);
});
