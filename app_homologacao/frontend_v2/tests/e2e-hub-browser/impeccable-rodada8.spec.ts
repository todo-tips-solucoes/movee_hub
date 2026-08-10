// impeccable rodada 8 — os P2 medidos, verificados no browser real.
//
// Estes casos existem porque os achados que eles cobrem SÓ aparecem medindo:
// contagem de Tab até o conteúdo, título de aba por rota, nome acessível de
// controle. Nenhum deles falha numa suíte unit.
import { test, expect } from '@playwright/test';
import { ADMIN_STATE } from './global-setup';

const ROTAS_COM_CHROME = [
  '/hub/dashboard',
  '/hub/dashboard/auditoria',
  '/hub/dashboard/importacoes',
  '/hub/dashboard/envio_massa',
  '/hub/dashboard/usuarios/papeis',
];

test.describe('impeccable rodada 8 — orientação e alcance', () => {
  test.use({ storageState: ADMIN_STATE, viewport: { width: 1280, height: 800 } });

  for (const rota of ROTAS_COM_CHROME) {
    test(`${rota}: o primeiro Tab é o skip link e ele leva ao conteúdo`, async ({ page }) => {
      await page.goto(rota);
      await page.waitForLoadState('networkidle');

      // Medido antes da rodada 8: 14 Tabs de pedágio até <main>, sem saída — e
      // em /usuarios/papeis o conteúdo nunca era alcançado, porque todos os
      // controles de lá são desabilitados por RBAC (leitura para
      // admin_entidade). O skip link é o caminho para os dois casos.
      await page.keyboard.press('Tab');
      const focado = page.locator(':focus');
      await expect(focado).toHaveText(/Pular para o conteúdo/);

      await page.keyboard.press('Enter');
      const main = page.locator('#conteudo-principal');
      await expect(main).toBeFocused();
    });
  }

  test('cada rota tem seu próprio título de aba, e nenhum nomeia o produto legado', async ({
    page,
  }) => {
    const titulos: string[] = [];
    for (const rota of ROTAS_COM_CHROME) {
      await page.goto(rota);
      await page.waitForLoadState('networkidle');
      // O título é aplicado por efeito depois que /me resolve os módulos.
      await expect
        .poll(async () => await page.title(), { timeout: 10000 })
        .not.toBe('EntreGô — Envio em Massa');
      titulos.push(await page.title());
    }

    // Medido antes: 13 rotas, 1 valor. Agora, um por módulo.
    expect(new Set(titulos).size).toBe(titulos.length);
    for (const t of titulos) {
      expect(t).toContain('Hub de Frota');
      expect(t).not.toContain('Envio em Massa —');
    }
  });
});

test.describe('impeccable rodada 8 — nomes e atalhos no envio em massa', () => {
  test.use({ storageState: ADMIN_STATE, viewport: { width: 1280, height: 800 } });

  const LINHAS = [
    { id: 1, number: '001', nome: 'Motorista Alfa', enviado: 'ok' },
    { id: 2, number: '002', nome: 'Motorista Beta', enviado: 'erro' },
    { id: 3, number: '003', nome: 'Motorista Gama', enviado: 'off' },
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
    dt_inicial: '2026-08-01',
    dt_final: '2026-08-07',
    id_empresa: 1,
    created_at: '2026-08-07T00:00:00.000Z',
    mov_fechado: false,
  }));

  test.beforeEach(async ({ page }) => {
    await page.route('**/api/envio-massa*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LINHAS) })
    );
    await page.route('**/api/process-status*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ active: false }),
      })
    );
  });

  test('os checkboxes que decidem quem recebe mensagem dizem QUEM', async ({ page }) => {
    await page.goto('/hub/dashboard/envio_massa');

    // Antes: 100 controles idênticos e mudos para leitor de tela, ao lado de
    // botões de editar/excluir nominais.
    await expect(page.getByRole('checkbox', { name: 'Selecionar Motorista Alfa' })).toBeVisible();
    // O do cabeçalho também declara o escopo: marca só a página atual.
    await expect(
      page.getByRole('checkbox', { name: 'Selecionar todos os registros desta página' })
    ).toBeVisible();
  });

  test('o card de erro leva ao filtro correspondente, e o número bate', async ({ page }) => {
    await page.goto('/hub/dashboard/envio_massa');

    await page.getByRole('button', { name: /Filtrar a tabela por Mensagens com Erro/ }).click();

    // 1 linha com erro no mock — o card dizia 1 e a tabela mostra exatamente ela.
    await expect(page.getByRole('row', { name: /Motorista Beta/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /Motorista Alfa/ })).toHaveCount(0);
    await expect(page.getByRole('row', { name: /Motorista Gama/ })).toHaveCount(0);
  });

  test('os cards de XML seguem informativos — o filtro não reproduziria a contagem', async ({
    page,
  }) => {
    await page.goto('/hub/dashboard/envio_massa');
    await expect(page.getByText('XMLs Enviados')).toBeVisible();
    await expect(page.getByRole('button', { name: /Filtrar a tabela por XMLs/ })).toHaveCount(0);
  });

  test('a seleção pode ser desfeita, e o botão diz quantas linhas estão marcadas', async ({
    page,
  }) => {
    await page.goto('/hub/dashboard/envio_massa');

    await page.getByRole('checkbox', { name: 'Selecionar Motorista Gama' }).click();
    const limpar = page.getByRole('button', { name: 'Limpar seleção (1)' });
    await expect(limpar).toBeVisible();

    await limpar.click();
    await expect(page.getByRole('button', { name: /Limpar seleção/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Iniciar$/ })).toBeVisible();
  });

  test('os filtros têm rótulo programático, não só placeholder', async ({ page }) => {
    await page.goto('/hub/dashboard/envio_massa');
    await page.getByRole('button', { name: /Filtros/ }).first().click();

    await expect(page.getByRole('combobox', { name: 'Erro de Envio' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Filtrar por nome' })).toBeVisible();
  });
});
