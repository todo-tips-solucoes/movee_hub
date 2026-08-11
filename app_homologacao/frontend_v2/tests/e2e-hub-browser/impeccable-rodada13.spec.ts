// impeccable rodada 13 (h10=2) — o formato do arquivo de importação, dito na
// tela e baixável.
//
// O teste unitário lê o DOM com o `<details>` fechado (o jsdom não aplica o
// recolhimento), então ele prova que a lista EXISTE, não que alguém consegue
// LER. Aqui a diferença aparece: `toBeVisible` no Chromium real só passa com o
// bloco aberto. E o download é verificado pelo CONTEÚDO do arquivo que chega
// ao disco — não pelo clique ter acontecido.
import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { ADMIN_STATE } from './global-setup';
import { COLUNAS_IMPORTACAO } from '../../lib/hub/importacoes-formato';

test.describe('impeccable rodada 13 — o formato do arquivo de importação', () => {
  test.use({ storageState: ADMIN_STATE, viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await page.goto('/hub/dashboard/importacoes');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Nova importação' }).first().click();
  });

  test('as colunas ficam legíveis, na ordem, com o aviso de que a ordem importa', async ({
    page,
  }) => {
    const esperadas = COLUNAS_IMPORTACAO.faturamento;
    const lista = page.getByRole('listitem');

    // Fechado, o conteúdo existe no DOM mas não é legível — é exatamente esta
    // distinção que o unit não consegue fazer.
    await expect(lista.first()).toBeHidden();

    await page.getByText('O que o arquivo precisa ter').click();
    await expect(lista.first()).toBeVisible();
    expect(await lista.allInnerTexts()).toEqual([...esperadas]);
    await expect(page.getByText(/nesta ordem exata/)).toBeVisible();
    await expect(page.getByText(/separados por ponto e vírgula/)).toBeVisible();
  });

  test('abrir a lista não empurra o diálogo para fora da tela', async ({ page }) => {
    // 20 colunas dentro de um diálogo estreito é exatamente o tipo de adição
    // que rouba o botão Enviar para baixo da dobra. O diálogo tem de caber na
    // viewport (rolando por dentro, se precisar) e o Enviar tem de continuar
    // alcançável — senão a ajuda nova quebra o fluxo que ela veio ajudar.
    await page.getByText('O que o arquivo precisa ter').click();

    const dialogo = page.getByRole('dialog');
    const caixa = await dialogo.boundingBox();
    const alturaViewport = page.viewportSize()!.height;
    expect(caixa!.y).toBeGreaterThanOrEqual(0);
    expect(caixa!.y + caixa!.height, 'o diálogo passa da borda inferior').toBeLessThanOrEqual(
      alturaViewport
    );
    await expect(page.getByRole('button', { name: /Enviar/ })).toBeInViewport();
  });

  test('o modelo baixado chega ao disco com o cabeçalho que a tela ensina', async ({ page }) => {
    await page.getByText('O que o arquivo precisa ter').click();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /Baixar modelo/ }).click(),
    ]);

    expect(download.suggestedFilename()).toBe('modelo-faturamento.csv');
    const caminho = await download.path();
    const conteudo = await readFile(caminho!, 'utf8');
    expect(conteudo).toBe(`${COLUNAS_IMPORTACAO.faturamento.join(';')}\n`);
  });

  test('trocar o tipo troca as colunas e o nome do modelo', async ({ page }) => {
    // O radio é `sr-only`; quem recebe o toque é o radio-card (`<label>`) —
    // clicar no input daria "intercepted by <span>", que é o comportamento
    // correto do produto, não um defeito.
    await page.getByRole('dialog').locator('label', { hasText: 'Performance' }).click();
    await page.getByText('O que o arquivo precisa ter').click();

    expect(await page.getByRole('listitem').allInnerTexts()).toEqual([
      ...COLUNAS_IMPORTACAO.performance,
    ]);
    await expect(page.getByRole('button', { name: 'Baixar modelo (modelo-performance.csv)' })).toBeVisible();
  });
});
