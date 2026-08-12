// impeccable rodada 20 (P1) — o fim do ciclo semanal deixa vestígio.
//
// O unit cobre os números; o que só o browser mostra é o que a pessoa vê
// DEPOIS de confirmar: a lista some, o toast some em 4s, e antes desta rodada
// o que sobrava era um estado vazio dizendo "Importe um arquivo XLSX" — como
// se o movimento nunca tivesse existido.
import { test, expect, type Page } from '@playwright/test';
import { ADMIN_STATE } from './global-setup';

const LINHAS = Array.from({ length: 12 }, (_, i) => ({
  id: i + 1,
  number: String(i + 1).padStart(3, '0'),
  nome: `Motorista ${i + 1}`,
  valor: 100,
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
  enviado: i < 9 ? 'ok' : i < 11 ? 'erro' : 'off',
}));

/** Antes de fechar a lista tem 12 linhas; depois, o backend devolve vazio. */
async function mockarMovimento(page: Page) {
  let fechado = false;
  await page.route('**/api/envio-massa*', (rota) =>
    rota.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(fechado ? [] : LINHAS),
    })
  );
  await page.route('**/api/process-status*', (rota) =>
    rota.fulfill({ status: 200, contentType: 'application/json', body: '{"active":false}' })
  );
  await page.route('**/api/close-movimento*', async (rota) => {
    fechado = true;
    await rota.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
}

test.describe('impeccable rodada 20 — recibo do fechamento', () => {
  test.use({ storageState: ADMIN_STATE, viewport: { width: 1280, height: 800 } });

  test('fechar deixa um recibo com os números do ciclo, e ele não some sozinho', async ({ page }) => {
    await mockarMovimento(page);
    await page.goto('/hub/dashboard/envio_massa');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: /Fechar movimento/ }).click();
    await page.getByRole('button', { name: /^Fechar movimento$/ }).last().click();

    const recibo = page.getByRole('status').filter({ hasText: 'Movimento fechado' });
    await expect(recibo).toBeVisible();
    await expect(recibo).toContainText('12');
    await expect(recibo).toContainText('9');
    await expect(recibo).toContainText('01/08/2026 a 07/08/2026');

    // A lista esvaziou (é o movimento novo), e o recibo é o que restou do
    // ciclo anterior — precisa sobreviver ao tempo do toast, que some em 4s.
    await page.waitForTimeout(5000);
    await expect(recibo).toBeVisible();
  });

  test('o recibo sai quando a pessoa manda sair, não antes', async ({ page }) => {
    await mockarMovimento(page);
    await page.goto('/hub/dashboard/envio_massa');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: /Fechar movimento/ }).click();
    await page.getByRole('button', { name: /^Fechar movimento$/ }).last().click();

    const recibo = page.getByRole('status').filter({ hasText: 'Movimento fechado' });
    await expect(recibo).toBeVisible();
    await recibo.getByRole('button', { name: /dispensar/i }).click();
    await expect(recibo).toHaveCount(0);
  });

  test('nenhum recibo anuncia sozinho — o canal vivo é do marco (r17)', async ({ page }) => {
    // Os dois recibos (disparo e fechamento) são `role="status"` com
    // `aria-live="off"`. Antes desta rodada o de disparo anunciava junto com a
    // região de marcos, dizendo o mesmo evento duas vezes.
    await mockarMovimento(page);
    await page.goto('/hub/dashboard/envio_massa');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: /Fechar movimento/ }).click();
    await page.getByRole('button', { name: /^Fechar movimento$/ }).last().click();

    const recibo = page.getByRole('status').filter({ hasText: 'Movimento fechado' });
    await expect(recibo).toHaveAttribute('aria-live', 'off');
  });
});
