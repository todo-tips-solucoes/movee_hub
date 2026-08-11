// impeccable rodada 6 — recibo do disparo (P1-2, 3º item), verificado vivo
// contra o hub-homolog rebuildado. Assere no DOM renderizado.
//
// O fim do disparo era um toast de 4s: quem saía da mesa enquanto o envio
// rodava voltava para uma tela sem nenhum vestígio do resultado. O recibo
// aparece na virada ativo → inativo e fica até ser dispensado.
//
// As rotas do módulo são mockadas (`/api/process-status`, `/api/envio-massa`,
// `/api/stop-process`) porque o cenário depende de um disparo em andamento
// terminando — estado que o hub-homolog não tem sob demanda, e que forçá-lo a
// ter significaria disparar envio de verdade. O que se testa aqui é a tela: o
// hook em si (virada por polling, dispensar, disparo novo apaga) está coberto
// por `hooks/use-process-status.test.ts`.
import { test, expect } from '@playwright/test';
import { ADMIN_STATE } from './global-setup';

const ROTA = '/hub/dashboard/envio_massa';

// 1 enviada, 1 com erro, 1 sem envio — os três números do recibo, distintos
// entre si para que nenhuma asserção passe por coincidência.
const LINHAS = [
  { id: 1, number: '001', nome: 'Motorista Enviado', enviado: 'ok' },
  { id: 2, number: '002', nome: 'Motorista Com Erro', enviado: 'erro' },
  { id: 3, number: '003', nome: 'Motorista Sem Envio', enviado: 'off' },
].map((base) => ({
  ...base,
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

test.describe('impeccable rodada 6 — recibo do disparo', () => {
  test.use({ storageState: ADMIN_STATE, viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await page.route('**/api/envio-massa*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LINHAS) })
    );
    // Chega na tela com um disparo EM ANDAMENTO.
    await page.route('**/api/process-status*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ active: true }),
      })
    );
    await page.route('**/api/stop-process*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    );
  });

  test('enquanto o disparo roda não há recibo; ao terminar, ele fica na tela', async ({ page }) => {
    await page.goto(ROTA);
    await expect(page.getByRole('button', { name: /^Parar/ })).toBeEnabled();
    await expect(page.getByText('Disparo concluído')).toHaveCount(0);

    await page.getByRole('button', { name: /^Parar/ }).click();

    const recibo = page.getByRole('status').filter({ hasText: 'Disparo concluído' });
    await expect(recibo).toBeVisible();
    // Os três números, com os rótulos que o operador lê.
    await expect(recibo).toContainText('1 enviada');
    await expect(recibo).toContainText('1 com erro');
    await expect(recibo).toContainText('1 sem envio');

    // Não é toast: continua lá bem depois de qualquer timer de 4s.
    await page.waitForTimeout(5000);
    await expect(recibo).toBeVisible();
  });

  test('o atalho leva às linhas com erro, e dispensar fecha o recibo', async ({ page }) => {
    await page.goto(ROTA);
    await page.getByRole('button', { name: /^Parar/ }).click();

    const recibo = page.getByRole('status').filter({ hasText: 'Disparo concluído' });
    await expect(recibo).toBeVisible();

    await recibo.getByRole('button', { name: /linha com erro/i }).click();

    // A tabela mostra só a linha com erro — e o filtro correspondente está
    // visível na barra, então o operador vê POR QUE a lista encurtou.
    await expect(page.getByRole('row', { name: /Motorista Com Erro/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /Motorista Enviado/ })).toHaveCount(0);
    await expect(page.getByRole('row', { name: /Motorista Sem Envio/ })).toHaveCount(0);

    await recibo.getByRole('button', { name: /dispensar/i }).click();
    // Escopado ao RECIBO: a r17 pôs uma região viva que anuncia "Disparo
    // concluído." por alguns segundos, e medir por texto solto confundia o
    // anúncio (correto, transitório, sr-only) com o recibo (o que esta
    // asserção quer ver sumir).
    await expect(recibo).toHaveCount(0);
  });
});
