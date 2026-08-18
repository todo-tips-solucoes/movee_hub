// 0051 — a linha da tabela de Performance é o TURNO.
//
// O que este spec guarda, e nenhum teste de API alcança, é a TELA:
//
// 1. UMA linha para o turno que atravessa duas praças (a lista mostrava duas,
//    com 25,0% e 12,5% de tempo, enquanto o card mostrava 37,5% para o mesmo
//    dia da mesma pessoa — tabela e card discordavam);
// 2. UM veredito de meta por turno, no nível em que a meta é cadastrada
//    (praça × turno), e não um por fatia de praça;
// 3. as duas praças visíveis DENTRO da linha, para o número agregado não
//    esconder de onde veio;
// 4. a altura da linha. Era 143px, 106px dos quais só de badges de meta. O
//    alvo é ≤56px — e é medido no DOM, não julgado por captura de tela.
//
// O seed vive em `infra/hub/testes/hub-shell-e2e-browser.sh` (entregador
// "E2E Turno Duas Pracas", ontem, ALMOCO, 'E2E ZONA SUL' + 'E2E CENTRO',
// com meta de aceitação de 90% para a praça 'E2E SAO PAULO').
import { test, expect } from '@playwright/test';
import { ADMIN_STATE } from './global-setup';

const NOME = 'E2E Turno Duas Pracas';
/** Era 143px. O alvo do plano, medido com a mesma sonda. */
const ALTURA_MAX_LINHA = 56;

test.describe('performance — a linha é o turno (0051)', () => {
  test.use({ storageState: ADMIN_STATE, viewport: { width: 1800, height: 1200 } });

  test('turno em 2 praças vira UMA linha, com as praças dentro dela', async ({ page }) => {
    await page.goto('/hub/dashboard/performance');
    await expect(page.getByRole('heading', { name: 'Performance' })).toBeVisible({ timeout: 20_000 });

    const linhas = page.locator('tbody tr').filter({ hasText: NOME });
    await expect(linhas).toHaveCount(1, { timeout: 20_000 });

    // As duas sub-praças aparecem na MESMA linha — a agregação não some com o
    // detalhe, ela o subordina.
    const linha = linhas.first();
    await expect(linha).toContainText('E2E ZONA SUL');
    await expect(linha).toContainText('E2E CENTRO');
  });

  test('o veredito de meta é emitido UMA vez, e diz o número do turno', async ({ page }) => {
    await page.goto('/hub/dashboard/performance');
    const linha = page.locator('tbody tr').filter({ hasText: NOME }).first();
    await expect(linha).toBeVisible({ timeout: 20_000 });

    // Aceitação do TURNO: (6+2)/(8+4) = 66,7%, contra meta de 90% -> −23,3pp.
    // Pelas fatias seriam 75% e 50%, dois vereditos e nenhum deles o do turno.
    const vereditos = linha.getByText(/abaixo da meta de/);
    await expect(vereditos).toHaveCount(1);
    await expect(vereditos.first()).toContainText('66,7%');
    await expect(vereditos.first()).toContainText('90%');
    // A cor não é o único sinal: a distância vem escrita.
    await expect(linha).toContainText('−23,3pp');
  });

  test('a altura da linha cabe no alvo — medida no DOM, não julgada por captura', async ({ page }) => {
    await page.goto('/hub/dashboard/performance');
    const linha = page.locator('tbody tr').filter({ hasText: NOME }).first();
    await expect(linha).toBeVisible({ timeout: 20_000 });

    const caixa = await linha.boundingBox();
    expect(caixa).not.toBeNull();
    // O número medido é a evidência que o PR precisa relatar: sem ele o teste
    // diz "passou" e não diz de quanto. (`no-console` não está ligado nos
    // specs — os vizinhos que trazem a diretiva a têm por engano, e o próprio
    // lint avisa que ela é inútil.)
    console.log(`[0051] altura da linha do turno: ${caixa!.height}px (alvo ≤ ${ALTURA_MAX_LINHA}px)`);
    expect(caixa!.height).toBeLessThanOrEqual(ALTURA_MAX_LINHA);
  });

  test('no mobile a mesma informação existe — inclusive o veredito', async ({ page }) => {
    // A rodada 24 achou o inverso: as marcas de meta existiam SÓ no desktop, e
    // em 390px a feature não existia. Não repetir o erro ao contrário.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/hub/dashboard/performance');
    await expect(page.getByRole('heading', { name: 'Performance' })).toBeVisible({ timeout: 20_000 });

    const cartao = page.locator('div.md\\:hidden > div').filter({ hasText: NOME }).first();
    await expect(cartao).toBeVisible({ timeout: 20_000 });
    await expect(cartao).toContainText('E2E ZONA SUL');
    await expect(cartao).toContainText('E2E CENTRO');
    await expect(cartao.getByText(/abaixo da meta de/)).toHaveCount(1);
  });
});
