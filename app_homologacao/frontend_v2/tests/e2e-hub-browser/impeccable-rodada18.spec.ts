// impeccable rodada 18 (h4) — as listas param de mudar de largura entre si.
//
// O teste de convenção (`lib/hub/larguras.test.ts`) lê o código-fonte; este
// mede o resultado no Chromium. Os dois cobrem coisas diferentes: o de fonte
// pega a tela nova que inventa uma classe, e este pega o caso em que a classe
// está certa e a largura efetiva não é — CSS conflitante, container aninhado,
// ou a classe perdendo para outra por especificidade (já aconteceu nesta base,
// ver o gotcha do `data-[size]` no Select).
import { test, expect } from '@playwright/test';
import { ADMIN_STATE } from './global-setup';

const LISTAS = [
  '/hub/dashboard/envio_massa',
  '/hub/dashboard/importacoes',
  '/hub/dashboard/motoristas',
  '/hub/dashboard/faturamento',
  '/hub/dashboard/performance',
  '/hub/dashboard/auditoria',
  '/hub/dashboard/usuarios',
  '/hub/dashboard/usuarios/papeis',
];

test.describe('impeccable rodada 18 — largura das listas', () => {
  test.use({ storageState: ADMIN_STATE, viewport: { width: 1440, height: 900 } });

  test('todas as listas ocupam a mesma largura de container', async ({ page }) => {
    const medidas: { rota: string; largura: number }[] = [];

    for (const rota of LISTAS) {
      await page.goto(rota);
      await page.waitForLoadState('networkidle');
      const largura = await page.evaluate(() => {
        // O container é o primeiro descendente do conteúdo principal com
        // largura limitada — o mesmo elemento que carrega o `max-w-*`.
        const principal = document.querySelector('#conteudo-principal, main');
        const alvo = principal?.querySelector('[class*="mx-auto"]') as HTMLElement | null;
        return alvo ? Math.round(alvo.getBoundingClientRect().width) : -1;
      });
      medidas.push({ rota: rota.replace('/hub/dashboard/', ''), largura });
    }

    expect(medidas.every((m) => m.largura > 0), JSON.stringify(medidas)).toBe(true);
    const distintas = new Set(medidas.map((m) => m.largura));
    expect(
      distintas.size,
      `larguras diferentes entre listas: ${medidas.map((m) => `${m.rota}=${m.largura}`).join(' · ')}`
    ).toBe(1);
  });

  test('o perfil segue estreito — a regra não é "tudo igual"', async ({ page }) => {
    // Uniformizar por uniformizar tornaria o formulário pessoal uma linha de
    // 1400px. A regra tem três larguras COM critério, não uma só.
    await page.goto('/hub/dashboard/perfil');
    await page.waitForLoadState('networkidle');

    const largura = await page.evaluate(() => {
      const alvo = document.querySelector('#conteudo-principal [class*="mx-auto"], main [class*="mx-auto"]') as HTMLElement | null;
      return alvo ? Math.round(alvo.getBoundingClientRect().width) : -1;
    });
    expect(largura).toBeGreaterThan(0);
    expect(largura, 'o perfil não deveria ter largura de lista').toBeLessThan(700);
  });
});
