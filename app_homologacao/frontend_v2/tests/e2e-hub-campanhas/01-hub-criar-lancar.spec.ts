// Fase 1 (a, b): admin cria o rascunho pelo formulário com opções REAIS (vindas do banco), edita,
// abre "Revisar e lançar" (botão desabilitado até marcar a caixa) e lança. Depois: sem caminho de
// edição na UI e PUT direto na API devolve 409 CAMPANHA_IMUTAVEL. O driver confere o banco depois.
import { test, expect, type Page } from '@playwright/test';
import { ROTULO_INDICADOR_CAMPANHA } from '../../lib/hub/campanhas-dto';
import { HUB, NOME_CAMPANHA, apiHub, campanhaIdPorNome, env, loginHub, somaDias } from './_comum';

const R = ROTULO_INDICADOR_CAMPANHA;

/** Marca uma opção de um grupo (fieldset com <legend>) clicando no rótulo. */
async function marcar(page: Page, legenda: RegExp, texto: string) {
  const grupo = page.getByRole('group', { name: legenda });
  await grupo.locator('label', { hasText: new RegExp(`^${texto}$`) }).click();
}

async function ligarIndicador(page: Page, rotulo: string, peso: number) {
  await page.getByText(rotulo, { exact: true }).first().click();
  await page.getByLabel(`Peso (%) — ${rotulo}`).fill(String(peso));
}

test.describe.serial('campanhas — hub: criar, editar, lançar, imutável', () => {
  test('a) rascunho -> editar -> revisar e lançar (caixa obrigatória)', async ({ page }, testInfo) => {
    const HOJE = env('CAMP_HOJE');
    const FIM = somaDias(HOJE, 1);
    // retry cria outro rascunho: nome distinto no rascunho, o nome final vem da edição.
    const nomeRascunho = `${NOME_CAMPANHA} rascunho r${testInfo.retry}`;

    await loginHub(page, env('CAMP_ADMIN_EMAIL'), env('CAMP_ADMIN_SENHA'));

    // navegação do módulo: item "Campanhas" no menu (gated por módulo + permissão)
    await page.getByRole('link', { name: 'Campanhas', exact: true }).first().click();
    await page.waitForURL('**/hub/dashboard/campanhas');
    await page.goto(`${HUB}/hub/dashboard/campanhas/nova`);

    await page.getByLabel('Nome da campanha').fill(nomeRascunho);
    await page.getByLabel(/Regras e descrição/).fill('Quem mais pontuar no jantar leva o prêmio.');
    await page.getByLabel('Início', { exact: true }).fill(HOJE);
    await page.getByLabel('Fim', { exact: true }).fill(FIM);

    // opções reais (praça/turno/modal que existem em PerformanceTurno / Entregador)
    const praca = page.getByRole('group', { name: /^Praças/ });
    await expect(praca.locator('label', { hasText: /^SAO PAULO$/ })).toBeVisible();
    await expect(praca.locator('label', { hasText: /^CAMPINAS$/ })).toBeVisible();
    await marcar(page, /^Praças/, 'SAO PAULO');
    await marcar(page, /^Turnos/, 'JANTAR 18H-22H');
    await marcar(page, /^Modal/, 'MOTO');
    // modal "MOTO" deixa de fora quem não tem modal no cadastro: o aviso aparece com o número
    await expect(page.getByText(/ainda não têm modal no cadastro e ficam de fora/)).toContainText('1 motoristas');
    await page.getByLabel(/Mínimo de turnos trabalhados/).fill('1');

    // indicadores: os 4 ligados, pesos 30/30/20/20 (ligar sugere 100 / 10 / 10 / 10; depois ajusta)
    await ligarIndicador(page, R.aceitacao, 30);
    await ligarIndicador(page, R.conclusao, 30);
    await ligarIndicador(page, R.tempo, 20);
    await ligarIndicador(page, R.pedidos, 20);
    for (const [i, v] of [['aceitacao', 30], ['conclusao', 30], ['tempo', 20], ['pedidos', 20]] as const) {
      await page.getByLabel(`Peso (%) — ${R[i]}`).fill(String(v));
    }
    await expect(page.getByText('Soma dos pesos: 100%')).toBeVisible();
    await page.getByLabel(`Corte mínimo (%) — ${R.aceitacao}`).fill('80');

    // 2 faixas: 1º objeto; 2º e 3º dinheiro
    await page.getByRole('button', { name: 'Adicionar faixa' }).click();
    await page.getByLabel('Descrição do prêmio').nth(0).fill('Bag térmica Movee');
    await page.getByRole('button', { name: 'Adicionar faixa' }).click();
    await page.getByLabel('Até a posição').nth(1).fill('3');
    await page.getByRole('combobox', { name: 'Tipo do prêmio' }).nth(1).click();
    await page.getByRole('option', { name: 'Dinheiro' }).click();
    await page.getByLabel('Descrição do prêmio').nth(1).fill('R$ 100 no repasse');
    await page.getByLabel('Valor por pessoa (R$)').fill('100,00');

    await page.getByRole('button', { name: 'Salvar rascunho' }).click();
    await page.waitForURL('**/hub/dashboard/campanhas');
    const linha = page.getByRole('row', { name: new RegExp(nomeRascunho) });
    await expect(linha).toBeVisible();
    await expect(linha).toContainText('Rascunho');

    // EDITAR o rascunho (nome final + descrição)
    await linha.getByRole('link').click();
    await page.waitForURL('**/campanhas/*/editar');
    await expect(page.getByLabel('Nome da campanha')).toHaveValue(nomeRascunho);
    await expect(page.getByLabel('Valor por pessoa (R$)')).toHaveValue('100,00');
    await page.getByLabel('Nome da campanha').fill(NOME_CAMPANHA);
    await page.getByLabel(/Regras e descrição/).fill('Quem mais pontuar no jantar leva o prêmio (editado).');

    // Revisar e lançar: grava e abre o diálogo. Espera as opções (cobertura) recarregarem na edição:
    // clicar antes delas chegarem valida com cobertura nula e recusa o peso de pedidos (achado do E2E).
    await expect(page.getByText(/Cobertura do dado neste público: 100%/)).toBeVisible();
    await page.getByRole('button', { name: 'Revisar e lançar' }).click();
    const dialogo = page.getByRole('dialog');
    await expect(dialogo.getByText(`Lançar “${NOME_CAMPANHA}”?`)).toBeVisible();
    await expect(dialogo.getByText('Depois de lançada, a campanha não pode ser alterada.')).toBeVisible();
    const botaoLancar = dialogo.getByRole('button', { name: 'Lançar campanha' });
    await expect(botaoLancar).toBeDisabled();
    await dialogo.getByText(/Revisei tudo e entendo/).click();
    await expect(botaoLancar).toBeEnabled();
    // desmarcar volta a desabilitar (a trava é a caixa, não o primeiro clique)
    await dialogo.getByText(/Revisei tudo e entendo/).click();
    await expect(botaoLancar).toBeDisabled();
    await dialogo.getByText(/Revisei tudo e entendo/).click();
    await botaoLancar.click();

    await page.waitForURL(/\/hub\/dashboard\/campanhas\/\d+$/);
    await expect(page.getByRole('heading', { level: 1, name: NOME_CAMPANHA })).toBeVisible();
    await expect(page.getByText('Imutável desde então.')).toBeVisible();
    const id = await campanhaIdPorNome(page, NOME_CAMPANHA);
    expect(id).toBeGreaterThan(0);
  });

  test('b) lançada: sem caminho de edição na UI; PUT direto na API -> 409 CAMPANHA_IMUTAVEL', async ({ page }) => {
    await loginHub(page, env('CAMP_ADMIN_EMAIL'), env('CAMP_ADMIN_SENHA'));
    const id = await campanhaIdPorNome(page, NOME_CAMPANHA);

    // lista: a ação da linha lançada NÃO é "Editar" e leva ao detalhe, não ao /editar
    await page.goto(`${HUB}/hub/dashboard/campanhas`);
    const linha = page.getByRole('row', { name: new RegExp(NOME_CAMPANHA) });
    await expect(linha).toBeVisible();
    const link = linha.getByRole('link');
    await expect(link).not.toContainText(/Editar/);
    expect(await link.getAttribute('href')).toBe(`/hub/dashboard/campanhas/${id}`);

    // URL de edição digitada à mão: o formulário nunca aparece; volta para o detalhe
    await page.goto(`${HUB}/hub/dashboard/campanhas/${id}/editar`);
    await page.waitForURL(new RegExp(`/hub/dashboard/campanhas/${id}$`));
    await expect(page.getByLabel('Nome da campanha')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Salvar rascunho|Revisar e lançar/ })).toHaveCount(0);

    // PUT direto na API, com um corpo válido e nome diferente
    const det = await apiHub(page, 'GET', `/hub/campanhas/${id}`);
    expect(det.status).toBe(200);
    const d = JSON.parse(det.texto);
    const corpo = {
      nome: 'Tentativa de editar',
      descricao: d.descricao,
      dataInicio: d.dataInicio,
      dataFim: d.dataFim,
      pracas: d.pracas,
      turnos: d.turnos,
      modais: d.modais,
      minTurnos: d.minTurnos,
      pesos: d.pesos,
      cortes: d.cortes,
      premios: d.premios.map((p: Record<string, unknown>) => ({
        posicaoDe: p.posicaoDe, posicaoAte: p.posicaoAte, tipo: p.tipo, descricao: p.descricao, valorCentavos: p.valorCentavos,
      })),
      avisar: d.avisar,
    };
    const put = await apiHub(page, 'PUT', `/hub/campanhas/${id}`, corpo);
    expect(put.status).toBe(409);
    expect(put.texto).toContain('CAMPANHA_IMUTAVEL');
    // e o nome não mudou
    const depois = JSON.parse((await apiHub(page, 'GET', `/hub/campanhas/${id}`)).texto);
    expect(depois.nome).toBe(NOME_CAMPANHA);
  });
});
