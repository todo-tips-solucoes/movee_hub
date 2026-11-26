// Fase 12 (0133): app do motorista com a campanha encerrada e data do prêmio definida (T+6).
// Bruno (1º, objeto): "Entrega prevista em DD/MM". Carla (2ª, dinheiro): "Pagamento previsto em DD/MM".
import { test, expect } from '@playwright/test';
import { APP, ddmm, env, loginApp, somaDias } from './_comum';

for (const [rotulo, cnpjVar, premio, status, posicao] of [
  ['Bruno (objeto)', 'CAMP_MOT_BRUNO_CNPJ', 'Bag E2E', 'Entrega prevista em', '1º'],
  ['Carla (dinheiro)', 'CAMP_MOT_CARLA_CNPJ', 'R$ 50 no repasse', 'Pagamento previsto em', '2º'],
] as const) {
  test(`e) app: ${rotulo} vê a data prevista do prêmio`, async ({ page }) => {
    await loginApp(page, env(cnpjVar), env('CAMP_MOT_SENHA'));
    await page.goto(`${APP}/campanhas/${env('CAMP_ID')}`);
    await expect(page.getByText('Resultado final', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(`Você ficou em ${posicao} lugar`);
    await expect(page.getByText('Seu prêmio')).toBeVisible();
    await expect(page.getByText(premio)).toBeVisible();
    const d = ddmm(somaDias(env('CAMP_T'), 6));
    await expect(page.getByText(`${status} ${d}`, { exact: true })).toBeVisible();
    await expect(page.getByText(`Prêmio em objeto: entrega prevista em ${d}. Prêmio em dinheiro: pagamento previsto em ${d}.`)).toBeVisible();
    await expect(page.getByText(/Aparece no seu repasse|combina a entrega/)).toHaveCount(0);
  });
}
