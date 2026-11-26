// Fase 11 (0133): o driver fixou "hoje" em T+1 e fechou a campanha "Praça LIVRE E2E" (fim em T).
//   d) campanha cujo fim já passou no banco (a tela ainda está em T): o diálogo mostra a mensagem de FIM_NO_PASSADO
//   e) vencedores: sem "Pagamento em" antes da planilha; depois dela, a data (T+6 = data do prêmio) na linha do dinheiro
import { test, expect } from '@playwright/test';
import { HUB, NOME_PARAM_LIVRE, apiHub, baixar, campanhaIdPorPrefixo, ddmm, env, loginHub, somaDias } from './_comum';

const NOME_FIM = 'Fim no passado E2E';

test('d) lançar campanha cujo fim já passou -> mensagem de FIM_NO_PASSADO; nada é lançado', async ({ page }, testInfo) => {
  const T = env('CAMP_T');
  const nome = NOME_FIM + (testInfo.retry ? ` r${testInfo.retry}` : '');
  await loginHub(page, env('CAMP_ADMIN_EMAIL'), env('CAMP_ADMIN_SENHA'));
  const d = JSON.parse((await apiHub(page, 'GET', `/hub/campanhas/${await campanhaIdPorPrefixo(page, NOME_PARAM_LIVRE)}`)).texto);
  const criado = await apiHub(page, 'POST', '/hub/campanhas', {
    tipo: d.tipo, categorias: d.categorias, nome, descricao: d.descricao, dataInicio: d.dataInicio, dataFim: T,
    pracas: d.pracas, turnos: d.turnos, modais: d.modais, minTurnos: d.minTurnos, pesos: d.pesos, cortes: d.cortes,
    premios: d.premios.map((p: Record<string, unknown>) => ({
      posicaoDe: p.posicaoDe, posicaoAte: p.posicaoAte, tipo: p.tipo, descricao: p.descricao, valorCentavos: p.valorCentavos,
    })),
    descarteTurnoMin: d.descarteTurnoMin, dataPremio: null, avisar: false, visivelApp: false,
  });
  expect(criado.status).toBe(201);
  const id = JSON.parse(criado.texto).id as number;

  await page.goto(`${HUB}/hub/dashboard/campanhas/${id}/editar`);
  await page.getByRole('button', { name: 'Revisar e lançar' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByText(/Revisei tudo e entendo/).click();
  await dlg.getByRole('button', { name: 'Lançar campanha' }).click();
  await expect(dlg.getByRole('alert')).toContainText('A campanha já terminou. Para lançar, o fim precisa ser hoje ou depois.');
  const depois = JSON.parse((await apiHub(page, 'GET', `/hub/campanhas/${id}`)).texto);
  expect(depois.situacao).toBe('rascunho');
});

test('e) vencedores: "Pagamento em" aparece com a planilha, na data do prêmio', async ({ page }) => {
  const T = env('CAMP_T');
  await loginHub(page, env('CAMP_ADMIN_EMAIL'), env('CAMP_ADMIN_SENHA'));
  const id = await campanhaIdPorPrefixo(page, NOME_PARAM_LIVRE);
  await page.goto(`${HUB}/hub/dashboard/campanhas/${id}`);
  await expect(page.getByText('Encerrada').first()).toBeVisible();
  const vencedores = page.getByRole('region', { name: 'Vencedores' });
  const linhas = vencedores.locator('tbody tr');
  await expect(linhas).toHaveCount(2);
  await expect(linhas.nth(0)).toContainText('Bruno Teixeira Souza');
  await expect(linhas.nth(1)).toContainText('Carla Dias Moreira');
  await expect(linhas.nth(1)).toContainText('Aguardando a planilha');
  await expect(vencedores.getByRole('columnheader', { name: 'Pagamento em' })).toHaveCount(0);

  const resp = page.waitForResponse((r) => r.url().includes('/premios-dinheiro.xlsx'));
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Baixar planilha de prêmios em dinheiro' }).click(),
  ]);
  expect((await resp).headers()['x-premios-adiados']).toBe('0');
  await baixar(page, dl, id, '/dl/param-1.xlsx');

  await expect(vencedores.getByRole('columnheader', { name: 'Pagamento em' })).toBeVisible();
  await expect(linhas.nth(1)).toContainText('Na planilha de');
  // dinheiro: data do prêmio (T+6, no futuro); objeto: sem data de pagamento
  await expect(linhas.nth(1)).toContainText(ddmm(somaDias(T, 6)));
  await expect(linhas.nth(0).locator('td').nth(-2)).toHaveText('—');
});
