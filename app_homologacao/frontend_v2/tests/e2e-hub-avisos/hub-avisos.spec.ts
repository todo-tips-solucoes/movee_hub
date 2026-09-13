// hub-avisos (push-motorista) — tasks.md FASE 9.4.1: E2E real de
// /hub/dashboard/avisos + /hub/dashboard/avisos/[id] contra o stack efêmero
// hub-test-<runid> + frontend (infra/hub/testes/hub-avisos-e2e-browser.sh).
//
// Cobre (tasks.md): 7.2.4 (cobertura por número), 7.3.5 (3 modos, alcance
// atualizando, 0 inscrições bloqueia disparo, duplo-clique = 1 requisição),
// 7.4.2 (polling para exatamente ao atingir concluido), 8.2.3 (teclado),
// 8.2.4 (axe — 0 violações críticas/graves).
//
// Fixtures seedadas pelo driver via psql (nunca aqui — specs não têm acesso
// a docker/psql), passadas por env var:
//   HUB_E2E_ADMIN_EMAIL/SENHA        — admin_entidade, único vínculo empresa 6
//   HUB_E2E_COBERTURA_*              — 7 números esperados de PushEstadoAtivacao
//   HUB_E2E_ENTREGADOR_COM_INSCRICAO_NOME — Entregador com PushInscricao ativa
//   HUB_E2E_ENTREGADOR_SEM_INSCRICAO_NOME — Entregador SEM PushInscricao (0 alcance)
//   HUB_E2E_EMPRESA_NOME             — nome exibido p/ empresa 6 no modo "Empresa / filial"
// Nomes dos 2 Entregador começam com prefixos DISTINTOS nos 8 primeiros
// caracteres (BUSCA_MOTORISTA_MIN=3, o driver busca por `slice(0,8)`) — sem
// isso a busca por um casaria com os dois.
import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';
import { MODO_DESTINATARIOS_LABELS } from '../../lib/hub/avisos-dto';

const ADMIN_EMAIL = process.env.HUB_E2E_ADMIN_EMAIL || '';
const ADMIN_SENHA = process.env.HUB_E2E_ADMIN_SENHA || '';
const COB_ANDROID = process.env.HUB_E2E_COBERTURA_ANDROID || '';
const COB_IOS = process.env.HUB_E2E_COBERTURA_IOS || '';
const COB_DESKTOP = process.env.HUB_E2E_COBERTURA_DESKTOP || '';
const COB_IOS_SEM_INST = process.env.HUB_E2E_COBERTURA_IOS_SEM_INSTALACAO || '';
const COB_BLOQUEADAS = process.env.HUB_E2E_COBERTURA_BLOQUEADAS || '';
const COB_SEM_SUPORTE = process.env.HUB_E2E_COBERTURA_SEM_SUPORTE || '';
const COB_NAO_ATIVADAS = process.env.HUB_E2E_COBERTURA_NAO_ATIVADAS || '';
const ENTREGADOR_COM_INSCRICAO = process.env.HUB_E2E_ENTREGADOR_COM_INSCRICAO_NOME || '';
const ENTREGADOR_SEM_INSCRICAO = process.env.HUB_E2E_ENTREGADOR_SEM_INSCRICAO_NOME || '';
const EMPRESA_NOME = process.env.HUB_E2E_EMPRESA_NOME || '';

const LABEL_TODA_BASE = MODO_DESTINATARIOS_LABELS.toda_base; // "Toda a base"
const LABEL_INDIVIDUAL = MODO_DESTINATARIOS_LABELS.individual; // "Motoristas específicos"
const LABEL_EMPRESA = MODO_DESTINATARIOS_LABELS.empresa; // "Empresa / filial"

test.beforeAll(() => {
  for (const [nome, valor] of Object.entries({
    HUB_E2E_ADMIN_EMAIL: ADMIN_EMAIL,
    HUB_E2E_ADMIN_SENHA: ADMIN_SENHA,
    HUB_E2E_COBERTURA_ANDROID: COB_ANDROID,
    HUB_E2E_COBERTURA_IOS: COB_IOS,
    HUB_E2E_COBERTURA_DESKTOP: COB_DESKTOP,
    HUB_E2E_COBERTURA_IOS_SEM_INSTALACAO: COB_IOS_SEM_INST,
    HUB_E2E_COBERTURA_BLOQUEADAS: COB_BLOQUEADAS,
    HUB_E2E_COBERTURA_SEM_SUPORTE: COB_SEM_SUPORTE,
    HUB_E2E_COBERTURA_NAO_ATIVADAS: COB_NAO_ATIVADAS,
    HUB_E2E_ENTREGADOR_COM_INSCRICAO_NOME: ENTREGADOR_COM_INSCRICAO,
    HUB_E2E_ENTREGADOR_SEM_INSCRICAO_NOME: ENTREGADOR_SEM_INSCRICAO,
    HUB_E2E_EMPRESA_NOME: EMPRESA_NOME,
  })) {
    if (!valor) throw new Error(`env var ${nome} ausente — driver não seedou corretamente`);
  }
});

async function loginHubViaUI(page: Page) {
  await page.goto('/hub/login');
  await page.getByLabel('Email', { exact: true }).fill(ADMIN_EMAIL);
  await page.getByLabel('Senha', { exact: true }).fill(ADMIN_SENHA);
  await page.getByRole('button', { name: 'Entrar' }).click();
  // admin tem 1 único vínculo (empresa 6) -> auto-seleção, cai direto no dashboard.
  await page.waitForURL('**/hub/dashboard', { timeout: 20_000 });
}

/** Botão "Novo aviso" que ABRE o diálogo (DialogTrigger) — distinto do botão
 * de mesmo texto no EmptyState (visível só quando a lista está vazia), que
 * torna `getByRole('button', {name: 'Novo aviso'})` ambíguo (achado desta
 * suíte: strict mode violation com 2 elementos). `data-slot="dialog-trigger"`
 * é o atributo do Base UI que distingue o trigger real. */
function botaoNovoAviso(page: Page) {
  return page.locator('[data-slot="dialog-trigger"]', { hasText: 'Novo aviso' });
}

/** Abre o popover de busca de motorista, digita e seleciona pelo nome exato. */
async function selecionarMotoristaIndividual(page: Page, nomeCompleto: string) {
  await page.getByRole('button', { name: /Buscar motorista/ }).click();
  await page.getByPlaceholder('Digite ao menos 3 letras do nome...').fill(nomeCompleto.slice(0, 8));
  await page.getByRole('option', { name: nomeCompleto }).click();
}

test.describe.configure({ mode: 'serial' });

// Compartilhado entre os testes 2 e 3 (disparo -> id do aviso criado).
let avisoIdCriado: string | null = null;

test.describe('FASE 7.2 — cobertura por plataforma (FR-023/SC-011)', () => {
  test('7.2.4 — cobertura mostra os números do fixture (3 categorias ativos + 3 impedidos)', async ({ page }) => {
    await loginHubViaUI(page);
    await page.goto('/hub/dashboard/avisos');
    await expect(page.getByRole('heading', { name: 'Cobertura de notificações' })).toBeVisible();

    await expect(page.getByText('Android', { exact: true }).locator('..').getByText(COB_ANDROID, { exact: true })).toBeVisible();
    await expect(page.getByText('iOS', { exact: true }).first().locator('..').getByText(COB_IOS, { exact: true })).toBeVisible();
    await expect(page.getByText('Desktop/outros').locator('..').getByText(COB_DESKTOP, { exact: true })).toBeVisible();
    await expect(page.getByText('iOS sem instalação').locator('..').getByText(COB_IOS_SEM_INST, { exact: true })).toBeVisible();
    await expect(page.getByText('Bloqueadas').locator('..').getByText(COB_BLOQUEADAS, { exact: true })).toBeVisible();
    await expect(page.getByText('Sem suporte').locator('..').getByText(COB_SEM_SUPORTE, { exact: true })).toBeVisible();
    await expect(page.getByText('Não ativadas').locator('..').getByText(COB_NAO_ATIVADAS, { exact: true })).toBeVisible();
  });
});

test.describe('FASE 7.3 — diálogo "Novo aviso"', () => {
  test('7.3.5 — 3 modos, alcance atualiza, 0 inscrições bloqueia disparo, duplo-clique = 1 requisição', async ({ page }) => {
    test.setTimeout(120_000); // vários debounces (alcance 300ms) + navegação encadeada
    await loginHubViaUI(page);
    await page.goto('/hub/dashboard/avisos');

    await botaoNovoAviso(page).click();
    await expect(page.getByRole('dialog').getByText('Novo aviso')).toBeVisible();

    // ── 3 modos renderizados ──────────────────────────────────────────────
    await expect(page.getByText(LABEL_TODA_BASE, { exact: true })).toBeVisible();
    await expect(page.getByText(LABEL_INDIVIDUAL, { exact: true })).toBeVisible();
    await expect(page.getByText(LABEL_EMPRESA, { exact: true })).toBeVisible();

    await page.getByLabel('Título', { exact: true }).fill('E2E Aviso Toda Base');
    await page.getByLabel('Mensagem', { exact: true }).fill('Corpo do aviso de teste E2E (toda a base).');

    // modo padrão = toda_base -> alcance calcula (>=1 motorista, debounce 300ms)
    const previa = page.locator('[role="status"]').filter({ hasText: /inscri|Selecione|alcance/ });
    await expect(previa).toContainText('inscrição', { timeout: 10_000 });
    await expect(previa).not.toContainText('nenhuma notificação seria enviada');

    // ── modo individual: motorista SEM inscrição -> alcance 0, disparo bloqueado ──
    await page.getByText(LABEL_INDIVIDUAL, { exact: true }).click();
    await selecionarMotoristaIndividual(page, ENTREGADOR_SEM_INSCRICAO);
    await expect(previa).toContainText('nenhuma notificação seria enviada', { timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Disparar' })).toBeDisabled();

    // ── troca para motorista COM inscrição -> alcance sobe, disparo habilita ──
    await page.getByRole('button', { name: `Remover ${ENTREGADOR_SEM_INSCRICAO} dos destinatários` }).click();
    await selecionarMotoristaIndividual(page, ENTREGADOR_COM_INSCRICAO);
    await expect(previa).not.toContainText('nenhuma notificação seria enviada', { timeout: 10_000 });
    await expect(previa).toContainText('inscrição', { timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Disparar' })).toBeEnabled();

    // ── modo empresa: seleciona a única empresa do escopo (Movee) ──────────
    await page.getByText(LABEL_EMPRESA, { exact: true }).click();
    await expect(page.getByText(EMPRESA_NOME)).toBeVisible({ timeout: 10_000 });
    await page.getByText(EMPRESA_NOME).click();
    await expect(previa).toContainText('inscrição', { timeout: 10_000 });

    // ── volta para toda_base (fixture com PushInscricao 201 garantida) e dispara ──
    await page.getByText(LABEL_TODA_BASE, { exact: true }).click();
    await expect(previa).toContainText('inscrição', { timeout: 10_000 });

    let requisicoesPost = 0;
    page.on('request', (req) => {
      const url = req.url();
      if (req.method() === 'POST' && /\/api\/v1\/avisos$/.test(new URL(url).pathname)) {
        requisicoesPost += 1;
      }
    });

    const respostaPromise = page.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/api\/v1\/avisos$/.test(new URL(r.url()).pathname)
    );
    const botaoDisparar = page.getByRole('button', { name: 'Disparar' });
    // CHK011 — 2 cliques síncronos no MESMO node de DOM (via evaluate, não 2
    // locator.click() encadeados): a guarda `enviandoRef` é checada ANTES do
    // 1º `await` do handler, então só um dispatch síncrono duplo (mesmo
    // "tick") exercita a corrida de verdade. 2 `locator.click()` em paralelo
    // reconsultam o DOM a cada retry e travam quando o botão some (dialog
    // fecha no sucesso) — achado desta suíte (timeout de 60s no run anterior).
    const handle = await botaoDisparar.elementHandle();
    await page.evaluate((el) => {
      (el as HTMLButtonElement).click();
      (el as HTMLButtonElement).click();
    }, handle);
    const resposta = await respostaPromise;
    expect(resposta.status()).toBe(201);
    const body = await resposta.json();
    avisoIdCriado = String(body.id ?? body.avisoId ?? '');
    expect(avisoIdCriado).toBeTruthy();

    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 10_000 });
    expect(requisicoesPost).toBe(1);
  });
});

test.describe('FASE 7.4 — detalhe do aviso (polling)', () => {
  test('7.4.2 — polling para exatamente ao atingir concluido', async ({ page }) => {
    test.skip(!avisoIdCriado, 'depende do aviso criado em 7.3.5 (rodar a suíte inteira, não isolado)');
    let requisicoesGet = 0;
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (req.method() === 'GET' && url.pathname === `/api/v1/avisos/${avisoIdCriado}`) requisicoesGet += 1;
    });

    await loginHubViaUI(page);
    await page.goto(`/hub/dashboard/avisos/${avisoIdCriado}`);
    // `exact: true` é OBRIGATÓRIO aqui — achado desta suíte: a página SEMPRE
    // renderiza o rótulo estático "Concluído em" (grid de datas), que
    // `getByText('Concluído')` sem `exact` já casa por substring desde o
    // primeiro render, MUITO antes do status real virar 'concluido'. Isso
    // fazia `contagemAoConcluir` ser capturado cedo demais e o teste
    // confundir polling normal (ainda rodando) com "não parou".
    await expect(page.getByText('Concluído', { exact: true })).toBeVisible({ timeout: 30_000 });

    const contagemAoConcluir = requisicoesGet;
    // Espera 2 intervalos de poll (4s cada) a mais — se o polling não tivesse
    // parado, a contagem teria subido; ela deve permanecer EXATAMENTE igual.
    await page.waitForTimeout(9_000);
    expect(requisicoesGet).toBe(contagemAoConcluir);
  });
});

test.describe('FASE 8.2 — acessibilidade (teclado + axe)', () => {
  test('8.2.3 — teclado apenas: título, mensagem, 3 radio-cards e Disparar/Cancelar alcançáveis por Tab', async ({ page }) => {
    await loginHubViaUI(page);
    await page.goto('/hub/dashboard/avisos');
    await botaoNovoAviso(page).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    const alvos = [LABEL_TODA_BASE, LABEL_INDIVIDUAL, LABEL_EMPRESA, 'Cancelar', 'Disparar'];
    const encontrados = new Set<string>();
    // Tab através do dialog inteiro (teto generoso — título/mensagem também
    // contam via label associado); registra cada alvo visto em foco.
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press('Tab');
      // eslint-disable-next-line no-await-in-loop
      const focado = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return '';
        const label = el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : '';
        return [el.textContent, el.getAttribute('aria-label'), label].filter(Boolean).join(' | ');
      });
      for (const alvo of alvos) {
        if (focado.includes(alvo)) encontrados.add(alvo);
      }
    }
    // eslint-disable-next-line no-console -- evidência consumida pelo driver
    console.log(`TECLADO_RESULT alcancados=${[...encontrados].join(',')} total=${encontrados.size}/${alvos.length}`);
    expect([...encontrados].sort()).toEqual([...alvos].sort());
  });

  test('8.2.4 — axe: lista de avisos e diálogo "Novo aviso" sem violação crítica/grave', async ({ page }) => {
    await loginHubViaUI(page);
    await page.goto('/hub/dashboard/avisos');
    const resultadoLista = await new AxeBuilder({ page }).analyze();
    const criticasLista = resultadoLista.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    console.log(`AXE_RESULT tela="avisos-lista" violacoes=${resultadoLista.violations.length} criticas_graves=${criticasLista.length}`);
    expect(criticasLista, JSON.stringify(criticasLista.map((v) => v.id))).toHaveLength(0);

    await botaoNovoAviso(page).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const resultadoDialog = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    const criticasDialog = resultadoDialog.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    console.log(`AXE_RESULT tela="avisos-dialog" violacoes=${resultadoDialog.violations.length} criticas_graves=${criticasDialog.length}`);
    expect(criticasDialog, JSON.stringify(criticasDialog.map((v) => v.id))).toHaveLength(0);
  });
});
