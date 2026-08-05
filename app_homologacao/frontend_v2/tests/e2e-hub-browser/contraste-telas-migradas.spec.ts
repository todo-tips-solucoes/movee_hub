// hub-uiux-refresh FASE 6 (tasks 6.1.1/6.1.2) — auditoria de contraste
// (axe-core, regra `color-contrast`) nas telas migradas pelas FASE 1-4
// (tokens de superfície de Card/Tabela, kpi-card, filter-bar), nos dois
// temas (claro/escuro — FR-010/SC-003, WCAG AA). Reusa o storageState
// `ADMIN_STATE` (mesmo papel `admin_entidade`, todas as permissões dos 6
// módulos abaixo confirmadas em hub_homolog_db) e o padrão de alternância
// de tema já validado em theme-toggle.spec.ts (defaultTheme="dark").
//
// Execução: parte da suíte consolidada de FASE 6, junto com
// white-label-simulacao.spec.ts (reusa o mesmo mecanismo axe filtrado a
// `color-contrast`, mesma convenção de 2.1.5/3.2.3).
import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';
import { ADMIN_STATE } from './global-setup';

const TELAS_MIGRADAS = [
  { nome: 'dashboard', path: '/hub/dashboard' },
  { nome: 'performance (kpi-card)', path: '/hub/dashboard/performance' },
  { nome: 'faturamento (kpi-card)', path: '/hub/dashboard/faturamento' },
  { nome: 'motoristas (filter-bar)', path: '/hub/dashboard/motoristas' },
  { nome: 'importações (filter-bar)', path: '/hub/dashboard/importacoes' },
  { nome: 'usuários (filter-bar)', path: '/hub/dashboard/usuarios' },
];

async function irParaTema(page: Page, tema: 'dark' | 'light') {
  const html = page.locator('html');
  if (tema === 'light') {
    await expect(html).toHaveClass(/dark/); // ponto de partida: default (FR-008)
    await page.getByRole('button', { name: 'Alternar tema' }).click();
    await expect(html).not.toHaveClass(/dark/);
  } else {
    await expect(html).toHaveClass(/dark/);
  }
}

test.describe('6.1 — auditoria de contraste (color-contrast) nas telas migradas, 2 temas', () => {
  test.use({ storageState: ADMIN_STATE, viewport: { width: 1280, height: 800 } });

  for (const tela of TELAS_MIGRADAS) {
    for (const tema of ['dark', 'light'] as const) {
      test(`${tela.nome} — tema ${tema}`, async ({ page }) => {
        await page.goto(tela.path);
        await irParaTema(page, tema);

        const resultado = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
        // eslint-disable-next-line no-console -- evidência consumida pelo driver (6.1.2)
        console.log(
          `AXE_CONTRASTE tela="${tela.path}" tema=${tema} violacoes=${resultado.violations.length}`
        );
        expect(
          resultado.violations,
          `contraste (${tema}) em ${tela.path}: ${JSON.stringify(resultado.violations)}`
        ).toEqual([]);
      });
    }
  }
});
