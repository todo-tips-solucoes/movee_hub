// impeccable rodada 14 (h3=2) — o trabalho da pessoa sobrevive à ida ao
// detalhe.
//
// O unit prova o hook isolado; só o browser prova a corrente inteira:
// filtrar → navegar → voltar → a lista volta filtrada. É nessa corrente que
// estava o defeito, e cada elo dela é de um arquivo diferente (o hook, o
// `<Link>` da lista, o botão "Voltar" do detalhe).
import { test, expect, type Page } from '@playwright/test';
import { ADMIN_STATE } from './global-setup';

const MOTORISTAS = [
  { id: 1, nome: 'Ana Silva', idExterno: '11111111-1111-1111-1111-111111111111', ativo: true },
  { id: 2, nome: 'Bruno Costa', idExterno: '22222222-2222-2222-2222-222222222222', ativo: true },
];

/** A base do ambiente de teste está vazia; sem linhas não há detalhe a abrir. */
async function mockarMotoristas(page: Page) {
  await page.route('**/api/v1/motoristas**', async (rota) => {
    const url = new URL(rota.request().url());
    if (/\/motoristas\/\d+$/.test(url.pathname)) {
      await rota.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...MOTORISTAS[0], vinculo: null, criadoEm: '2026-01-01T00:00:00Z' }),
      });
      return;
    }
    const nome = url.searchParams.get('nome')?.toLowerCase() ?? '';
    const items = MOTORISTAS.filter((m) => m.nome.toLowerCase().includes(nome));
    await rota.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items, total: items.length, page: 1, pageSize: 20 }),
    });
  });
}

test.describe('impeccable rodada 14 — o filtro sobrevive ao detalhe', () => {
  test.use({ storageState: ADMIN_STATE, viewport: { width: 1280, height: 800 } });

  test('filtrar põe o filtro na URL — o link fica compartilhável', async ({ page }) => {
    await mockarMotoristas(page);
    await page.goto('/hub/dashboard/motoristas');
    await page.waitForLoadState('networkidle');

    await page.getByLabel(/nome/i).first().fill('Ana');
    await expect(page).toHaveURL(/nome=Ana/, { timeout: 5000 });
    await expect(page.getByText('Bruno Costa')).toHaveCount(0);
  });

  test('abrir a URL filtrada já traz a lista filtrada', async ({ page }) => {
    await mockarMotoristas(page);
    await page.goto('/hub/dashboard/motoristas?nome=Ana');
    await page.waitForLoadState('networkidle');

    // A tela renderiza DUAS árvores (cards no mobile, tabela no desktop) e
    // esconde uma por CSS; `getByText(...).first()` pega a escondida. Neste
    // viewport quem vale é a célula da tabela.
    await expect(page.getByRole('cell', { name: 'Ana Silva', exact: true })).toBeVisible();
    await expect(page.getByText('Bruno Costa')).toHaveCount(0);
    // O campo precisa refletir o filtro: lista filtrada com campo vazio é uma
    // tela que mente sobre o próprio estado.
    await expect(page.getByLabel(/nome/i).first()).toHaveValue('Ana');
  });

  test('recarregar a página mantém o filtro — antes, F5 zerava o trabalho', async ({ page }) => {
    // Este é o caso que a URL resolve de verdade. O "voltar do detalhe" da
    // crítica NÃO reproduziu: o App Router preserva o estado do segmento na
    // navegação client-side, então o filtro já voltava sozinho, com ou sem
    // este hook (medido nas duas versões). Recarregar, não.
    await mockarMotoristas(page);
    await page.goto('/hub/dashboard/motoristas');
    await page.waitForLoadState('networkidle');

    await page.getByLabel(/nome/i).first().fill('Ana');
    await expect(page).toHaveURL(/nome=Ana/, { timeout: 5000 });

    await page.reload();
    await page.waitForLoadState('networkidle');

    await expect(page.getByLabel(/nome/i).first()).toHaveValue('Ana');
    await expect(page.getByText('Bruno Costa')).toHaveCount(0);
  });
});
