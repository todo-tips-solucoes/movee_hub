// impeccable rodada 4 — verificação viva dos 3 itens da rodada contra o
// hub-homolog rebuildado. Assere no DOM renderizado, nunca em screenshot.
//
//   A) paginação: um idioma só nas 7 telas do hub (h4);
//   B) Sheet de usuário: os dois modos de persistência declarados, e alteração
//      pendente visível em vez de descartada em silêncio (h3/h9);
//   C) filtro de pessoa por nome, com degradação a ID quando falta permissão (h6).
import { test, expect, type Page } from '@playwright/test';
import { ADMIN_STATE } from './global-setup';

const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };

// As 6 telas do hub que trocaram o rodapé artesanal pelo componente
// compartilhado. A paginação só RENDERIZA quando há linhas — as entidades
// sintéticas do driver (950101/950102) têm eventos de auditoria e usuários
// (criados pelo próprio seed), mas nenhuma importação, motorista, lançamento
// ou turno. Por isso a asserção "existe paginação" fica restrita às telas com
// dados, e nas demais valida-se o que vale sempre: o idioma antigo sumiu.
const TELAS_PAGINADAS = [
  '/hub/dashboard/auditoria',
  '/hub/dashboard/importacoes',
  '/hub/dashboard/usuarios',
  '/hub/dashboard/motoristas',
  '/hub/dashboard/faturamento',
  '/hub/dashboard/performance',
];
const TELAS_COM_DADOS_NO_SEED = ['/hub/dashboard/auditoria', '/hub/dashboard/usuarios'];

test.describe('impeccable rodada 4 — A) paginação com idioma único (h4)', () => {
  test.use({ storageState: ADMIN_STATE, viewport: DESKTOP });

  for (const rota of TELAS_PAGINADAS) {
    test(`${rota}: o rodapé artesanal ("Anterior"/"Próxima" em texto) não existe mais`, async ({
      page,
    }) => {
      await page.goto(rota);
      // Espera a tela assentar (lista OU estado vazio) antes de concluir ausência.
      await expect(page.locator('table, [role="status"]').first()).toBeVisible();

      await expect(page.getByRole('button', { name: 'Anterior', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Próxima', exact: true })).toHaveCount(0);
    });
  }

  for (const rota of TELAS_COM_DADOS_NO_SEED) {
    test(`${rota}: com dados, usa o componente compartilhado`, async ({ page }) => {
      await page.goto(rota);

      await expect(page.getByRole('button', { name: 'Página anterior' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Próxima página' })).toBeVisible();
      // Informa o intervalo, não só o número da página.
      await expect(page.getByText(/Mostrando \d+-\d+ de \d+/)).toBeVisible();
      // E as telas do hub não oferecem "por página" (tamanho fixo server-side).
      await expect(page.getByText(/por página/)).toHaveCount(0);
    });
  }

  test('a página atual é anunciada com aria-current', async ({ page }) => {
    await page.goto('/hub/dashboard/auditoria');
    const atual = page.locator('button[aria-current="page"]');
    await expect(atual).toHaveCount(1);
    await expect(atual).toHaveText('1');
  });

  test('mobile 390px: a paginação não estoura a largura da viewport', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto('/hub/dashboard/auditoria');
    await expect(page.getByRole('button', { name: 'Próxima página' })).toBeVisible();

    const estouro = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(estouro).toBeLessThanOrEqual(0);
  });
});

// Este bloco nasceu de um falso positivo do teste acima: o estouro de 4px em
// 390px NÃO vinha da paginação, e sim do `EntitySwitcher` no header — medindo
// o DOM, ele reproduzia em `/hub/dashboard` e `/hub/dashboard/perfil`, telas
// que a rodada 4 nem tocou. Era o shell inteiro rolando na horizontal no
// celular. Como o defeito é do shell, o teste também é do shell.
test.describe('impeccable rodada 4 — sem rolagem horizontal no celular (shell)', () => {
  test.use({ storageState: ADMIN_STATE, viewport: MOBILE });

  for (const rota of ['/hub/dashboard', '/hub/dashboard/perfil', '/hub/dashboard/auditoria']) {
    test(`${rota}: body não rola na horizontal em 390px`, async ({ page }) => {
      await page.goto(rota);
      await expect(page.locator('#entity-switcher-trigger')).toBeVisible();

      const medida = await page.evaluate(() => ({
        estouro: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        switcherDireita: document
          .querySelector('#entity-switcher-trigger')
          ?.getBoundingClientRect().right,
        larguraDoc: document.documentElement.clientWidth,
      }));

      expect(medida.estouro).toBeLessThanOrEqual(0);
      // O switcher é quem estourava — assere a causa, não só o sintoma.
      expect(medida.switcherDireita!).toBeLessThanOrEqual(medida.larguraDoc);
    });
  }
});

async function abrirSheetDoPrimeiroUsuario(page: Page) {
  await page.goto('/hub/dashboard/usuarios');
  await page.getByRole('button', { name: /^Editar/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Editar usuário' })).toBeVisible();
}

test.describe('impeccable rodada 4 — B) persistência declarada no Sheet (h3/h9)', () => {
  test.use({ storageState: ADMIN_STATE, viewport: DESKTOP });

  test('cada bloco diz QUANDO o que está nele passa a valer', async ({ page }) => {
    await abrirSheetDoPrimeiroUsuario(page);

    // Dados: valem no botão.
    await expect(page.getByText(/Passam a valer quando você clicar em/)).toBeVisible();
    // Vínculos: valem no clique.
    await expect(page.getByText(/cada alteração aqui é salva no clique/)).toBeVisible();
  });

  test('sem edição pendente, Salvar dados fica desabilitado e Fechar é só Fechar', async ({
    page,
  }) => {
    await abrirSheetDoPrimeiroUsuario(page);

    await expect(page.getByRole('button', { name: 'Salvar dados' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Fechar', exact: true })).toBeVisible();
    await expect(page.getByText('Há alterações não salvas.')).toHaveCount(0);
  });

  test('com edição pendente, o painel avisa e o botão de sair diz que vai descartar', async ({
    page,
  }) => {
    await abrirSheetDoPrimeiroUsuario(page);

    await page.getByLabel('Nome', { exact: true }).fill('Nome Editado Pelo Teste');

    await expect(page.getByText('Há alterações não salvas.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Salvar dados' })).toBeEnabled();
    // O rótulo passa a dizer a consequência real do clique.
    await expect(page.getByRole('button', { name: 'Descartar e fechar' })).toBeVisible();
  });

  test('desfazer a edição volta ao estado limpo (compara com o carregado, não com um snapshot)', async ({
    page,
  }) => {
    await abrirSheetDoPrimeiroUsuario(page);

    const campoNome = page.getByLabel('Nome', { exact: true });
    const original = await campoNome.inputValue();
    await campoNome.fill('Alterado');
    await expect(page.getByText('Há alterações não salvas.')).toBeVisible();

    await campoNome.fill(original);
    await expect(page.getByText('Há alterações não salvas.')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Salvar dados' })).toBeDisabled();
  });
});

test.describe('impeccable rodada 4 — C) filtro de pessoa por nome (h6)', () => {
  test.use({ storageState: ADMIN_STATE, viewport: DESKTOP });

  test('auditoria: o campo de ID cru deu lugar a um combobox', async ({ page }) => {
    await page.goto('/hub/dashboard/auditoria');

    // O rótulo não fala mais em ID.
    await expect(page.getByText('ID do usuário responsável')).toHaveCount(0);
    await expect(page.getByText('Usuário responsável')).toBeVisible();

    const combo = page.getByRole('combobox', { name: 'Usuário responsável' });
    await expect(combo).toBeVisible();
    await expect(combo).toHaveText(/Todos os usuários/);
  });

  test('auditoria: abrir o combobox lista pessoas por nome e e-mail', async ({ page }) => {
    await page.goto('/hub/dashboard/auditoria');
    await page.getByRole('combobox', { name: 'Usuário responsável' }).click();

    await expect(page.getByPlaceholder('Busque por nome, e-mail ou ID...')).toBeVisible();
    // O admin seedado pelo driver aparece pelo próprio e-mail (@example.test).
    await expect(page.getByText(/e2e-teste-shell-browser-/).first()).toBeVisible();
  });

  test('importações: o filtro de responsável também deixou de pedir ID decorado', async ({
    page,
  }) => {
    await page.goto('/hub/dashboard/importacoes');

    await expect(page.getByText('Responsável (ID do usuário)')).toHaveCount(0);
    // admin_entidade TEM usuarios.gerenciar, então aqui não degrada.
    await expect(page.getByRole('combobox', { name: /respons[áa]vel/i })).toBeVisible();
  });

  test('403 na listagem: degrada para campo de ID em vez de quebrar o filtro', async ({ page }) => {
    // Simula o papel `operador` (tem o módulo de importações, não tem
    // `usuarios.gerenciar`) interceptando a rota com 403 — o mesmo que o
    // backend responderia para ele.
    await page.route('**/api/v1/usuarios?*', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ erro: 'PERMISSAO_NEGADA' }),
      })
    );

    await page.goto('/hub/dashboard/importacoes');
    await page.getByRole('combobox', { name: /respons[áa]vel/i }).click();

    // Vira o input numérico e continua filtrando.
    const campo = page.locator('#importacoes-filtro-responsavel');
    await expect(campo).toHaveAttribute('type', 'number');
    await campo.fill('17');
    await expect(campo).toHaveValue('17');
  });
});
