// impeccable rodada 16 (h7=2) — ordenação server-side nas listas do hub.
//
// A ordem correta da resposta já é provada contra o backend REAL pelos drivers
// `hub-motoristas-integration.sh` e `hub-importacoes-integration.sh` (inclusive
// a allowlist barrando injeção no `order` do PostgREST). O que só o browser
// prova é a corrente daqui até lá: o clique vira parâmetro na REQUISIÇÃO e na
// URL, e o cabeçalho declara a ordem vigente.
//
// Por isso os casos abaixo interceptam a chamada em vez de conferir a ordem
// das linhas: conferir linhas aqui testaria de novo o backend, e com a base de
// teste vazia não testaria nada.
import { test, expect, type Page } from '@playwright/test';
import { ADMIN_STATE } from './global-setup';

/**
 * Guarda as URLs que a tela pediu E devolve uma lista fixa. O mock é
 * necessário porque a base do ambiente de teste está vazia: sem linhas a tela
 * mostra o estado vazio e não existe cabeçalho para clicar. O que este spec
 * prova continua sendo real — quem monta a query é o app.
 */
function interceptar(page: Page, padrao: string, itens: unknown[]) {
  const urls: string[] = [];
  page.route(padrao, async (rota) => {
    urls.push(rota.request().url());
    await rota.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: itens, total: itens.length, page: 1, pageSize: 20 }),
    });
  });
  return urls;
}

const MOTORISTAS = [
  { id: 1, nome: 'Ana Silva', ativo: true, comVinculo: false, areas: ['Centro'], idExterno: null },
  { id: 2, nome: 'Bruno Costa', ativo: false, comVinculo: true, areas: ['Zona Sul'], idExterno: null },
];

const IMPORTACOES = [
  {
    id: 1,
    tipo: 'faturamento',
    status: 'completed',
    nomeArquivo: 'abril.csv',
    totalLinhas: 10,
    linhasValidas: 10,
    linhasInvalidas: 0,
    dataReferencia: '2026-04-30',
    criadoPor: 1,
    iniciadoEm: '2026-05-01T10:00:00Z',
    concluidoEm: '2026-05-01T10:01:00Z',
    duracaoSegundos: 60,
    aguardandoLock: false,
  },
];

test.describe('impeccable rodada 16 — a lista pede a ordem ao backend', () => {
  test.use({ storageState: ADMIN_STATE, viewport: { width: 1440, height: 900 } });

  test('motoristas: clicar em Nome manda ordenarPor e direcao na requisição', async ({ page }) => {
    const chamadas = interceptar(page, '**/api/v1/motoristas?*', MOTORISTAS);
    await page.goto('/hub/dashboard/motoristas');
    await page.waitForLoadState('networkidle');

    const nome = page.getByRole('columnheader', { name: /Nome/ });
    await expect(nome).toHaveAttribute('aria-sort', 'none');

    await page.getByRole('button', { name: /Nome/ }).click();
    await expect(nome).toHaveAttribute('aria-sort', 'ascending');
    await expect
      .poll(() => chamadas.some((u) => u.includes('ordenarPor=nome') && u.includes('direcao=asc')))
      .toBe(true);

    await page.getByRole('button', { name: /Nome/ }).click();
    await expect(nome).toHaveAttribute('aria-sort', 'descending');
    await expect
      .poll(() => chamadas.some((u) => u.includes('ordenarPor=nome') && u.includes('direcao=desc')))
      .toBe(true);
  });

  test('motoristas: a ordem entra na URL e sobrevive a recarregar', async ({ page }) => {
    // De graça, por a ordenação viajar junto dos filtros da r14.
    interceptar(page, '**/api/v1/motoristas?*', MOTORISTAS);
    await page.goto('/hub/dashboard/motoristas');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: /Situação/ }).click();
    await expect(page).toHaveURL(/ordenarPor=ativo/, { timeout: 5000 });

    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('columnheader', { name: /Situação/ })).toHaveAttribute(
      'aria-sort',
      'ascending'
    );
  });

  test('importações: o histórico ordena pelas colunas do contrato', async ({ page }) => {
    const chamadas = interceptar(page, '**/api/v1/importacoes?*', IMPORTACOES);
    await page.goto('/hub/dashboard/importacoes');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: /Arquivo/ }).click();
    await expect(page.getByRole('columnheader', { name: /Arquivo/ })).toHaveAttribute(
      'aria-sort',
      'ascending'
    );
    await expect
      .poll(() => chamadas.some((u) => u.includes('ordenarPor=nome_arquivo')))
      .toBe(true);
  });

  test('o terceiro clique remove a ordenação e volta ao padrão do backend', async ({ page }) => {
    interceptar(page, '**/api/v1/motoristas?*', MOTORISTAS);
    await page.goto('/hub/dashboard/motoristas');
    await page.waitForLoadState('networkidle');

    const nome = page.getByRole('columnheader', { name: /Nome/ });
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: /Nome/ }).click();

    await expect(nome).toHaveAttribute('aria-sort', 'none');
    // Sem parâmetro na URL: a ordem volta a ser a que o backend decide.
    await expect(page).not.toHaveURL(/ordenarPor=/);
  });
});
