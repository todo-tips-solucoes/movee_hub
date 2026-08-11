// impeccable rodada 15 (h7=2) — a tabela de envio em massa passa a ordenar.
//
// O caso que importa é o último: com mais linhas do que cabem numa página,
// ordenar tem de reordenar o CONJUNTO e trazer o menor valor global para a
// primeira página. Uma implementação que ordena depois de paginar passa nos
// dois primeiros casos e falha nesse — ela chamaria de "menor valor" o menor
// dos que já estavam à vista.
import { test, expect, type Page } from '@playwright/test';
import { ADMIN_STATE } from './global-setup';

// 120 linhas com valor decrescente: a página padrão mostra 100
// (`recordsPerPage` em `use-envio-massa`), então a de MENOR valor nasce fora
// da tela — que é a condição do caso decisivo lá embaixo.
const TOTAL = 120;
const LINHAS = Array.from({ length: TOTAL }, (_, i) => ({
  id: i + 1,
  number: String(i + 1).padStart(3, '0'),
  nome: `Motorista ${String.fromCharCode(65 + (i % 26))}${i}`,
  valor: TOTAL - i,
  cnpj_tomador: '00000000000191',
  cnpj_prestador: '00000000000272',
  mensagem1: '',
  mensagem2: '',
  retorno_envio_msg_1: null,
  retorno_envio_msg_2: null,
  tribnac: null,
  dCompet: null,
  numnota: null,
  nota_ok: null,
  data_emissao: null,
  erro_validacao: null,
  uuid: null,
  dt_inicial: '2026-08-01',
  dt_final: '2026-08-07',
  id_empresa: 1,
  created_at: '2026-08-07T00:00:00.000Z',
  mov_fechado: false,
  enviado: 'off',
}));

async function mockarMovimento(page: Page) {
  await page.route('**/api/envio-massa*', (rota) =>
    rota.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LINHAS) })
  );
  await page.route('**/api/process-status*', (rota) =>
    rota.fulfill({ status: 200, contentType: 'application/json', body: '{"active":false}' })
  );
}

/** Valores da coluna "Valor" das linhas visíveis, em ordem de tela. */
async function valoresNaTela(page: Page) {
  const textos = await page.locator('tbody tr td:nth-child(4)').allInnerTexts();
  return textos.map((t) => Number(t.replace(/[^\d,]/g, '').replace(',', '.')));
}

test.describe('impeccable rodada 15 — ordenação da tabela', () => {
  test.use({ storageState: ADMIN_STATE, viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await mockarMovimento(page);
    await page.goto('/hub/dashboard/envio_massa');
    await page.waitForLoadState('networkidle');
  });

  test('o cabeçalho declara a ordem para quem não vê o ícone', async ({ page }) => {
    const valor = page.getByRole('columnheader', { name: /Valor/ });
    await expect(valor).toHaveAttribute('aria-sort', 'none');

    await page.getByRole('button', { name: /Valor/ }).click();
    await expect(valor).toHaveAttribute('aria-sort', 'ascending');

    await page.getByRole('button', { name: /Valor/ }).click();
    await expect(valor).toHaveAttribute('aria-sort', 'descending');

    // Terceiro clique: caminho de volta à ordem de chegada dos dados.
    await page.getByRole('button', { name: /Valor/ }).click();
    await expect(valor).toHaveAttribute('aria-sort', 'none');
  });

  test('ordena as linhas visíveis de fato', async ({ page }) => {
    await page.getByRole('button', { name: /Valor/ }).click();
    const asc = await valoresNaTela(page);
    expect(asc).toEqual([...asc].sort((a, b) => a - b));

    await page.getByRole('button', { name: /Valor/ }).click();
    const desc = await valoresNaTela(page);
    expect(desc).toEqual([...desc].sort((a, b) => b - a));
  });

  test('ordena o CONJUNTO, não só a página à vista', async ({ page }) => {
    // Sem ordenação, a primeira página começa no maior valor e o menor está na
    // última página — invisível.
    const inicial = await valoresNaTela(page);
    expect(inicial[0]).toBe(TOTAL);
    expect(inicial, 'o menor valor precisa começar FORA da página').not.toContain(1);

    await page.getByRole('button', { name: /Valor/ }).click();

    const asc = await valoresNaTela(page);
    expect(asc[0], 'o menor valor do conjunto tem de subir para a 1ª página').toBe(1);
  });
});
