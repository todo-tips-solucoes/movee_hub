// impeccable rodada 7 — os P1 da crítica medida, verificados vivos contra o
// hub-homolog.
//
// Por que E2E e não só unit: os dois defeitos que a rodada 7 corrige na própria
// rodada 6 passaram por uma suíte unit verde. Cada superfície foi testada
// isolada — o texto do botão num teste, o texto do diálogo em outro — e a
// contradição entre elas só existe quando as duas estão na mesma tela, com a
// mesma seleção. É isso que estes casos exercitam.
import { test, expect, type Page } from '@playwright/test';
import { ADMIN_STATE } from './global-setup';

const ROTA = '/hub/dashboard/envio_massa';

// 12 linhas do mesmo período; a primeira já enviada, as demais pendentes.
const LINHAS = Array.from({ length: 12 }, (_, i) => ({
  id: i + 1,
  number: String(i + 1).padStart(3, '0'),
  nome: `Motorista ${String(i + 1).padStart(3, '0')}`,
  enviado: i === 0 ? 'ok' : 'off',
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
}));

async function marcarLinha(page: Page, nome: string) {
  await page.getByRole('row', { name: new RegExp(nome) }).getByRole('checkbox').click();
}

test.describe('impeccable rodada 7 — um número, uma verdade', () => {
  test.use({ storageState: ADMIN_STATE, viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await page.route('**/api/process-status*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ active: false }),
      })
    );
    await page.route('**/api/start-process*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    );
  });

  test('a barra e o diálogo dizem o MESMO número com seleção mista', async ({ page }) => {
    await page.route('**/api/envio-massa*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LINHAS) })
    );
    await page.goto(ROTA);

    await marcarLinha(page, 'Motorista 001'); // já enviada
    await marcarLinha(page, 'Motorista 003'); // pendente
    await marcarLinha(page, 'Motorista 004'); // pendente

    // 3 marcados, 2 pendentes. Na rodada 6 a barra dizia 3 e o confirm dizia 2.
    const botao = page.getByRole('button', { name: 'Disparar para 2' });
    await expect(botao).toBeVisible();
    await expect(page.getByRole('button', { name: 'Disparar para 3' })).toHaveCount(0);

    await botao.click();
    const dialogo = page.getByRole('alertdialog');
    await expect(dialogo.getByRole('button', { name: 'Disparar para 2' })).toBeVisible();
    await expect(dialogo).toContainText('1 já recebeu mensagem e será pulado');
  });

  test('seleção toda já enviada não volta a prometer o movimento inteiro', async ({ page }) => {
    await page.route('**/api/envio-massa*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LINHAS) })
    );
    await page.goto(ROTA);

    await marcarLinha(page, 'Motorista 001');
    // `selecionadosPendentes` é 0 — se o rótulo dependesse dele, o botão diria
    // "Iniciar" com uma linha marcada na tela.
    await expect(page.getByRole('button', { name: 'Disparar para 0' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Iniciar$/ })).toHaveCount(0);
  });

  test('o período do movimento aparece no cabeçalho e na confirmação do fechamento', async ({
    page,
  }) => {
    await page.route('**/api/envio-massa*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LINHAS) })
    );
    await page.goto(ROTA);

    await expect(page.getByText(/01\/08\/2026 a 07\/08\/2026/)).toBeVisible();

    await page.getByRole('button', { name: /^Fechar movimento$/ }).click();
    // A ação irreversível diz QUAL movimento vai lacrar.
    await expect(page.getByRole('alertdialog')).toContainText('01/08/2026 a 07/08/2026');
  });

  test('falha ao carregar não é desenhada como movimento vazio', async ({ page }) => {
    await page.route('**/api/envio-massa*', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Erro interno' }),
      })
    );
    await page.goto(ROTA);

    // Antes: "Nenhum registro encontrado — importe um arquivo XLSX".
    const alerta = page.getByRole('alert');
    await expect(alerta).toBeVisible();
    await expect(alerta.getByRole('button', { name: 'Tentar novamente' })).toBeVisible();
    await expect(page.getByText('Nenhum registro encontrado')).toHaveCount(0);

    // E o fechamento irreversível não pode ser confirmado sobre números que
    // não existem.
    await page.getByRole('button', { name: /^Fechar movimento$/ }).click();
    const dialogo = page.getByRole('alertdialog');
    await expect(dialogo).toContainText('não puderam ser carregados');
    await expect(dialogo.getByRole('button', { name: /^Fechar movimento$/ })).toBeDisabled();
  });

  test('poll que falha não declara "Parado" nem reabilita o disparo', async ({ page }) => {
    await page.route('**/api/envio-massa*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LINHAS) })
    );
    // Primeiro poll: ativo. Os seguintes falham.
    let chamadas = 0;
    await page.unroute('**/api/process-status*');
    await page.route('**/api/process-status*', (route) => {
      chamadas += 1;
      if (chamadas === 1) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ active: true }),
        });
      }
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    });

    await page.goto(ROTA);
    await expect(page.getByText(/Enviando —/)).toBeVisible();

    // O poll é de 13s; espera o suficiente para pelo menos um erro.
    await expect(page.getByText('Status indisponível — tentando de novo')).toBeVisible({
      timeout: 20000,
    });
    // O que mais importa: o botão de disparo NÃO reabilita durante a incerteza.
    await expect(page.getByRole('button', { name: /^Iniciar$/ })).toBeDisabled();
    await expect(page.getByText('Parado')).toHaveCount(0);
  });
});
