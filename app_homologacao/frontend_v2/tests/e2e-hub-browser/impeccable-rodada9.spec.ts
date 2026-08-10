// impeccable rodada 9 — os achados da crítica medida, travados no browser.
//
// Pauta em docs/plans/hub-frota/CRITICA-MEDIDA-R9.md. Todos os casos aqui
// nasceram de um número lido do DOM, não de leitura de código — e o A1 em
// particular nasceu de uma sonda CORRIGINDO outra: a primeira media
// `max(elemento, pai)` e dava tudo aprovado.
import { test, expect, type Page } from '@playwright/test';
import { ADMIN_STATE } from './global-setup';

const MINIMO = 44;

/** Caixa tocável real: o controle, ou o <label> que o embrulha. */
async function caixa(page: Page, seletor: string) {
  return page.evaluate((s) => {
    const e = document.querySelector(s) as HTMLElement | null;
    if (!e) return null;
    const b = e.getBoundingClientRect();
    const rotulo = e.closest('label')?.getBoundingClientRect();
    return {
      w: Math.round(Math.max(b.width, rotulo?.width ?? 0)),
      h: Math.round(Math.max(b.height, rotulo?.height ?? 0)),
    };
  }, seletor);
}

test.describe('impeccable rodada 9 — alvos de toque a 390px (A1)', () => {
  test.use({ storageState: ADMIN_STATE, viewport: { width: 390, height: 844 } });

  // O chrome aparece em toda tela do hub: um alvo pequeno aqui é um alvo
  // pequeno em 12 rotas. Medido antes da r9: 32x32 e 358x32.
  for (const rota of ['/hub/dashboard', '/hub/dashboard/envio_massa']) {
    test(`${rota}: os dois controles do chrome respeitam 44px`, async ({ page }) => {
      await page.goto(rota);
      await page.waitForLoadState('networkidle');

      const tema = await caixa(page, '[aria-label="Alternar tema"]');
      expect(tema, 'botão de tema não encontrado').not.toBeNull();
      expect(tema!.h).toBeGreaterThanOrEqual(MINIMO);
      expect(tema!.w).toBeGreaterThanOrEqual(MINIMO);

      const entidade = await caixa(page, '[aria-label="Trocar entidade de trabalho"]');
      expect(entidade, 'seletor de entidade não encontrado').not.toBeNull();
      expect(entidade!.h).toBeGreaterThanOrEqual(MINIMO);
    });
  }

  test('os chips de período têm altura tocável (A1b)', async ({ page }) => {
    await page.goto('/hub/dashboard/auditoria');
    await page.waitForLoadState('networkidle');

    const baixos = await page.evaluate((min) => {
      const alvos = ['Hoje', '7 dias', '30 dias', 'Este mês'];
      return [...document.querySelectorAll('button')]
        .filter((b) => alvos.includes((b.textContent || '').trim()))
        .map((b) => ({ nome: (b.textContent || '').trim(), h: Math.round(b.getBoundingClientRect().height) }))
        .filter((b) => b.h < min);
    }, MINIMO);
    expect(baixos, `chips abaixo de ${MINIMO}px: ${JSON.stringify(baixos)}`).toEqual([]);
  });

  test('o botão Validar tem altura tocável (A1c)', async ({ page }) => {
    await page.goto('/hub/dashboard/validacao_xml');
    await page.waitForLoadState('networkidle');
    const validar = await page.getByRole('button', { name: 'Validar' }).boundingBox();
    expect(validar!.height).toBeGreaterThanOrEqual(MINIMO);
  });

  test('os checkboxes da matriz de papéis são alcançáveis com o dedo (A2)', async ({ page }) => {
    await page.goto('/hub/dashboard/usuarios/papeis');
    await page.waitForLoadState('networkidle');

    // Mediam 16x16 — 132 deles, e é aqui que se concede permissão.
    const pequenos = await page.evaluate((min) => {
      const caixas = [...document.querySelectorAll('[role="checkbox"]')];
      return caixas
        .map((c) => {
          const alvo = (c.parentElement ?? c).getBoundingClientRect();
          return Math.round(Math.min(alvo.width, alvo.height));
        })
        .filter((lado) => lado < min).length;
    }, MINIMO);
    expect(pequenos, 'checkboxes com área tocável abaixo de 44px').toBe(0);
  });
});

test.describe('impeccable rodada 9 — estrutura e linguagem', () => {
  test.use({ storageState: ADMIN_STATE, viewport: { width: 1280, height: 800 } });

  test('a validação XML tem UM h1, e ele está acentuado (A4/A5)', async ({ page }) => {
    await page.goto('/hub/dashboard/validacao_xml');
    await page.waitForLoadState('networkidle');

    await expect(page.locator('h1')).toHaveCount(1);
    const texto = await page.locator('#conteudo-principal').innerText();
    expect(texto).not.toMatch(/Validacao/);
    expect(texto).toContain('Validação XML NFSe');
  });

  test('os cabeçalhos da tabela de envio em massa estão acentuados (A3)', async ({ page }) => {
    await page.goto('/hub/dashboard/envio_massa');
    await page.waitForLoadState('networkidle');

    const cabecalhos = await page.locator('th').allInnerTexts();
    const juntos = cabecalhos.join(' | ');
    expect(juntos).not.toMatch(/\b(Numero|Emissao|Acoes)\b/);
    expect(juntos).toContain('Número');
    expect(juntos).toContain('Ações');
  });

  test('as rotas que não são módulos param de se anunciar como Painel Geral (A6)', async ({
    page,
  }) => {
    for (const rota of ['/hub/dashboard/admin', '/hub/dashboard/perfil']) {
      await page.goto(rota);
      await page.waitForLoadState('networkidle');
      const titulo = await page.title();
      const h1 = (await page.locator('#conteudo-principal h1').first().innerText()).trim();
      // A regra não é "conter tal texto": é a aba dizer o mesmo que o
      // cabeçalho visível da tela em que o usuário está.
      expect(titulo, `${rota}: h1="${h1}"`).toBe(`${h1} · Hub de Frota`);
      expect(titulo, `${rota} ainda se anuncia como o painel`).not.toBe(
        'Painel Geral · Hub de Frota'
      );
    }
  });

  test('a raiz do painel continua nomeada pelo MÓDULO, não pelo h1', async ({ page }) => {
    // Contraprova do A6: renomear um módulo no banco tem que continuar
    // renomeando a aba — é a propriedade que o TituloDaRota existe para ter.
    await page.goto('/hub/dashboard');
    await page.waitForLoadState('networkidle');
    expect(await page.title()).toBe('Painel Geral · Hub de Frota');
  });
});
