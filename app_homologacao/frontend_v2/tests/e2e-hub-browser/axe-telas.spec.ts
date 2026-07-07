// hub-shell (S3) FASE 6.3.1/6.3.2 — axe ≥95 nas 6 telas novas do shell.
//
// Paths confirmados nesta onda (achado, corrige e2e-plan.md §4 que pedia
// "confirmar path exatos"): a tela de escolha de entidade vive em
// `/selecionar-entidade` (SEM prefixo `/hub/`, app/selecionar-entidade/
// page.tsx) e o perfil em `/hub/dashboard/perfil` (SEM `/hub/perfil`).
//
// Sessões autenticadas vêm de `storageState` gravado 1x por papel em
// `global-setup.ts` (evita repetir login via UI — ver comentário lá sobre o
// rate limiter de `/auth/login`).
//
// - /hub/login              -> pública, sem auth (contexto padrão, sem storageState)
// - /hub/recuperar-senha    -> pública, sem auth
// - /hub/redefinir-senha    -> pública, sem auth (token ausente não gera
//   erro visível até o submit — routes/hub-auth.js/page.tsx `submeter`)
// - /selecionar-entidade    -> ramo "escolha" (storageState admin, 2 vínculos
//   — sempre mostra a escolha, independente de já ter selecionado antes)
// - /hub/dashboard          -> storageState operador (1 vínculo, já no dashboard)
// - /hub/dashboard/perfil   -> idem, mesma storageState
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { ADMIN_STATE, OPERADOR_STATE } from './global-setup';
import { computeAxeScore, AXE_SCORE_GATE, type AxeViolationLike } from './axe-score';

interface AxeViolationDetalhada extends AxeViolationLike {
  id: string;
  description: string;
  helpUrl?: string;
  nodes: Array<{ target?: unknown; failureSummary?: string }>;
}

function relatarEAssert(nome: string, violations: AxeViolationDetalhada[]) {
  const score = computeAxeScore(violations);
  // eslint-disable-next-line no-console -- saída consumida pelo driver shell p/ evidências (6.5.2)
  console.log(
    `AXE_RESULT tela="${nome}" score=${score} violacoes=${violations.length} detalhe=${JSON.stringify(
      violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        description: v.description,
        nodes: v.nodes.map((n) => n.target),
      }))
    )}`
  );
  expect(score, `axe score de "${nome}" abaixo do gate ${AXE_SCORE_GATE}`).toBeGreaterThanOrEqual(
    AXE_SCORE_GATE
  );
}

test.describe('6.3 — axe ≥95 nas telas novas do shell (públicas, sem sessão)', () => {
  test('/hub/login', async ({ page }) => {
    await page.goto('/hub/login');
    const results = await new AxeBuilder({ page }).analyze();
    relatarEAssert('/hub/login', results.violations);
  });

  test('/hub/recuperar-senha', async ({ page }) => {
    await page.goto('/hub/recuperar-senha');
    const results = await new AxeBuilder({ page }).analyze();
    relatarEAssert('/hub/recuperar-senha', results.violations);
  });

  test('/hub/redefinir-senha', async ({ page }) => {
    await page.goto('/hub/redefinir-senha');
    const results = await new AxeBuilder({ page }).analyze();
    relatarEAssert('/hub/redefinir-senha', results.violations);
  });
});

test.describe('6.3 — axe ≥95 nas telas novas do shell (autenticadas, storageState admin)', () => {
  test.use({ storageState: ADMIN_STATE });

  test('/selecionar-entidade (ramo escolha, 2 vínculos)', async ({ page }) => {
    await page.goto('/selecionar-entidade');
    await expect(page.getByRole('heading', { name: 'Selecionar entidade' })).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    relatarEAssert('/selecionar-entidade', results.violations);
  });
});

test.describe('6.3 — axe ≥95 nas telas novas do shell (autenticadas, storageState operador)', () => {
  test.use({ storageState: OPERADOR_STATE });

  test('/hub/dashboard', async ({ page }) => {
    await page.goto('/hub/dashboard');
    const results = await new AxeBuilder({ page }).analyze();
    relatarEAssert('/hub/dashboard', results.violations);
  });

  test('/hub/dashboard/perfil', async ({ page }) => {
    await page.goto('/hub/dashboard/perfil');
    const results = await new AxeBuilder({ page }).analyze();
    relatarEAssert('/hub/dashboard/perfil', results.violations);
  });
});
