// Fase 10 (0133): parametrização das campanhas, ponta a ponta. O driver semeou, com "hoje" real do banco (T):
// turno MADRUGADA 02H-06H em T-2, T-1 e T para 4 motoristas — Aline (subpraça vazia + origem "ZONA SUL E2E"),
// Bruno (subpraça e origem vazias -> LIVRE), Carla (subpraça só espaços -> LIVRE; em T-1 um turno de 3 min zerado),
// Eva (subpraça SAO PAULO) — e um crédito "Corridas" só para o Bruno em T-2.
//   a) opções de praça mostram a origem e "LIVRE"; Performance do hub mostra e filtra o mesmo valor
//   b) descarte: campo vem com 5; turno de 3 min não conta (Carla 2 turnos); com 0 conta (3)
//   c) nota com categorias: o turno sem lançamento casado não conta (só o Bruno, 1 turno)
//   d) lançar em andamento: início no passado, aviso no diálogo, ranking já nasce pronto
//   e) data do prêmio no formulário; "Alterar data" para quem tem campanhas.gerir; quem só consulta não vê o botão
import { test, expect, type Locator, type Page } from '@playwright/test';
import { ROTULO_INDICADOR_CAMPANHA } from '../../lib/hub/campanhas-dto';
import {
  HUB, NOME_PARAM_CATS, NOME_PARAM_DESC0, NOME_PARAM_LIVRE, TURNO_PARAM,
  apiHub, campanhaIdPorPrefixo, ddmm, definirVisibilidade, env, loginHub, somaDias,
} from './_comum';

const R = ROTULO_INDICADOR_CAMPANHA;

async function marcar(page: Page, legenda: RegExp, texto: string) {
  await page.getByRole('group', { name: legenda }).locator('label', { hasText: new RegExp(`^${texto}$`) }).click();
}

/** Texto da célula da coluna `coluna` (pelo cabeçalho) de uma linha do ranking. */
async function celula(page: Page, linha: Locator, coluna: string): Promise<string> {
  const cabs = await page.locator('thead th').allInnerTexts();
  const i = cabs.findIndex((c) => c.trim() === coluna);
  expect(i, `coluna ${coluna} no cabeçalho ${JSON.stringify(cabs)}`).toBeGreaterThanOrEqual(0);
  return (await linha.locator('td, th').nth(i).innerText()).trim();
}

/** Formulário da nota até o ponto comum: período, praça LIVRE, turno da seed, MOTO, só aceitação (peso 100), 1 faixa. */
async function preencherNota(page: Page, nome: string, ini: string, fim: string) {
  await page.goto(`${HUB}/hub/dashboard/campanhas/nova`);
  await page.getByLabel('Nome da campanha').fill(nome);
  await page.getByLabel(/Regras e descrição/).fill('E2E parametrização.');
  await page.getByLabel('Início', { exact: true }).fill(ini);
  await page.getByLabel('Fim', { exact: true }).fill(fim);
  await marcar(page, /^Praças/, 'LIVRE');
  await marcar(page, /^Turnos/, TURNO_PARAM);
  await marcar(page, /^Modal/, 'MOTO');
  await page.getByLabel(/Mínimo de turnos trabalhados/).fill('1');
  await page.getByText(R.aceitacao, { exact: true }).first().click();
  await page.getByLabel(`Peso (%) — ${R.aceitacao}`).fill('100');
  await expect(page.getByText('Soma dos pesos: 100%')).toBeVisible();
}

async function faixaObjeto(page: Page, descricao: string) {
  await page.getByRole('button', { name: 'Adicionar faixa' }).click();
  await page.getByLabel('Descrição do prêmio').nth(0).fill(descricao);
}

/** "Revisar e lançar" -> caixa -> "Lançar campanha"; devolve o id lido da URL do detalhe. */
async function lancar(page: Page, nome: string, comAviso?: RegExp): Promise<number> {
  await page.getByRole('button', { name: 'Revisar e lançar' }).click();
  const dialogo = page.getByRole('dialog');
  await expect(dialogo.getByText(`Lançar “${nome}”?`)).toBeVisible();
  if (comAviso) await expect(dialogo.getByText(comAviso)).toBeVisible();
  await dialogo.getByText(/Revisei tudo e entendo/).click();
  await dialogo.getByRole('button', { name: 'Lançar campanha' }).click();
  await page.waitForURL(/\/hub\/dashboard\/campanhas\/\d+$/);
  await expect(page.getByRole('heading', { level: 1, name: nome })).toBeVisible();
  return Number(page.url().match(/campanhas\/(\d+)$/)![1]);
}

test.describe.serial('campanhas — parametrização (0133)', () => {
  test('a) Performance do hub mostra e filtra a subpraça efetiva (origem e LIVRE)', async ({ page }) => {
    await loginHub(page, env('CAMP_ADMIN_EMAIL'), env('CAMP_ADMIN_SENHA'));
    await page.goto(`${HUB}/hub/dashboard/performance`);
    // a API de áreas (que alimenta o filtro) já devolve o valor efetivo
    const ra = await apiHub(page, 'GET', '/performance/areas');
    expect(ra.status, ra.texto).toBe(200);
    const areas = JSON.parse(ra.texto).areas as string[];
    expect(areas).toEqual(expect.arrayContaining(['LIVRE', 'ZONA SUL E2E']));
    const filtro = page.getByRole('combobox', { name: 'Subpraça' });
    await filtro.click();
    await expect(page.getByRole('option', { name: 'ZONA SUL E2E', exact: true })).toBeVisible();
    await page.getByRole('option', { name: 'LIVRE', exact: true }).click();

    const turnos = page.getByRole('row').filter({ hasText: TURNO_PARAM });
    await expect(turnos).toHaveCount(6); // Bruno x3 + Carla x3 (inclui o turno de 3 min: Performance mostra o dado bruto)
    for (const n of [0, 1, 2, 3, 4, 5]) await expect(turnos.nth(n)).toContainText('LIVRE');
    await expect(turnos.filter({ hasText: 'Bruno Teixeira Souza' })).toHaveCount(3);
    await expect(turnos.filter({ hasText: 'Carla Dias Moreira' })).toHaveCount(3);
    await expect(page.getByText('Aline Ribeiro Santos')).toHaveCount(0);

    await filtro.click();
    await page.getByRole('option', { name: 'ZONA SUL E2E', exact: true }).click();
    await expect(turnos).toHaveCount(3);
    await expect(turnos.filter({ hasText: 'Aline Ribeiro Santos' })).toHaveCount(3);
    for (const n of [0, 1, 2]) await expect(turnos.nth(n)).toContainText('ZONA SUL E2E');
  });

  test('a, b, d, e) campanha na praça LIVRE: descarte 5, data do prêmio, lançar em andamento, ranking pronto', async ({ page }, testInfo) => {
    const T = env('CAMP_T');
    const nome = NOME_PARAM_LIVRE + (testInfo.retry ? ` r${testInfo.retry}` : '');
    await loginHub(page, env('CAMP_ADMIN_EMAIL'), env('CAMP_ADMIN_SENHA'));
    await page.goto(`${HUB}/hub/dashboard/campanhas/nova`);

    // a) as opções de praça da campanha: a origem e "LIVRE" (subpraça vazia), ao lado das praças de sempre
    const pracas = page.getByRole('group', { name: /^Praças/ });
    for (const p of ['LIVRE', 'ZONA SUL E2E', 'SAO PAULO', 'CAMPINAS']) {
      await expect(pracas.locator('label', { hasText: new RegExp(`^${p}$`) })).toBeVisible();
    }
    // b) o campo de descarte vem com 5
    await expect(page.getByLabel(/Descartar turnos de até/)).toHaveValue('5');

    await preencherNota(page, nome, somaDias(T, -2), T);
    await faixaObjeto(page, 'Bag E2E');
    await page.getByRole('button', { name: 'Adicionar faixa' }).click();
    await page.getByLabel('Até a posição').nth(1).fill('2');
    await page.getByRole('combobox', { name: 'Tipo do prêmio' }).nth(1).click();
    await page.getByRole('option', { name: 'Dinheiro' }).click();
    await page.getByLabel('Descrição do prêmio').nth(1).fill('R$ 50 no repasse');
    await page.getByLabel('Valor por pessoa (R$)').fill('50,00');
    // e) data do prêmio no formulário
    await page.getByLabel(/Data de pagamento\/entrega do prêmio/).fill(somaDias(T, 5));

    // d) início no passado: o diálogo avisa e deixa lançar
    const id = await lancar(page, nome, new RegExp(`Esta campanha começou em ${ddmm(somaDias(T, -2))}`));

    // o detalhe mostra as regras novas
    await expect(page.getByText('Turnos de até 5 min sem corridas não contam')).toBeVisible();
    await expect(page.getByText(ddmm(somaDias(T, 5))).first()).toBeVisible();
    // d) o ranking já nasceu, SEM importação nova: Bruno (3 turnos) e Carla (2: o de 3 min zerado não conta)
    const linhas = page.locator('tbody tr');
    await expect(linhas).toHaveCount(2);
    await expect(linhas.nth(0)).toContainText('Bruno Teixeira Souza');
    expect(await celula(page, linhas.nth(0), 'Turnos')).toBe('3');
    await expect(linhas.nth(1)).toContainText('Carla Dias Moreira');
    expect(await celula(page, linhas.nth(1), 'Turnos')).toBe('2');
    await expect(page.getByText('Aline Ribeiro Santos')).toHaveCount(0); // ZONA SUL
    await expect(page.getByText('Eva Costa Lima')).toHaveCount(0); // SAO PAULO
    await definirVisibilidade(page, true); // o app só a vê com o interruptor ligado

    // e) "Alterar data": diálogo, nova data, toast e detalhe atualizado
    await page.getByRole('button', { name: 'Alterar data' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByText('Data de pagamento/entrega do prêmio')).toBeVisible();
    await expect(dlg.getByLabel('Nova data')).toHaveValue(somaDias(T, 5));
    await dlg.getByLabel('Nova data').fill(somaDias(T, 6));
    await dlg.getByRole('button', { name: 'Salvar' }).click();
    await expect(dlg).toBeHidden();
    await expect(page.getByText(ddmm(somaDias(T, 6))).first()).toBeVisible();
    const det = JSON.parse((await apiHub(page, 'GET', `/hub/campanhas/${id}`)).texto);
    expect(det.dataPremio).toBe(somaDias(T, 6));
    expect(det.descarteTurnoMin).toBe(5);
  });

  test('b) descarte 0: o turno de 3 min zerado passa a contar', async ({ page }, testInfo) => {
    const T = env('CAMP_T');
    const nome = NOME_PARAM_DESC0 + (testInfo.retry ? ` r${testInfo.retry}` : '');
    await loginHub(page, env('CAMP_ADMIN_EMAIL'), env('CAMP_ADMIN_SENHA'));
    await preencherNota(page, nome, somaDias(T, -2), somaDias(T, 3));
    await page.getByLabel(/Descartar turnos de até/).fill('0');
    await faixaObjeto(page, 'Bag E2E');
    await lancar(page, nome);
    await expect(page.getByText('Nenhum turno descartado')).toBeVisible();
    const linhas = page.locator('tbody tr');
    await expect(linhas).toHaveCount(2);
    await expect(linhas.nth(0)).toContainText('Bruno Teixeira Souza');
    expect(await celula(page, linhas.nth(0), 'Turnos')).toBe('3');
    await expect(linhas.nth(1)).toContainText('Carla Dias Moreira');
    expect(await celula(page, linhas.nth(1), 'Turnos')).toBe('3');
  });

  test('c) nota com categorias: só conta o turno com lançamento casado', async ({ page }, testInfo) => {
    const T = env('CAMP_T');
    const nome = NOME_PARAM_CATS + (testInfo.retry ? ` r${testInfo.retry}` : '');
    await loginHub(page, env('CAMP_ADMIN_EMAIL'), env('CAMP_ADMIN_SENHA'));
    await preencherNota(page, nome, somaDias(T, -2), somaDias(T, 3));
    // sem categoria: a frase de sempre (nota fecha 1 dia depois); com categoria: a nova, sem os "~97%" do extrato
    await expect(page.getByText(/Os dados chegam com 1 dia de atraso/)).toBeVisible();
    const cats = page.getByRole('group', { name: 'Categorias do faturamento' });
    await cats.getByRole('button', { name: /^Corridas/ }).click();
    await expect(cats.getByRole('button', { name: /^Corridas/ })).toHaveAttribute('aria-pressed', 'true');
    const frase = page.locator('p', { hasText: /Com lançamentos selecionados, a apuração termina 3 dias depois/ });
    await expect(frase).toContainText(`3 dias depois do fim (${ddmm(somaDias(T, 3 + 3))})`);
    await expect(frase).toContainText('para o faturamento dos últimos dias entrar.');
    await expect(page.getByText(/97% do valor/)).toHaveCount(0);
    await faixaObjeto(page, 'Bag E2E');
    await page.getByRole('button', { name: 'Salvar rascunho' }).click();
    await page.waitForURL('**/hub/dashboard/campanhas');
    await page.getByRole('row', { name: new RegExp(nome) }).getByRole('link').click();
    await page.waitForURL('**/campanhas/*/editar');
    await expect(page.getByRole('group', { name: 'Categorias do faturamento' }).getByRole('button', { name: /^Corridas/ }))
      .toHaveAttribute('aria-pressed', 'true');
    await lancar(page, nome);

    await expect(page.getByText('Lançamentos exigidos no turno')).toBeVisible();
    const linhas = page.locator('tbody tr');
    await expect(linhas).toHaveCount(1); // só o Bruno tem crédito casado (T-2); a Carla não tem nenhum
    await expect(linhas.nth(0)).toContainText('Bruno Teixeira Souza');
    expect(await celula(page, linhas.nth(0), 'Turnos')).toBe('1');
    await expect(page.getByText('Carla Dias Moreira')).toHaveCount(0);
  });

  test('e) quem só consulta não vê "Alterar data"', async ({ page }) => {
    await loginHub(page, env('CAMP_RO_EMAIL'), env('CAMP_ADMIN_SENHA'));
    const id = await campanhaIdPorPrefixo(page, NOME_PARAM_LIVRE);
    await page.goto(`${HUB}/hub/dashboard/campanhas/${id}`);
    await expect(page.getByRole('heading', { level: 1, name: new RegExp(NOME_PARAM_LIVRE) })).toBeVisible();
    await expect(page.getByText('Data do prêmio', { exact: true })).toBeVisible();
    await expect(page.getByText(ddmm(somaDias(env('CAMP_T'), 6))).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Alterar data' })).toHaveCount(0);
    // e a API recusa a troca (403) — o botão ausente não é a única barreira
    const r = await apiHub(page, 'PATCH', `/hub/campanhas/${id}/data-premio`, { dataPremio: somaDias(env('CAMP_T'), 9) });
    expect(r.status).toBe(403);
  });
});
