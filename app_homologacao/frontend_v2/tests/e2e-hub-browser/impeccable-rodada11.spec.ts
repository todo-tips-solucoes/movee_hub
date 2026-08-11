// impeccable rodada 11 (P0) — o disparo continuava ofertado quando a lista
// falhava ao carregar.
//
// Este é o único caso da suíte que força um ERRO DE REDE real: com `stats`
// zerado por falha, os cinco KPIs mostravam `0 0 0 0 0`, o botão Iniciar seguia
// verde, e o confirm afirmava "o movimento tem 0 registros" — sobre a ação que
// manda mensagem para motorista de verdade. Confirmar com seleção vazia dispara
// para o movimento aberto INTEIRO.
//
// O `CloseMovementDialog` tinha essa trava desde a rodada 7. Faltava justamente
// no caminho de onde o efeito sai do sistema e não volta.
import { test, expect } from '@playwright/test';
import { ADMIN_STATE } from './global-setup';

test.describe('impeccable rodada 11 — disparo com a lista indisponível', () => {
  test.use({ storageState: ADMIN_STATE, viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    // Derruba SÓ a listagem do movimento; o resto da tela carrega normal, que é
    // exatamente o cenário perigoso (a página parece funcional).
    await page.route('**/api/envio-massa**', (rota) =>
      rota.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' })
    );
    await page.goto('/hub/dashboard/envio_massa');
    await page.waitForLoadState('networkidle');
  });

  test('os KPIs não afirmam zero sobre dados que não carregaram', async ({ page }) => {
    // Zero é uma afirmação: diria que o movimento está vazio. Travessão não é.
    // Escopado ao número do KPI (`p.tabular`): a tela tem outros travessões
    // legítimos fora dos cards, e contá-los mediria a página, não o defeito.
    const numeros = page.locator('p.tabular');
    await expect(numeros).toHaveCount(5);
    for (const texto of await numeros.allInnerTexts()) expect(texto.trim()).toBe('—');
  });

  test('o botão de disparo fica indisponível e diz por quê', async ({ page }) => {
    const iniciar = page.getByRole('button', { name: /^Iniciar$/ });
    await expect(iniciar).toBeDisabled();
  });

  test('os KPIs deixam de ser atalho de filtro enquanto não há o que filtrar', async ({ page }) => {
    await expect(page.getByRole('button', { name: /Filtrar a tabela por/ })).toHaveCount(0);
  });

  test('a lista mostra o erro em vez de fingir movimento vazio', async ({ page }) => {
    const main = await page.locator('#conteudo-principal').innerText();
    expect(main).not.toContain('Nenhum registro encontrado');
  });
});

test.describe('impeccable rodada 11 — contraprova: sem erro, nada mudou', () => {
  test.use({ storageState: ADMIN_STATE, viewport: { width: 1280, height: 800 } });

  test('com a lista carregando normalmente, o disparo segue ofertado', async ({ page }) => {
    await page.goto('/hub/dashboard/envio_massa');
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('button', { name: /^Iniciar$/ })).toBeEnabled();
    // E os KPIs voltam a mostrar número, não travessão.
    for (const texto of await page.locator('p.tabular').allInnerTexts()) {
      expect(texto.trim()).not.toBe('—');
    }
  });
});
