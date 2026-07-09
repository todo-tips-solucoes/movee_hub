// hub-envio-massa (S8) FASE 5.2 — smoke de acessibilidade da MONTAGEM nova
// (/hub/dashboard/envio_massa) sobre componentes 100% reaproveitados do
// painel legado (tasks.md 5.2.1-5.2.3, fecha CHK031).
//
// NÃO é auditoria WCAG completa (a spec não pede) — é a verificação empírica
// de que o reuso dentro do shell do hub não quebrou foco/tab-order/ARIA que
// os componentes já tinham no painel legado:
//   5.2.1 — navegação por teclado (Tab/Shift+Tab/Enter/Escape) alcança os
//           controles de upload, processo, validação XML, edição, fechamento
//           e exportação; dialogs abrem por teclado e fecham com Escape.
//   5.2.2 — inspeção de atributos ARIA dos componentes reaproveitados na
//           montagem HUB comparada à MESMA inspeção no painel LEGADO
//           (/dashboard, mesmo build, sessão legada) — sem regressão.
//   5.2.3 — resultado gravado em .evidencias/ (o driver copia para
//           docs/specs/hub-envio-massa/evidencias/).
//
// Roda via infra/hub/testes/hub-envio-massa-a11y-smoke.sh (container oficial
// Playwright, nunca instalado no host), contra o hub-homolog isolado.
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const EVID_DIR = path.join(__dirname, '.evidencias');
const HUB_EMAIL = process.env.HUB_E2E_HUB_EMAIL || '';
const HUB_SENHA = process.env.HUB_E2E_HUB_SENHA || '';
const LEGADO_EMAIL = process.env.HUB_E2E_LEGADO_EMAIL || '';
const LEGADO_SENHA = process.env.HUB_E2E_LEGADO_SENHA || '';

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

/** Snapshot ARIA dos componentes reaproveitados (5.2.2) — mesmos seletores
 * nas duas montagens (hub e legado), para comparação estrutural. */
async function ariaSnapshot(page: Page) {
  return page.evaluate(() => {
    const q = (sel: string) => document.querySelectorAll(sel).length;
    const nomes = (sel: string) =>
      Array.from(document.querySelectorAll(sel))
        .map((e) => e.getAttribute('aria-label'))
        .filter(Boolean)
        .map((s) => (s as string).replace(/registro .*$/, 'registro <nome>'))
        .sort();
    return {
      botoes_editar: q('button[aria-label^="Editar registro"]'),
      botoes_excluir: q('button[aria-label^="Excluir registro"]'),
      aria_labels_normalizados: [...new Set([...nomes('button[aria-label]'), ...nomes('[role="button"][aria-label]')])],
      tabelas: q('table'),
      checkboxes: q('input[type="checkbox"], [role="checkbox"]'),
      upload_xml_area: q('[aria-label^="Area de upload de arquivos XML"]'),
      inputs_arquivo_acessiveis: q('input[type="file"][aria-label]'),
      botoes_sem_nome_acessivel: Array.from(document.querySelectorAll('button')).filter((b) => {
        const nome = b.getAttribute('aria-label') || (b.textContent || '').trim() || b.getAttribute('title');
        return !nome;
      }).length,
    };
  });
}

async function loginHubViaUI(page: Page) {
  await page.goto('/hub/login');
  await page.getByLabel('Email', { exact: true }).fill(HUB_EMAIL);
  await page.getByLabel('Senha', { exact: true }).fill(HUB_SENHA);
  await page.getByRole('button', { name: 'Entrar' }).click();
  // conta com 1 vínculo: /selecionar-entidade auto-seleciona e cai no dashboard
  await page.waitForURL('**/hub/dashboard', { timeout: 20_000 });
}

test.describe('5.2 — smoke a11y da montagem /hub/dashboard/envio_massa', () => {
  test('5.2.1 teclado: Tab/Shift+Tab/Enter/Escape alcançam upload/processo/validação/edição/fechamento/exportação', async ({ page }) => {
    await loginHubViaUI(page);
    await page.goto('/hub/dashboard/envio_massa');
    // dado real da seed 0034 (empresa 9001) — tabela montada com linhas
    await expect(page.getByText('Motorista QA Aberto').filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });

    // ── Tab-walk: percorre até 80 Tab e registra cada elemento focado ──────
    const visitados: FocoInfo[] = [];
    await page.locator('body').click({ position: { x: 4, y: 4 } }); // foco no topo do documento
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press('Tab');
      const f = await focoAtual(page);
      visitados.push(f);
      if (visitados.length > 3 && f.name && visitados[0].name === f.name && i > 40) break; // ciclo completo
    }
    const nomesVisitados = visitados.map((v) => (v.name || '').toLowerCase());
    const alcanca = (fragmento: string) => nomesVisitados.some((n) => n.includes(fragmento.toLowerCase()));

    const cobertura = {
      processo_iniciar_ou_parar: alcanca('Iniciar') || alcanca('Parar'),
      upload_importar: alcanca('Importar XLSX') || alcanca('Soltar aqui'),
      exportacao_csv: alcanca('Exportar CSV'),
      exportacao_xml: alcanca('Download XML'),
      fechamento: alcanca('Fechar Movimento'),
      edicao: alcanca('Editar registro'),
      validacao_xml: alcanca('upload de arquivos XML') || alcanca('Selecionar arquivos XML'),
    };
    fs.mkdirSync(EVID_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(EVID_DIR, '5.2.1-tab-walk.json'),
      JSON.stringify({ total_paradas_de_foco: visitados.length, cobertura, sequencia: visitados }, null, 2)
    );
    for (const [acao, ok] of Object.entries(cobertura)) {
      expect(ok, `tab-order não alcançou o controle de "${acao}"`).toBe(true);
    }

    // ── Shift+Tab: foco anda para trás sem ficar preso ──────────────────────
    const antes = await focoAtual(page);
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    const depois = await focoAtual(page);
    expect(`${depois.role}|${depois.name}`).not.toBe(`${antes.role}|${antes.name}`);

    // ── Enter abre dialog de fechamento; Escape fecha ───────────────────────
    await page.getByRole('button', { name: 'Fechar Movimento' }).focus();
    await page.keyboard.press('Enter');
    const dialogFechar = page.getByRole('alertdialog');
    await expect(dialogFechar).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press('Escape');
    await expect(dialogFechar).not.toBeVisible({ timeout: 5_000 });

    // ── Enter abre dialog de edição; Escape fecha ───────────────────────────
    const btnEditar = page.locator('button[aria-label^="Editar registro"]').filter({ visible: true }).first();
    await btnEditar.focus();
    await page.keyboard.press('Enter');
    // EditDialog é o Dialog do design-system (Base UI) — role="dialog"; usa
    // getByRole que casa tanto "dialog" quanto o título "Editar Registro".
    const dialogEditar = page.getByRole('dialog').filter({ hasText: /Editar/i }).first();
    await expect(dialogEditar).toBeVisible({ timeout: 8_000 });
    await page.keyboard.press('Escape');
    await expect(dialogEditar).not.toBeVisible({ timeout: 8_000 });

    // ── Enter abre dialog de importação (upload); Escape fecha ─────────────
    await page.getByRole('button', { name: /Importar XLSX/ }).focus();
    await page.keyboard.press('Enter');
    // ImportButton abre file-picker nativo? Não: o Dialog "Periodo da movimentacao"
    // abre após a seleção de arquivo — aqui só confirmamos que o botão é
    // focável/acionável por teclado sem lançar erro (o file-picker nativo não é
    // scriptável; o fluxo completo de upload já está coberto pelo E2E de API).
  });

  test('5.2.2 ARIA: montagem hub sem regressão vs painel legado (mesmos componentes)', async ({ page, browser }) => {
    // — Montagem HUB —
    await loginHubViaUI(page);
    await page.goto('/hub/dashboard/envio_massa');
    await expect(page.getByText('Motorista QA Aberto').filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
    const snapHub = await ariaSnapshot(page);

    // — Montagem LEGADA (mesmo build, sessão legada via POST /api/login) —
    const ctxLegado = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: page.url().split('/hub/')[0] });
    const pageLegado = await ctxLegado.newPage();
    const rLogin = await pageLegado.request.post('/api/login', {
      data: { email: LEGADO_EMAIL, password: LEGADO_SENHA },
    });
    expect(rLogin.status(), 'login legado via proxy deve responder 200').toBe(200);
    await pageLegado.goto('/dashboard');
    await expect(pageLegado.getByText('Motorista QA Aberto').filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
    const snapLegado = await ariaSnapshot(pageLegado);
    await ctxLegado.close();

    fs.mkdirSync(EVID_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(EVID_DIR, '5.2.2-aria-hub-vs-legado.json'),
      JSON.stringify({ hub: snapHub, legado: snapLegado }, null, 2)
    );

    // Sem regressão: tudo que o legado expõe de semântica, o hub também expõe.
    expect(snapHub.botoes_editar, 'botões Editar acessíveis presentes no hub').toBeGreaterThanOrEqual(1);
    expect(snapHub.botoes_editar).toBe(snapLegado.botoes_editar);
    expect(snapHub.botoes_excluir).toBe(snapLegado.botoes_excluir);
    expect(snapHub.tabelas).toBeGreaterThanOrEqual(snapLegado.tabelas);
    expect(
      snapHub.botoes_sem_nome_acessivel,
      'hub não pode ter MAIS botões sem nome acessível que o legado'
    ).toBeLessThanOrEqual(snapLegado.botoes_sem_nome_acessivel);
    // A montagem hub agrega o XmlValidationCard (no legado é rota separada) —
    // a área de upload XML acessível deve existir no hub.
    expect(snapHub.upload_xml_area).toBeGreaterThanOrEqual(1);
  });
});
