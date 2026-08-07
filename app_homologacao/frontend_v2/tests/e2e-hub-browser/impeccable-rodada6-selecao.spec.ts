// impeccable rodada 6 — disparo por seleção (P2 "checkboxes que não fazem
// nada"), verificado vivo contra o hub-homolog rebuildado.
//
// Os checkboxes marcavam linhas e nenhuma ação as consultava: quem marcasse 12
// e clicasse em "Iniciar" disparava para o movimento inteiro acreditando ter
// disparado para 12. Aqui se verifica a cadeia inteira do lado do browser — o
// rótulo do botão, o texto da confirmação e, principalmente, QUAIS IDs saem no
// corpo do POST /start-process.
//
// `/api/start-process` é interceptado e nunca chega ao backend: um disparo real
// notificaria motoristas. A validação do campo `ids` no servidor tem teste
// próprio em backend/tests/envio-selecao-unit.test.js.
import { test, expect, type Page } from '@playwright/test';
import { ADMIN_STATE } from './global-setup';

const ROTA = '/hub/dashboard/envio_massa';

// 12 linhas: a primeira já enviada, as demais pendentes. 12 > 10 para que a
// escolha de "10 por página" produza duas páginas — a seleção precisa
// sobreviver à troca de página.
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
  dt_inicial: null,
  dt_final: null,
  id_empresa: 1,
  created_at: '2026-08-07T00:00:00.000Z',
  mov_fechado: false,
}));

/** Marca o checkbox da linha cujo nome casa com o texto dado. */
async function marcarLinha(page: Page, nome: string) {
  await page.getByRole('row', { name: new RegExp(nome) }).getByRole('checkbox').click();
}

test.describe('impeccable rodada 6 — disparo por seleção', () => {
  test.use({ storageState: ADMIN_STATE, viewport: { width: 1280, height: 800 } });

  /** Corpos recebidos por /api/start-process nesta página, em ordem. */
  let corpos: Array<Record<string, unknown> | null>;

  test.beforeEach(async ({ page }) => {
    corpos = [];
    await page.route('**/api/envio-massa*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LINHAS) })
    );
    // Processo parado: é o estado em que o botão de disparo fica clicável.
    await page.route('**/api/process-status*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ active: false }),
      })
    );
    await page.route('**/api/start-process*', (route) => {
      const cru = route.request().postData();
      corpos.push(cru ? JSON.parse(cru) : null);
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
  });

  test('sem seleção: o botão fala do movimento inteiro e o POST não manda ids', async ({ page }) => {
    await page.goto(ROTA);

    const iniciar = page.getByRole('button', { name: /^Iniciar$/ });
    await expect(iniciar).toBeEnabled();
    await iniciar.click();

    await expect(page.getByRole('alertdialog')).toContainText('movimento aberto');
    await page.getByRole('button', { name: 'Iniciar envio' }).click();

    await expect.poll(() => corpos.length).toBe(1);
    // Ausência do campo, não lista vazia: o backend recusa `[]` de propósito.
    expect(corpos[0]).toBeNull();
  });

  test('com seleção mista: a confirmação conta quem já recebeu e o POST leva os ids marcados', async ({
    page,
  }) => {
    await page.goto(ROTA);

    await marcarLinha(page, 'Motorista 001'); // já enviada
    await marcarLinha(page, 'Motorista 003'); // pendente

    // O escopo é declarado antes do clique, não depois.
    const disparar = page.getByRole('button', { name: 'Disparar para 2' });
    await expect(disparar).toBeVisible();
    await disparar.click();

    const dialogo = page.getByRole('alertdialog');
    await expect(dialogo).toContainText('Você marcou 2 registros');
    // O número honesto: 1 dos 2 já recebeu e será pulado pelo backend.
    await expect(dialogo).toContainText('1 já recebeu mensagem e será pulado');
    await expect(dialogo).toContainText('sai para 1 motorista');

    await dialogo.getByRole('button', { name: 'Disparar para 1' }).click();

    await expect.poll(() => corpos.length).toBe(1);
    // Vão os 2 marcados — pular quem já recebeu é decisão do backend, e mandar
    // só os pendentes esconderia dele o que o operador de fato pediu.
    expect(corpos[0]).toEqual({ ids: [1, 3] });
  });

  test('seleção inteiramente já enviada: não há disparo a confirmar', async ({ page }) => {
    await page.goto(ROTA);

    await marcarLinha(page, 'Motorista 001');
    await page.getByRole('button', { name: 'Disparar para 1' }).click();

    const dialogo = page.getByRole('alertdialog');
    await expect(dialogo).toContainText('Não há nada a enviar nessa seleção');
    await expect(dialogo.getByRole('button', { name: 'Disparar para 0' })).toBeDisabled();

    await dialogo.getByRole('button', { name: 'Cancelar' }).click();
    expect(corpos).toHaveLength(0);
  });

  test('a seleção sobrevive à troca de página — "todos" não apaga o que ficou atrás', async ({
    page,
  }) => {
    await page.goto(ROTA);

    // 10 por página: 12 linhas viram 2 páginas.
    await page.getByRole('button', { name: /por página/i }).click();
    await page.getByRole('menuitem', { name: '10', exact: true }).click();
    await expect(page.getByRole('row', { name: /Motorista 011/ })).toHaveCount(0);

    await marcarLinha(page, 'Motorista 003');
    await expect(page.getByRole('button', { name: 'Disparar para 1' })).toBeVisible();

    // Página 2 (2 linhas) e "selecionar todos" no cabeçalho.
    await page.getByRole('button', { name: 'Página 2' }).click();
    await expect(page.getByRole('row', { name: /Motorista 011/ })).toBeVisible();
    await page.getByRole('columnheader').first().getByRole('checkbox').click();

    // 1 da página anterior + 2 desta. Antes deste fix o Set era sobrescrito e o
    // total voltava a 2 — o operador dispararia para menos gente do que marcou.
    await expect(page.getByRole('button', { name: 'Disparar para 3' })).toBeVisible();

    await page.getByRole('button', { name: 'Página 1' }).click();
    await expect(
      page.getByRole('row', { name: /Motorista 003/ }).getByRole('checkbox')
    ).toBeChecked();
  });
});
