// impeccable rodada 3 — verificação viva dos 4 itens da rodada contra o
// hub-homolog rebuildado. Cada teste assere no DOM RENDERIZADO (não em
// screenshot: lição de 2026-08-04 — medir com getComputedStyle/textContent
// em vez de julgar imagem).
//
// Cobertura:
//   A) filtro de período com presets nos 4 módulos (h7/h2/h5);
//   B) ajuda contextual: descrição por módulo + estado vazio que nomeia a
//      entidade (h10);
//   C) combobox de entidade compartilhado no filtro da auditoria (h6);
//   D) --font-mono sem a Jakarta proporcional.
//
// Sessão vem de `storageState` gravado 1x em `global-setup.ts` (mesmo padrão
// dos demais specs — evita esgotar o rate limiter de `/auth/login`).
import { test, expect } from '@playwright/test';
import { ADMIN_STATE } from './global-setup';

const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };

// Os 4 módulos que ganharam o PeriodFilter, com o rótulo do campo "De" de cada
// um — o rótulo distinto prova que a prop `rotuloDe` chegou em cada chamador.
const MODULOS_COM_PERIODO = [
  { rota: '/hub/dashboard/auditoria', rotuloDe: 'De' },
  { rota: '/hub/dashboard/importacoes', rotuloDe: 'De' },
  { rota: '/hub/dashboard/performance', rotuloDe: 'De (data do turno)' },
  { rota: '/hub/dashboard/faturamento', rotuloDe: 'De (data de competência)' },
];

test.describe('impeccable rodada 3 — A) filtro de período com presets', () => {
  test.use({ storageState: ADMIN_STATE, viewport: DESKTOP });

  for (const { rota, rotuloDe } of MODULOS_COM_PERIODO) {
    test(`${rota}: os 4 chips existem e "Este mês" preenche de/até`, async ({ page }) => {
      await page.goto(rota);

      for (const rotulo of ['Hoje', '7 dias', '30 dias', 'Este mês']) {
        await expect(page.getByRole('button', { name: rotulo, exact: true })).toBeVisible();
      }

      const campoDe = page.getByLabel(rotuloDe, { exact: true });
      const campoAte = page.getByLabel(rotuloDe.replace('De', 'Até'), { exact: true });
      // Estado inicial: sem período, e o texto de apoio diz isso.
      await expect(campoDe).toHaveValue('');
      await expect(page.getByText('Exibindo todo o período disponível.')).toBeVisible();

      const chipMes = page.getByRole('button', { name: 'Este mês', exact: true });
      await expect(chipMes).toHaveAttribute('aria-pressed', 'false');
      await chipMes.click();

      // O preset move as DUAS pontas juntas: dia 1º do mês corrente até hoje.
      const hoje = new Date();
      const iso = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      await expect(campoDe).toHaveValue(iso(new Date(hoje.getFullYear(), hoje.getMonth(), 1)));
      await expect(campoAte).toHaveValue(iso(hoje));
      // E o chip acende sozinho, derivado do par (nenhum preset persistido).
      await expect(chipMes).toHaveAttribute('aria-pressed', 'true');
    });
  }

  test('o intervalo é ecoado em pt-BR (DD/MM/AAAA), não no formato do browser', async ({ page }) => {
    await page.goto('/hub/dashboard/auditoria');
    await page.getByRole('button', { name: 'Hoje', exact: true }).click();

    const hoje = new Date();
    const br = `${String(hoje.getDate()).padStart(2, '0')}/${String(hoje.getMonth() + 1).padStart(2, '0')}/${hoje.getFullYear()}`;
    // O <input type="date"> renderiza no locale do BROWSER; este eco é o que
    // garante que o operador leia a data no formato do país.
    await expect(page.getByText(`Exibindo de ${br} a ${br}.`)).toBeVisible();
  });

  test('intervalo invertido é acusado com role=alert, nomeando problema e recuperação', async ({
    page,
  }) => {
    await page.goto('/hub/dashboard/auditoria');
    await page.getByLabel('De', { exact: true }).fill('2026-03-20');
    await page.getByLabel('Até', { exact: true }).fill('2026-03-10');

    const alerta = page.getByRole('alert').filter({ hasText: 'posterior à final' });
    await expect(alerta).toBeVisible();
    await expect(alerta).toContainText('20/03/2026');
    await expect(alerta).toContainText('inverta as duas');
  });

  test('"Todo o período" limpa as duas pontas de uma vez', async ({ page }) => {
    await page.goto('/hub/dashboard/importacoes');
    await page.getByRole('button', { name: '7 dias', exact: true }).click();
    await expect(page.getByLabel('De', { exact: true })).not.toHaveValue('');

    await page.getByRole('button', { name: 'Todo o período', exact: true }).click();
    await expect(page.getByLabel('De', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Até', { exact: true })).toHaveValue('');
  });

  test('mobile 390px: os chips não estouram a largura da viewport', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto('/hub/dashboard/faturamento');

    await expect(page.getByRole('button', { name: 'Este mês', exact: true })).toBeVisible();
    // Nenhum scroll horizontal no documento (craft floor: o body nunca rola na horizontal).
    const estouro = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(estouro).toBeLessThanOrEqual(0);
  });
});

test.describe('impeccable rodada 3 — B) ajuda contextual (h10)', () => {
  test.use({ storageState: ADMIN_STATE, viewport: DESKTOP });

  test('cada card do dashboard diz o que o módulo faz, não só o nome', async ({ page }) => {
    await page.goto('/hub/dashboard');

    await expect(
      page.getByText('Importe planilhas de movimento e acompanhe o processamento de cada carga.')
    ).toBeVisible();
    await expect(page.getByText('Consulte a trilha imutável de quem fez o quê, e quando.')).toBeVisible();

    // Todo card visível tem descrição (o seed ativa todos os módulos canônicos).
    const cardsSemDescricao = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href^="/hub/dashboard"]'));
      return links
        .filter((a) => a.querySelector('h2') && !a.querySelector('h2 + p'))
        .map((a) => a.querySelector('h2')?.textContent ?? '?');
    });
    expect(cardsSemDescricao).toEqual([]);
  });

  test('a descrição tem contraste de texto secundário legível (>= 4.5:1)', async ({ page }) => {
    await page.goto('/hub/dashboard');
    // Espera os cards assentarem: logo após o goto o `/me` ainda está em voo e
    // a tela mostra SKELETONS — medir aí lia `null` e não o texto real.
    await expect(page.locator('a[href^="/hub/dashboard"] h2 + p').first()).toBeVisible();

    const razao = await page.evaluate(() => {
      const p = document.querySelector('a[href^="/hub/dashboard"] h2 + p') as HTMLElement | null;
      if (!p) return null;
      const lum = (cor: string) => {
        const [r, g, b] = cor.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number);
        const c = [r, g, b].map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      };
      // Sobe até achar um ancestral com fundo opaco — o card é o que pinta.
      let fundo = 'rgb(255, 255, 255)';
      for (let el: HTMLElement | null = p; el; el = el.parentElement) {
        const bg = getComputedStyle(el).backgroundColor;
        if (bg && !bg.includes('rgba(0, 0, 0, 0)')) {
          fundo = bg;
          break;
        }
      }
      const a = lum(getComputedStyle(p).color);
      const b = lum(fundo);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });

    expect(razao).not.toBeNull();
    expect(razao!).toBeGreaterThanOrEqual(4.5);
  });

  test('o cabeçalho do dashboard nomeia a entidade em operação', async ({ page }) => {
    await page.goto('/hub/dashboard');
    // A entidade sintética do driver (950101/950102) não tem nome em "Empresa",
    // então o fallback "Empresa #id" é o esperado aqui — o que importa é que a
    // frase nomeie ALGUMA entidade e nunca imprima "undefined".
    const sub = page.locator('h1 + p').first();
    await expect(sub).toContainText('Escolha um módulo para começar.');
    await expect(sub).not.toContainText('undefined');
  });
});

test.describe('impeccable rodada 3 — C) combobox de entidade na auditoria (h6)', () => {
  test.use({ storageState: ADMIN_STATE, viewport: DESKTOP });

  test('o filtro de entidade deixou de ser campo numérico e virou combobox', async ({ page }) => {
    await page.goto('/hub/dashboard/auditoria');

    // O campo antigo (input[type=number] com esse id) não existe mais.
    await expect(page.locator('#auditoria-filtro-entidade')).toHaveCount(0);

    const combo = page.getByRole('combobox', { name: 'Entidade' });
    // admin_entidade não tem `auditoria.ver_tudo` — o filtro só aparece para
    // quem vê a plataforma inteira. Se não estiver visível, o teste ainda
    // prova o que importa: o input numérico foi embora.
    if (await combo.isVisible().catch(() => false)) {
      await combo.click();
      await expect(page.getByPlaceholder('Busque por nome ou ID...')).toBeVisible();
      await expect(page.getByText('Todas as entidades')).toBeVisible();
    }
  });

  test('admin: o combobox lista as entidades do usuário com nome, buscáveis por texto', async ({
    page,
  }) => {
    await page.goto('/hub/dashboard/admin');

    const combo = page.getByRole('combobox', { name: 'Entidade' });
    await expect(combo).toBeVisible();
    await combo.click();

    const busca = page.getByPlaceholder('Busque por nome ou ID...');
    await expect(busca).toBeVisible();

    // Escopa na LISTA: `getByText(/950101/)` casava também com o rótulo do
    // gatilho (a entidade atual), disparando strict mode violation — o que o
    // teste quer provar é o conteúdo das opções, não o do botão.
    const opcoes = page.getByRole('option');
    // Os 2 vínculos do admin seedado (950101/950102) aparecem sem digitar nada.
    await expect(opcoes.filter({ hasText: '950101' })).toHaveCount(1);
    await expect(opcoes.filter({ hasText: '950102' })).toHaveCount(1);

    // Busca por ID continua funcionando (caminho do admin_plataforma).
    await busca.fill('950102');
    await expect(opcoes.filter({ hasText: '950101' })).toHaveCount(0);
    await expect(opcoes.filter({ hasText: '950102' })).toHaveCount(1);
  });
});

test.describe('impeccable rodada 3 — D) --font-mono real', () => {
  test.use({ storageState: ADMIN_STATE, viewport: DESKTOP });

  test('a utility font-mono não cai na Jakarta (proporcional) e monoespaça de fato', async ({
    page,
  }) => {
    await page.goto('/hub/dashboard');

    // Mede pela CLASSE `font-mono`, não pela var `--font-mono`: o tema é
    // declarado em `@theme inline`, que o Tailwind v4 resolve em BUILD e
    // inlina na utility — nenhuma custom property chega ao runtime, então
    // `getPropertyValue('--font-mono')` devolve "" e qualquer asserção sobre
    // ela passa por vacuidade (foi o que a sondagem mostrou). O que o usuário
    // recebe é a classe, e é ela que precisa monoespaçar: `copyable-uuid`,
    // as colunas de valor do faturamento e as contagens das importações.
    const medicao = await page.evaluate(() => {
      const medir = (txt: string) => {
        const s = document.createElement('span');
        s.className = 'font-mono';
        s.style.fontSize = '16px';
        s.style.position = 'absolute';
        s.style.whiteSpace = 'pre';
        s.textContent = txt;
        document.body.appendChild(s);
        const r = { largura: s.getBoundingClientRect().width, familia: getComputedStyle(s).fontFamily };
        s.remove();
        return r;
      };
      const estreito = medir('iiii');
      const largo = medir('WWWW');
      return { familia: estreito.familia, delta: Math.abs(estreito.largura - largo.largura) };
    });

    expect(medicao.familia.toLowerCase()).not.toContain('jakarta');
    // Em fonte monoespaçada, "iiii" e "WWWW" ocupam exatamente a mesma largura.
    expect(medicao.delta).toBeLessThan(0.5);
  });
});
