// impeccable rodada 19 (h4) — os filtros passam a falar um idioma só.
//
// O unit cobre o componente e as telas, mas foi preciso seis iterações para
// fazer o Base UI responder em jsdom (click não seleciona, pointer events não
// selecionam, o `data-highlighted` não acompanha as setas). Quando o ambiente
// de teste mente tanto, a prova que vale é a do browser: aqui o filtro é
// aberto e escolhido como uma pessoa faria, e o efeito é conferido na
// requisição que sai.
import { test, expect, type Page } from '@playwright/test';
import { ADMIN_STATE } from './global-setup';

const MOTORISTAS = [
  { id: 1, nome: 'Ana Silva', ativo: true, comVinculo: false, areas: ['Centro'], idExterno: null },
  { id: 2, nome: 'Bruno Costa', ativo: false, comVinculo: true, areas: ['Zona Sul'], idExterno: null },
];

function interceptar(page: Page) {
  const urls: string[] = [];
  page.route('**/api/v1/motoristas?*', async (rota) => {
    urls.push(rota.request().url());
    await rota.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: MOTORISTAS, total: 2, page: 1, pageSize: 20 }),
    });
  });
  return urls;
}

test.describe('impeccable rodada 19 — filtros no idioma do design system', () => {
  test.use({ storageState: ADMIN_STATE, viewport: { width: 1280, height: 800 } });

  test('escolher no filtro de situação envia o valor e mostra o rótulo', async ({ page }) => {
    const chamadas = interceptar(page);
    await page.goto('/hub/dashboard/motoristas');
    await page.waitForLoadState('networkidle');

    const situacao = page.getByRole('combobox', { name: 'Situação' });
    await expect(situacao).toHaveText(/Todas/);

    await situacao.click();
    await page.getByRole('option', { name: 'Ativo', exact: true }).click();

    // O trigger passa a mostrar o RÓTULO, não o value cru — é o gotcha do
    // `items` do Base UI, que o componente único resolve num lugar só.
    await expect(situacao).toHaveText(/Ativo/);
    await expect.poll(() => chamadas.some((u) => u.includes('ativo=true'))).toBe(true);
  });

  test('não sobrou nenhum select nativo nas telas de filtro do hub', async ({ page }) => {
    // O sintoma que a crítica registrou era visual: dois idiomas de controle
    // na mesma navegação. Este caso mede a ausência do idioma antigo.
    for (const rota of [
      '/hub/dashboard/motoristas',
      '/hub/dashboard/importacoes',
      '/hub/dashboard/faturamento',
      '/hub/dashboard/performance',
    ]) {
      await page.goto(rota);
      await page.waitForLoadState('networkidle');
      const nativos = await page.locator('select:visible').count();
      expect(nativos, `${rota} ainda tem <select> nativo`).toBe(0);
    }
  });
});
