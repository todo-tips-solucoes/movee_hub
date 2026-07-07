// hub-shell (S3) FASE 6.2.3 (parte UI) — troca de entidade reflete os dados
// exibidos em MENOS DE 5 SEGUNDOS, sem novo login (SC-003).
//
// A parte de API já está verde (infra/hub/testes/hub-shell-e2e-homolog.sh:
// POST /me/entidade A->B reflete em GET /me sem novo login). Esta onda mede
// o tempo de PONTA A PONTA na UI real: clique no EntitySwitcher até o
// próprio combobox exibir o rótulo da nova entidade (fonte da verdade do
// componente — `value` vem de `entidadeAtiva`, contexts/hub-auth-context.tsx
// `trocarEntidade` -> `refetchMe()`).
//
// Sessão vem de `storageState` gravado 1x em global-setup.ts (ver comentário
// lá sobre o rate limiter de /auth/login).
import { test, expect } from '@playwright/test';
import { ADMIN_STATE } from './global-setup';

test.describe('6.2.3 — troca de entidade reflete em <5s, sem novo login (SC-003)', () => {
  test.use({ storageState: ADMIN_STATE });

  test('EntitySwitcher atualiza o rótulo exibido em menos de 5s', async ({ page }) => {
    await page.goto('/hub/dashboard');

    const combobox = page.getByRole('combobox', { name: 'Trocar entidade de trabalho' });
    await expect(combobox).toBeVisible();
    // Extrai só "Empresa #<id>" (o trigger também expõe o glifo do chevron
    // no textContent — comparar a string completa faz `hasNotText` falhar
    // em distinguir as opções, achado desta onda).
    const idInicial = (await combobox.textContent())?.match(/Empresa #(\d+)/)?.[1];
    expect(idInicial, 'não foi possível extrair o id da entidade ativa do combobox').toBeTruthy();

    const inicio = Date.now();
    await combobox.click();
    // A opção com id DIFERENTE do atualmente selecionado.
    const opcaoAlvo = page.getByRole('option').filter({ hasNotText: `Empresa #${idInicial}` }).first();
    await opcaoAlvo.click();

    await expect(combobox).not.toContainText(`Empresa #${idInicial}`, { timeout: 5_000 });
    const decorridoMs = Date.now() - inicio;

    // eslint-disable-next-line no-console -- saída consumida pelo driver shell p/ evidências (6.5.3)
    console.log(`TROCA_ENTIDADE_TIMING_MS=${decorridoMs}`);
    expect(decorridoMs, 'troca de entidade excedeu 5s (SC-003)').toBeLessThan(5_000);

    // Continua na mesma URL (sem novo login/redirect) — só o conteúdo mudou.
    await expect(page).toHaveURL(/\/hub\/dashboard$/);
  });
});
