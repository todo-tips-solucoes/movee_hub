// Fase 1 (itens 1, 2 e 4 do plano): Configurações > seletor de produção, contra backend e banco reais.
//  - aviso âmbar em "Só as marcadas" (categoria nova está FORA) e azul em "Todas, exceto";
//  - trocar para "Todas, exceto" pré-marca Indicadores como exceção; marca mais uma; salva; reabre.
// O driver confere o banco (modo:todas na lista) e o valor da produção depois desta fase.
import { test, expect } from '@playwright/test';
import { HUB, abrirConfiguracoes, chip, chipsProducao, comoContarProducao, env, loginHub } from './_comum';

const NOVA = 'Incentivo chuva E2E';
const EXCECAO = 'Bonus Extra E2E';

test('config: aviso (âmbar/azul), modo todas, exceção extra, salvar e reabrir', async ({ page }) => {
  await loginHub(page, env('CAT_ADMIN_EMAIL'), env('CAT_ADMIN_SENHA'));
  await abrirConfiguracoes(page);

  const modo = comoContarProducao(page);
  const radioMarcadas = modo.getByRole('radio', { name: 'Só as marcadas' });
  const radioTodas = modo.getByRole('radio', { name: 'Todas, exceto as marcadas' });
  await expect(radioMarcadas).toBeChecked();

  // (2) "Só as marcadas": a categoria nova (1º lançamento depois da vigente_desde) está FORA — aviso âmbar.
  const ambar = page.getByRole('status').filter({ hasText: 'estão FORA da antecipação' });
  await expect(ambar).toHaveCount(1);
  await expect(ambar).toContainText('1 categoria nova');
  await expect(ambar).toContainText(NOVA);
  await expect(ambar).toHaveClass(/amber/);
  // as categorias antigas não são "novas"
  await expect(ambar).not.toContainText('Corrida E2E');

  // (1) troca para "Todas, exceto": Indicadores já vem marcada como exceção.
  await radioTodas.check();
  await expect(radioTodas).toBeChecked();
  await expect(chip(page, /^Indicadores/)).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, /^Corrida E2E/)).toHaveAttribute('aria-pressed', 'false');
  await expect(chip(page, new RegExp(`^${EXCECAO}`))).toHaveAttribute('aria-pressed', 'false');

  // (2) modo todas: o mesmo aviso vira azul ("já estão entrando").
  await expect(ambar).toHaveCount(0);
  const azul = page.getByRole('status').filter({ hasText: 'já estão entrando' });
  await expect(azul).toHaveCount(1);
  await expect(azul).toContainText(NOVA);
  await expect(azul).toHaveClass(/blue/);

  // marca mais uma exceção
  await chip(page, new RegExp(`^${EXCECAO}`)).click();
  await expect(chip(page, new RegExp(`^${EXCECAO}`))).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('2 exceções · 2 de 4 categorias entram').first()).toBeVisible();
  // nenhum token cru na tela
  await expect(page.locator('body')).not.toContainText(/modo:todas|familia:/);

  // salvar (versão 2 -> 3) e esperar a tela assumir a nova versão
  await page.getByRole('button', { name: 'Salvar versão 3' }).click();
  await expect(page.getByRole('button', { name: 'Salvar versão 4' })).toBeVisible();

  // reabrir: persistiu
  await page.goto(`${HUB}/hub/dashboard/adiantamentos`);
  await abrirConfiguracoes(page);
  await expect(comoContarProducao(page).getByRole('radio', { name: 'Todas, exceto as marcadas' })).toBeChecked();
  await expect(chip(page, /^Indicadores/)).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, new RegExp(`^${EXCECAO}`))).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, /^Corrida E2E/)).toHaveAttribute('aria-pressed', 'false');
  await expect(chipsProducao(page).getByRole('button', { pressed: true })).toHaveCount(2);
  // revisão marcada pelo salvar: a categoria nova deixou de ser "nova"
  await expect(page.getByRole('status').filter({ hasText: 'desde a última revisão' })).toHaveCount(0);
});
