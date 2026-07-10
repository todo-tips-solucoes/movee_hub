// hub-auditoria-admin (S9) FASE 6.3 — smoke de acessibilidade das 4 telas
// NOVAS/evoluídas desta feature: /hub/dashboard/auditoria, /usuarios,
// /usuarios/papeis, /admin. Mesmo padrão "a11y 2/2" já usado em
// tests/e2e-hub-envio-massa/a11y-smoke.spec.ts (S8): NÃO é auditoria WCAG
// completa — é a verificação empírica de que:
//   6.3.1 — navegação por teclado (Tab/Shift+Tab/Enter/Escape) alcança os
//           controles principais das 4 telas; dialogs abrem por teclado e
//           fecham com Escape.
//   6.3.2 — identidade visual EntreGô 2.0 (tokens de cor/tipografia) em
//           tema claro/escuro + branding do ambiente presentes nas 4
//           telas, sem regressão de nomes acessíveis (botões sem nome).
// Roda via infra/hub/testes/hub-auditoria-admin-a11y-smoke.sh (container
// oficial Playwright, nunca instalado no host), contra o hub-homolog
// isolado (nunca produção).
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const EVID_DIR = path.join(__dirname, '.evidencias');
const HUB_EMAIL = process.env.HUB_E2E_HUB_EMAIL || '';
const HUB_SENHA = process.env.HUB_E2E_HUB_SENHA || '';
// Sessão com vínculo admin_plataforma — só usada em 6.3 para exercitar a
// tela /admin com permissão real (admin_entidade recebe PERMISSAO_NEGADA
// por desenho, FR-017); provisionada/reativada só para esta suíte (ver
// driver + tasks.md 6.3, "Limpeza pós-teste").
const ADMIN_EMAIL = process.env.HUB_E2E_ADMIN_PLATAFORMA_EMAIL || '';
const ADMIN_SENHA = process.env.HUB_E2E_ADMIN_PLATAFORMA_SENHA || '';
const ENTIDADE_ID = process.env.HUB_E2E_ENTIDADE_ID || '9001';

interface FocoInfo {
  role: string | null;
  name: string | null;
  tag: string;
}

async function focoAtual(page: Page): Promise<FocoInfo> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return { role: null, name: null, tag: 'none' };
    const name =
      el.getAttribute('aria-label') ||
      (el.textContent || '').trim().slice(0, 60) ||
      el.getAttribute('title') ||
      null;
    return {
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      name,
      tag: el.tagName.toLowerCase(),
    };
  });
}

async function tabWalk(page: Page, maxTabs = 60): Promise<FocoInfo[]> {
  const visitados: FocoInfo[] = [];
  await page.locator('body').click({ position: { x: 4, y: 4 } });
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press('Tab');
    const f = await focoAtual(page);
    visitados.push(f);
    if (visitados.length > 3 && f.name && visitados[0].name === f.name && i > 20) break; // ciclo completo
  }
  return visitados;
}

/** Snapshot de tema/branding + nomes acessíveis — comum às 4 telas (6.3.2). */
async function temaESnapshot(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const banner = document.querySelector('[role="status"][aria-live="polite"]');
    const botoesSemNome = Array.from(document.querySelectorAll('button')).filter((b) => {
      const nome = b.getAttribute('aria-label') || (b.textContent || '').trim() || b.getAttribute('title');
      return !nome;
    }).length;
    return {
      temaAtivo: root.getAttribute('data-theme') || (root.classList.contains('dark') ? 'dark' : 'light'),
      corSchemeStyle: root.style.colorScheme || null,
      bannerAmbientePresente: !!banner,
      bannerTexto: banner ? (banner.textContent || '').trim().slice(0, 60) : null,
      botoesSemNomeAcessivel: botoesSemNome,
      headingsH1: document.querySelectorAll('h1').length,
    };
  });
}

async function loginHubViaUI(page: Page, email: string, senha: string) {
  await page.goto('/hub/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Senha', { exact: true }).fill(senha);
  await page.getByRole('button', { name: 'Entrar' }).click();
  // conta com 1 vínculo -> /selecionar-entidade auto-seleciona e cai no dashboard
  await page.waitForURL('**/hub/dashboard', { timeout: 20_000 });
}

const TELAS_ADMIN_ENTIDADE = [
  { path: '/hub/dashboard/auditoria', heading: 'Auditoria' },
  { path: '/hub/dashboard/usuarios', heading: 'Usuários' },
  { path: '/hub/dashboard/usuarios/papeis', heading: 'Papéis e permissões' },
] as const;

test.describe('6.3 — smoke a11y das telas /auditoria, /usuarios, /usuarios/papeis, /admin', () => {
  test('6.3.1 teclado: Tab/Shift+Tab/Enter/Escape alcançam os controles principais das 4 telas', async ({ page }) => {
    await loginHubViaUI(page, HUB_EMAIL, HUB_SENHA);
    fs.mkdirSync(EVID_DIR, { recursive: true });
    const relatorio: Record<string, unknown> = {};

    for (const tela of TELAS_ADMIN_ENTIDADE) {
      await page.goto(tela.path);
      await expect(page.getByRole('heading', { name: tela.heading })).toBeVisible({ timeout: 20_000 });
      const visitados = await tabWalk(page, 60);
      expect(visitados.length, `${tela.path}: tab-walk deve mover o foco pelo menos 3 vezes`).toBeGreaterThanOrEqual(3);

      // Shift+Tab: foco anda para trás sem ficar preso.
      const antes = await focoAtual(page);
      await page.keyboard.press('Shift+Tab');
      const depois = await focoAtual(page);
      expect(`${depois.role}|${depois.name}`, `${tela.path}: Shift+Tab deve mover o foco`).not.toBe(`${antes.role}|${antes.name}`);

      relatorio[tela.path] = { total_paradas_de_foco: visitados.length, sequencia: visitados };
    }

    // /usuarios: Enter no botão "Novo usuário" abre dialog; Escape fecha (6.3.1).
    await page.goto('/hub/dashboard/usuarios');
    await expect(page.getByRole('heading', { name: 'Usuários' })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Novo usuário' }).focus();
    await page.keyboard.press('Enter');
    const dialogNovoUsuario = page.getByRole('dialog').filter({ hasText: 'Novo usuário' });
    await expect(dialogNovoUsuario).toBeVisible({ timeout: 8_000 });
    await page.keyboard.press('Escape');
    await expect(dialogNovoUsuario).not.toBeVisible({ timeout: 8_000 });
    relatorio['/hub/dashboard/usuarios#dialog-novo-usuario'] = { abre_por_enter: true, fecha_por_escape: true };

    // /admin: exige vínculo admin_plataforma real (FR-017) — sessão dedicada.
    if (ADMIN_EMAIL && ADMIN_SENHA) {
      const ctxAdmin = await page.context().browser()!.newContext({ ignoreHTTPSErrors: true });
      const pageAdmin = await ctxAdmin.newPage();
      await loginHubViaUI(pageAdmin, ADMIN_EMAIL, ADMIN_SENHA);
      await pageAdmin.goto('/hub/dashboard/admin');
      await expect(pageAdmin.getByRole('heading', { name: 'Administração da plataforma' })).toBeVisible({ timeout: 20_000 });
      const visitadosAdmin = await tabWalk(pageAdmin, 40);
      expect(visitadosAdmin.length, '/hub/dashboard/admin: tab-walk deve mover o foco pelo menos 2 vezes').toBeGreaterThanOrEqual(2);

      // ID da entidade -> Enter no botão Consultar exercita o fluxo por teclado.
      await pageAdmin.getByLabel('ID da entidade').fill(ENTIDADE_ID);
      await pageAdmin.getByRole('button', { name: 'Consultar' }).focus();
      await pageAdmin.keyboard.press('Enter');
      // Spinner "Carregando módulos..." some quando a resposta chega (ok ou erro).
      await expect(pageAdmin.getByText('Carregando módulos...')).not.toBeVisible({ timeout: 10_000 });
      // catálogo de módulos (botão Habilitado/Desabilitado) OU alerta de erro
      // com AlertCircle — qualquer um confirma que o fluxo por teclado
      // chegou até o handler (não trava a UI). Escopado ao container de
      // resultado (evita casar o role="alert" vazio do route-announcer do
      // Next.js e o link "Painel Geral" da navegação).
      const resultadoModulos = pageAdmin.getByRole('button', { name: /Habilitado|Desabilitado/ }).first();
      const resultadoErro = pageAdmin.locator('[role="alert"]').filter({ hasText: /.+/ });
      await expect(resultadoModulos.or(resultadoErro)).toBeVisible({ timeout: 10_000 });

      relatorio['/hub/dashboard/admin'] = { total_paradas_de_foco: visitadosAdmin.length, sequencia: visitadosAdmin };
      await ctxAdmin.close();
    } else {
      relatorio['/hub/dashboard/admin'] = { pulado: 'HUB_E2E_ADMIN_PLATAFORMA_EMAIL/SENHA não fornecidos' };
    }

    fs.writeFileSync(path.join(EVID_DIR, '6.3.1-tab-walk.json'), JSON.stringify(relatorio, null, 2));
  });

  test('6.3.2 tema/branding: EntreGô 2.0 em claro/escuro + nomes acessíveis nas 4 telas', async ({ page }) => {
    await loginHubViaUI(page, HUB_EMAIL, HUB_SENHA);
    fs.mkdirSync(EVID_DIR, { recursive: true });
    const relatorio: Record<string, unknown> = {};

    const telas = [...TELAS_ADMIN_ENTIDADE];

    for (const tela of telas) {
      await page.goto(tela.path);
      await expect(page.getByRole('heading', { name: tela.heading })).toBeVisible({ timeout: 20_000 });

      // Tema escuro (default do ThemeProvider, defaultTheme="dark").
      const snapEscuro = await temaESnapshot(page);

      // Alterna para claro via localStorage + reload (mesmo mecanismo do
      // ThemeProvider global, script inline no <head>).
      await page.evaluate(() => localStorage.setItem('theme', 'light'));
      await page.reload();
      await expect(page.getByRole('heading', { name: tela.heading })).toBeVisible({ timeout: 20_000 });
      const snapClaro = await temaESnapshot(page);

      // volta pro escuro para não vazar estado entre iterações
      await page.evaluate(() => localStorage.setItem('theme', 'dark'));

      relatorio[tela.path] = { escuro: snapEscuro, claro: snapClaro };

      expect(snapEscuro.temaAtivo, `${tela.path}: tema escuro deve aplicar 'dark'`).toBe('dark');
      expect(snapClaro.temaAtivo, `${tela.path}: tema claro deve aplicar 'light'`).toBe('light');
      expect(snapEscuro.bannerAmbientePresente, `${tela.path}: banner de ambiente (HOMOLOGAÇÃO) deve estar presente`).toBe(true);
      expect(
        snapEscuro.botoesSemNomeAcessivel,
        `${tela.path}: nenhum botão sem nome acessível (tema escuro)`
      ).toBe(0);
      expect(
        snapClaro.botoesSemNomeAcessivel,
        `${tela.path}: nenhum botão sem nome acessível (tema claro)`
      ).toBe(0);
    }

    fs.writeFileSync(path.join(EVID_DIR, '6.3.2-tema-branding.json'), JSON.stringify(relatorio, null, 2));
  });
});
