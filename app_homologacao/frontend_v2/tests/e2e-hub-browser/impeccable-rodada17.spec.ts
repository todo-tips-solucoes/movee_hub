// impeccable rodada 17 (h1) — quantas vezes a tela do disparo interrompe quem
// usa leitor de tela.
//
// A crítica de 26/40 dizia "~46 anúncios em 10 minutos" por aritmética sobre o
// intervalo do poll (13s). Este spec MEDE: mocka um disparo em andamento com
// números que avançam a cada resposta e conta as mutações dentro de regiões
// `aria-live` durante três ciclos de polling.
//
// O caso é lento (~45s) de propósito: o defeito é temporal, e uma medição de
// 2 segundos não veria nada. Ele vale por dois — falha se a pílula voltar a
// anunciar cada tick, e falha se o anúncio de marco sumir.
import { test, expect, type Page } from '@playwright/test';
import { ADMIN_STATE } from './global-setup';

const POLL_MS = 13000; // use-process-status.ts
const CICLOS = 3;

const LINHA = (i: number) => ({
  id: i,
  number: String(i).padStart(3, '0'),
  nome: `Motorista ${i}`,
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
});

/**
 * Disparo em andamento: a cada resposta, mais uma linha aparece como enviada —
 * é o que faz o texto da pílula mudar ("Enviando — 4 de 10" → "5 de 10").
 */
async function mockarDisparoEmAndamento(page: Page) {
  let enviadas = 3;
  await page.route('**/api/envio-massa*', async (rota) => {
    enviadas += 1;
    const linhas = Array.from({ length: 10 }, (_, i) => ({
      ...LINHA(i + 1),
      enviado: i < enviadas ? 'ok' : 'off',
    }));
    await rota.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(linhas) });
  });
  await page.route('**/api/process-status*', (rota) =>
    rota.fulfill({ status: 200, contentType: 'application/json', body: '{"active":true}' })
  );
}

/** Conta mutações de texto dentro de cada região viva, por região. */
async function observarAnuncios(page: Page) {
  await page.evaluate(() => {
    const janela = window as unknown as { __anuncios: { alvo: string; texto: string }[] };
    janela.__anuncios = [];
    for (const regiao of document.querySelectorAll('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"]')) {
      const alvo =
        regiao.getAttribute('data-anuncio') ||
        regiao.getAttribute('role') ||
        regiao.tagName.toLowerCase();
      new MutationObserver(() => {
        janela.__anuncios.push({ alvo, texto: (regiao.textContent || '').trim().slice(0, 40) });
      }).observe(regiao, { childList: true, characterData: true, subtree: true });
    }
  });
}

test.describe('impeccable rodada 17 — o disparo deixa de anunciar cada tick', () => {
  test.use({ storageState: ADMIN_STATE, viewport: { width: 1280, height: 800 } });

  test('três ciclos de polling não geram anúncio por tick', async ({ page }) => {
    test.setTimeout(POLL_MS * (CICLOS + 2));

    await mockarDisparoEmAndamento(page);
    await page.goto('/hub/dashboard/envio_massa');
    await page.waitForLoadState('networkidle');
    // A pílula precisa estar no estado "enviando" para o cenário valer.
    await expect(page.getByText(/Enviando —/)).toBeVisible();

    await observarAnuncios(page);
    await page.waitForTimeout(POLL_MS * CICLOS + 2000);

    const anuncios = await page.evaluate(
      () => (window as unknown as { __anuncios: { alvo: string; texto: string }[] }).__anuncios
    );

    // Antes desta rodada: uma mutação por poll (3 em 39s ≈ 46 em 10 minutos),
    // vindas da pílula. O número de referência é o do progresso: nenhum.
    const doProgresso = anuncios.filter((a) => /Enviando —/.test(a.texto));
    expect(
      doProgresso.length,
      `a pílula anunciou o progresso ${doProgresso.length}x em ${CICLOS} ciclos: ${JSON.stringify(anuncios.slice(0, 4))}`
    ).toBe(0);
  });

  test('a pílula continua legível — some do canal vivo, não da tela', async ({ page }) => {
    // Tirar do `aria-live` não pode virar "esconder de quem usa leitor de
    // tela": o texto segue no documento, alcançável na navegação normal.
    await mockarDisparoEmAndamento(page);
    await page.goto('/hub/dashboard/envio_massa');
    await page.waitForLoadState('networkidle');

    const pilula = page.getByText(/Enviando —/);
    await expect(pilula).toBeVisible();
    await expect(pilula).not.toHaveAttribute('aria-hidden', 'true');
  });

  test('o banner de ambiente não ocupa canal vivo — o texto nunca muda', async ({ page }) => {
    await page.goto('/hub/dashboard/envio_massa');
    await page.waitForLoadState('networkidle');

    const banner = page.getByText('HOMOLOGAÇÃO — dados fictícios');
    await expect(banner).toBeVisible();
    await expect(banner).not.toHaveAttribute('aria-live', 'polite');
    await expect(banner).not.toHaveAttribute('role', 'status');
  });
});
