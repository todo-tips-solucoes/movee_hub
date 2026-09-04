// hub-motorista-360 — FASE 8 (tasks.md 8.2.1/8.2.2): E2E real da tela de
// detalhe do motorista (app/hub/dashboard/motoristas/[id]/page.tsx),
// cobrindo os 2 cenários pedidos pelo operador:
//   8.2.1 — gestor (admin_entidade) abre o detalhe, aciona a busca de
//           enriquecimento EntreGô (botão "Buscar dados EntreGô") e — para
//           um motorista já enriquecido — vê os campos preenchidos.
//   8.2.2 — perfil `leitura` NÃO vê os campos sensíveis na UI: a checagem é
//           pela AUSÊNCIA do elemento (CampoRestrito -> "acesso restrito"),
//           nunca por string vazia (FR-013 omite a chave no JSON; o
//           componente reage a isso renderizando um placeholder distinto de
//           "não informado").
//
// Roda via infra/hub/testes/hub-motorista-360-e2e-browser.sh (container
// oficial Playwright, nunca instalado no host), contra o hub-homolog
// isolado (nunca produção). 2 fixtures Entregador seedadas pelo driver
// (via psql direto, fora deste spec — specs não têm acesso a docker):
//   HUB_E2E_ENT_PENDENTE_ID    — id_externo setado, AINDA não enriquecido
//                                  (prova o "aciona a busca": clique -> 202
//                                  -> estado pendente na UI).
//   HUB_E2E_ENT_ENRIQUECIDO_ID — JÁ enriquecido (dados_entrego_json seedado
//                                  direto, simulando o worker já ter
//                                  rodado) — prova "vê os campos
//                                  preenchidos" (8.2.1) e a máscara RBAC
//                                  (8.2.2).
//
// 🔴 dec-072: nenhuma URL de foto de documento é seedada/exibida/asserta
// aqui — o backend nunca as envia (FR-013/FR-014 só cobrem os campos de
// texto declarados no contrato). PII: todo dado seedado é sintético
// (prefixo "E2E360" / "SINTETICO-"), nunca dado real.
import { test, expect, type Page } from '@playwright/test';

const ADMIN_EMAIL = process.env.HUB_E2E_ADMIN_EMAIL || '';
const ADMIN_SENHA = process.env.HUB_E2E_ADMIN_SENHA || '';
const LEITURA_EMAIL = process.env.HUB_E2E_LEITURA_EMAIL || '';
const LEITURA_SENHA = process.env.HUB_E2E_LEITURA_SENHA || '';
const ENT_PENDENTE_ID = process.env.HUB_E2E_ENT_PENDENTE_ID || '';
const ENT_ENRIQUECIDO_ID = process.env.HUB_E2E_ENT_ENRIQUECIDO_ID || '';

test.beforeAll(() => {
  for (const [nome, valor] of [
    ['HUB_E2E_ADMIN_EMAIL', ADMIN_EMAIL],
    ['HUB_E2E_ADMIN_SENHA', ADMIN_SENHA],
    ['HUB_E2E_LEITURA_EMAIL', LEITURA_EMAIL],
    ['HUB_E2E_LEITURA_SENHA', LEITURA_SENHA],
    ['HUB_E2E_ENT_PENDENTE_ID', ENT_PENDENTE_ID],
    ['HUB_E2E_ENT_ENRIQUECIDO_ID', ENT_ENRIQUECIDO_ID],
  ]) {
    if (!valor) throw new Error(`env var ${nome} ausente — driver não seedou corretamente`);
  }
});

async function loginHubViaUI(page: Page, email: string, senha: string) {
  await page.goto('/hub/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Senha', { exact: true }).fill(senha);
  await page.getByRole('button', { name: 'Entrar' }).click();
  // ambas as contas QA (admin_entidade/leitura) têm 1 único vínculo (empresa
  // 9001) -> /selecionar-entidade auto-seleciona e cai no dashboard.
  await page.waitForURL('**/hub/dashboard', { timeout: 20_000 });
}

test.describe('FASE 8.2 — detalhe do motorista: busca EntreGô + RBAC de campo', () => {
  test('8.2.1 — gestor aciona a busca EntreGô (pendente) e vê os campos de um motorista já enriquecido', async ({ page }) => {
    await loginHubViaUI(page, ADMIN_EMAIL, ADMIN_SENHA);

    // ── parte A: aciona a busca (motorista SEM enriquecimento prévio) ──────
    await page.goto(`/hub/dashboard/motoristas/${ENT_PENDENTE_ID}`);
    await expect(page.getByRole('heading', { name: 'Dados da EntreGô' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Nenhum dado buscado ainda.')).toBeVisible();

    const botaoBuscar = page.getByRole('button', { name: 'Buscar dados EntreGô' });
    await expect(botaoBuscar).toBeVisible();
    await expect(botaoBuscar).toBeEnabled();
    await botaoBuscar.click();

    await expect(page.getByText('Busca solicitada — aguardando o processamento.')).toBeVisible({ timeout: 15_000 });

    // ── parte B: motorista JÁ enriquecido -> campos preenchidos ─────────────
    await page.goto(`/hub/dashboard/motoristas/${ENT_ENRIQUECIDO_ID}`);
    await expect(page.getByRole('heading', { name: 'Dados da EntreGô' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/^Buscado em:/)).toBeVisible();

    // admin_entidade tem motoristas.dados_sensiveis -> vê TUDO, valores reais.
    await expect(page.getByText('E2E360 Nome EntreGo C')).toBeVisible(); // Nome completo
    await expect(page.getByText('SINTETICO-CNH-99999999999')).toBeVisible();
    await expect(page.getByText('SINTETICO-RG-22.222.222-2')).toBeVisible();
    await expect(page.getByText('sintetico360c@example.invalid')).toBeVisible();
    await expect(page.getByText('SINTETICO-CPF-222.222.222-22')).toBeVisible();
    await expect(page.getByText('SINTETICO Mae C')).toBeVisible();
    await expect(page.getByText('SINTETICO Pai C')).toBeVisible();
    await expect(page.getByText(/SINTETICO Contato C/)).toBeVisible(); // contato de emergência
    await expect(page.getByText('acesso restrito')).toHaveCount(0); // nenhum campo mascarado p/ admin
  });

  test('8.2.2 — perfil leitura NÃO vê os campos sensíveis (ausência do elemento, nunca string vazia)', async ({ page }) => {
    await loginHubViaUI(page, LEITURA_EMAIL, LEITURA_SENHA);

    await page.goto(`/hub/dashboard/motoristas/${ENT_ENRIQUECIDO_ID}`);
    await expect(page.getByRole('heading', { name: 'Dados da EntreGô' })).toBeVisible({ timeout: 20_000 });

    // leitura não tem motoristas.editar -> botão de busca nem aparece.
    await expect(page.getByRole('button', { name: 'Buscar dados EntreGô' })).toHaveCount(0);

    // campos NUNCA sensíveis: continuam visíveis com o valor real.
    await expect(page.getByText('E2E360 Nome EntreGo C')).toBeVisible();

    // campos SENSÍVEIS: label continua visível, mas com "acesso restrito" —
    // NUNCA o valor real, e a asserção é pela ausência do VALOR (não por
    // string vazia — o backend omite a CHAVE inteira do JSON, FR-013).
    // dec-087: CNH entrou na lista (mesmo tratamento do RG — mesmo tipo de
    // documento, mesma tela).
    await expect(page.getByText('SINTETICO-CNH-99999999999')).toHaveCount(0);
    await expect(page.getByText('SINTETICO-RG-22.222.222-2')).toHaveCount(0);
    await expect(page.getByText('sintetico360c@example.invalid')).toHaveCount(0);
    await expect(page.getByText('SINTETICO-CPF-222.222.222-22')).toHaveCount(0);
    await expect(page.getByText('SINTETICO Mae C')).toHaveCount(0);
    await expect(page.getByText('SINTETICO Pai C')).toHaveCount(0);
    await expect(page.getByText(/SINTETICO Contato C/)).toHaveCount(0);

    // CNH + RG + 4 campos de dadosPessoais (e-mail/CPF/mãe/pai) + contato de
    // emergência -> pelo menos 6 "acesso restrito" visíveis (CampoRestrito).
    const restritos = page.getByText('acesso restrito');
    await expect(restritos.first()).toBeVisible();
    expect(await restritos.count()).toBeGreaterThanOrEqual(6);
  });
});
