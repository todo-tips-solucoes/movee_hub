// impeccable r24 — quem alcança a PARAMETRIZAÇÃO de metas.
//
// Decisão do operador (2026-08-17): definir metas é de quem administra a
// entidade. `admin_plataforma` mantém a permissão (mesmo padrão das demais
// permissões sensíveis do hub); `operador` e `leitura` não têm nada aqui.
//
// O que este spec guarda é o que o teste de API não alcança: a TELA. Antes
// desta rodada, `/hub/dashboard/performance/metas` era acessível a qualquer um
// com o módulo e mostrava a lista inteira em "modo somente leitura" — ou seja,
// a configuração da entidade ficava exposta a quem não pode mudá-la.
//
// O VALOR da meta continua visível para todos na tela de Performance, e isso é
// deliberado: o badge diz "abaixo da meta de 90%". Esconder o número ali seria
// teatro, e sem ele nenhum turno seria avaliado.
import { test, expect } from '@playwright/test';
import { ADMIN_STATE, OPERADOR_STATE } from './global-setup';

test.describe('metas — acesso por papel', () => {
  test.describe('admin_entidade', () => {
    test.use({ storageState: ADMIN_STATE, viewport: { width: 1280, height: 800 } });

    test('alcança a parametrização e vê o formulário', async ({ page }) => {
      await page.goto('/hub/dashboard/performance/metas');
      await expect(page.getByRole('heading', { name: 'Metas de performance' })).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByRole('button', { name: /Definir meta/ })).toBeVisible();
      await expect(page.getByText('Você não tem acesso a esta configuração')).toHaveCount(0);
    });

    test('vê a entrada para as metas na tela de Performance', async ({ page }) => {
      await page.goto('/hub/dashboard/performance');
      await expect(page.getByRole('link', { name: 'Metas' })).toBeVisible({ timeout: 20_000 });
    });
  });

  test.describe('operador', () => {
    test.use({ storageState: OPERADOR_STATE, viewport: { width: 1280, height: 800 } });

    test('NÃO alcança a parametrização, nem por URL direta', async ({ page }) => {
      await page.goto('/hub/dashboard/performance/metas');
      await expect(page.getByText('Você não tem acesso a esta configuração')).toBeVisible({
        timeout: 20_000,
      });
      // Nem formulário, nem lista: a configuração da entidade não aparece.
      await expect(page.getByRole('button', { name: /Definir meta/ })).toHaveCount(0);
      await expect(page.getByRole('table')).toHaveCount(0);
    });

    test('não vê a entrada para as metas na tela de Performance', async ({ page }) => {
      await page.goto('/hub/dashboard/performance');
      await expect(page.getByRole('heading', { name: 'Performance' })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole('link', { name: 'Metas' })).toHaveCount(0);
    });
  });
});
