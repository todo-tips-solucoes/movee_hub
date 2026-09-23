// adiantamento-motorista — tasks.md 6.2.3/6.3.6/6.3.7/6.5.2/6.8.2/6.8.3/6.9.1
// (feature "Adiantamento pelo App, Dados Bancários e Exportação
// Transfeera"): E2E de BROWSER do app_homologacao/frontend_motorista
// cobrindo US1 (solicitar/acompanhar, inclusive edge #27/10.5.27 — relógio
// do aparelho não decide o horário — e SC-001), US2 (dados bancários) e US7
// (central de notificações, inclusive badge de não lidas e decoupling do
// estado de push), acessibilidade (axe-core, escore >= 95 + color-contrast
// 0 violações nos 2 temas) e medição real de alvo de toque (>= 44x44 px,
// getBoundingClientRect — nunca por inspeção visual/classe Tailwind).
//
// Mesmo padrão de `../e2e-motorista-push/motorista-push.spec.ts` (dec-107,
// tasks.md 9.4 da feature "Notificações push"): frontend_motorista NÃO tem
// @playwright/test nem @axe-core/playwright — este spec vive em
// frontend_v2 (que já tem os dois) só para reusar esses devDependencies já
// aprovados; o app testado (frontend_motorista, next start -p 3006) roda
// como outro processo no MESMO container oficial do Playwright. Nenhum
// node_modules/package.json de nenhum dos dois projetos é alterado por
// este spec.
//
// SEM backend nem stack docker-compose: todo /api/* do browser é stubado
// via page.route (installApiStubs abaixo) — o proxy server-side do app
// motorista (app/api/[...path]/route.ts) nunca é exercitado de verdade.
// A rede push (Notification/PushManager/serviceWorker) é neutralizada do
// mesmo jeito que motorista-push.spec.ts faz (auth-context chama
// sincronizarPush()/revogarPush() automaticamente em toda sessão
// autenticada — sem o stub, isso bateria no Notification/SW reais do
// Chromium do container e poderia pendurar o teste).
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { computeAxeScore, AXE_SCORE_GATE } from '../e2e-hub-browser/axe-score';

const BASE = process.env.MOTORISTA_E2E_BASE_URL || 'http://127.0.0.1:3006';

// ── Fixtures — shapes sourced de lib/adiantamento-api.ts (tasks.md 6.1.1) ──

interface Disponibilidade {
  canRequest: boolean;
  reason: string | null;
  requestDate: string;
  productionDate: string;
  timezone: string;
  openingTime: string;
  cutoffTime: string;
  enabledDays: number[];
  percentage: number | null;
  fee: string;
  paymentForecast: string;
  nextAvailableAt: string | null;
  estimate: { available: boolean; production: string; gross: string; fee: string; net: string | null; eligible: boolean | null; final: false } | null;
  bankAccount: { status: string; bank: string; masked: string } | null;
  todayRequest: { id: number; status: string; integrationId: string } | null;
  configVersion: number;
  configuracaoId: number;
}

interface SolicitacaoDetalhe {
  id: number;
  integrationId: string;
  status: string;
  motivoStatus: string | null;
  dataSolicitacao: string;
  dataProducao: string;
  solicitadaEm: string;
  configVersion: number;
  calculo: { producao: string; percentual: number | null; bruto: string; taxa: string; liquido: string; fonte: string; calculadoEm: string } | null;
  contaMascarada: { status: string; bank: string; masked: string } | null;
  previsaoPagamento: string | null;
  timeline: { etapa: string; status: string; ocorridoEm: string; motivo: string | null }[];
}

interface ContaBancariaItem {
  id: number;
  status: string;
  banco: string;
  agencia: string;
  contaMascarada: string;
  tipoConta: 'CORRENTE' | 'POUPANCA';
  titularNome: string;
  documentoMascarado: string;
  chavePixTipo: string | null;
  emailComprovante: string | null;
  solicitadaEm: string;
  motivoRejeicao: string | null;
}

interface Notificacao {
  id: number;
  categoria: string;
  titulo: string;
  corpo: string;
  link: string | null;
  criadaEm: string;
  lida: boolean;
}

interface StubState {
  authenticated: boolean;
  disponibilidade: Disponibilidade;
  regras: { configVersion: number; configuracaoId: number; texto: string; itens: { titulo: string; descricao: string }[]; aceiteSha256: string };
  solicitacoes: Record<number, SolicitacaoDetalhe>;
  proximoIdSolicitacao: number;
  contaBancaria: { aprovada: ContaBancariaItem | null; pendente: ContaBancariaItem | null; ultimaRejeicao: ContaBancariaItem | null };
  bancos: { codigo: string; nome: string }[];
  notificacoes: Notificacao[];
  repasse: unknown | null;
  /** F2 (briefing repasse-nota-producao): abertura do crédito da semana. */
  extrato: unknown | null;
}

function disponibilidadeBase(overrides: Partial<Disponibilidade> = {}): Disponibilidade {
  return {
    canRequest: true,
    reason: null,
    requestDate: '2026-09-17',
    productionDate: '2026-09-16',
    timezone: 'America/Sao_Paulo',
    openingTime: '06:00',
    cutoffTime: '11:00',
    enabledDays: [1, 2, 3, 4, 5],
    percentage: 80,
    fee: '5.00',
    paymentForecast: '2026-09-18',
    nextAvailableAt: null,
    estimate: { available: true, production: '320.00', gross: '256.00', fee: '5.00', net: '251.00', eligible: true, final: false },
    bankAccount: { status: 'APROVADA', bank: '341 · Itaú', masked: 'Ag. 1234 · CC ****5-6' },
    todayRequest: null,
    configVersion: 3,
    configuracaoId: 3,
    ...overrides,
  };
}

function defaultState(): StubState {
  return {
    authenticated: true,
    disponibilidade: disponibilidadeBase(),
    regras: {
      configVersion: 3,
      configuracaoId: 3,
      texto: 'Regras vigentes do adiantamento.',
      itens: [
        { titulo: 'Percentual', descricao: 'Até 80% da produção do dia anterior.' },
        { titulo: 'Taxa', descricao: 'Taxa fixa de R$ 5,00 por adiantamento.' },
      ],
      aceiteSha256: 'a'.repeat(64),
    },
    solicitacoes: {},
    proximoIdSolicitacao: 501,
    contaBancaria: {
      aprovada: {
        id: 1, status: 'APROVADA', banco: '341 · Itaú', agencia: '1234', contaMascarada: '****5-6',
        tipoConta: 'CORRENTE', titularNome: 'Motorista E2E', documentoMascarado: '***.456.789-**',
        chavePixTipo: null, emailComprovante: null, solicitadaEm: '2026-08-01T10:00:00Z', motivoRejeicao: null,
      },
      pendente: null,
      ultimaRejeicao: null,
    },
    bancos: [
      { codigo: '341', nome: 'Itaú Unibanco' },
      { codigo: '001', nome: 'Banco do Brasil' },
      { codigo: '260', nome: 'Nu Pagamentos' },
    ],
    notificacoes: [
      { id: 1, categoria: 'adiantamento', titulo: 'Adiantamento liberado', corpo: 'Seu adiantamento de hoje foi liberado.', link: '/adiantamento/501', criadaEm: '2026-09-16T12:00:00Z', lida: false },
      { id: 2, categoria: 'conta_bancaria', titulo: 'Conta em análise', corpo: 'Seus dados bancários estão em análise.', link: '/conta-bancaria', criadaEm: '2026-09-15T09:00:00Z', lida: false },
      { id: 3, categoria: 'sistema', titulo: 'Manutenção programada', corpo: 'Sistema indisponível às 22h.', link: null, criadaEm: '2026-09-14T08:00:00Z', lida: true },
    ],
    repasse: null,
    extrato: null,
  };
}

/** Bloqueia QUALQUER request fora do próprio BASE (defesa contra produção). */
async function installNetworkGuard(page: Page, external: string[]): Promise<void> {
  const EXTERNAL_BENIGNO_CONHECIDO = [/^https:\/\/fonts\.googleapis\.com\//, /^https:\/\/fonts\.gstatic\.com\//];
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(BASE)) {
      await route.continue();
      return;
    }
    if (!EXTERNAL_BENIGNO_CONHECIDO.some((re) => re.test(url))) external.push(url);
    await route.abort();
  });
}

/** Neutraliza Notification/PushManager/serviceWorker ANTES de qualquer
 * script da página — mesma técnica de motorista-push.spec.ts
 * (installPushStubsInit): sem isso, sincronizarPush()/revogarPush()
 * (chamados automaticamente por contexts/auth-context.tsx em toda sessão
 * autenticada) bateriam no Notification/SW reais do Chromium do container. */
function installPushStubsInit(): void {
  class FakeNotification {
    static permission: 'default' | 'denied' | 'granted' = 'default';
    static requestPermission(): Promise<'default' | 'denied' | 'granted'> {
      return Promise.resolve('default');
    }
  }
  Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true, writable: true });
  if (!('PushManager' in window)) {
    Object.defineProperty(window, 'PushManager', { value: function PushManagerStub() {}, configurable: true });
  }
  const fakeSubscription = {
    endpoint: 'https://fake-push.example.test/e/stub',
    toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'stub-p256dh', auth: 'stub-auth' } }; },
    unsubscribe: async () => true,
  };
  const fakeRegistration = Object.assign(new EventTarget(), {
    pushManager: { getSubscription: async () => null, subscribe: async () => fakeSubscription },
    update: async () => undefined,
  });
  const fakeServiceWorkerContainer = Object.assign(new EventTarget(), {
    ready: Promise.resolve(fakeRegistration),
    getRegistration: async () => fakeRegistration,
    register: async () => fakeRegistration,
    controller: null,
  });
  Object.defineProperty(window.navigator, 'serviceWorker', { value: fakeServiceWorkerContainer, configurable: true });
}

/** Stub de TODOS os endpoints /api/motorista/* usados pelas telas cobertas
 * (contracts/motorista-api.md §Parte 2; lib/adiantamento-api.ts é a fonte
 * dos shapes de resposta, tasks.md 6.1.1). */
async function installApiStubs(page: Page, state: StubState): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, '');
    const method = req.method();
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const noContent = () => route.fulfill({ status: 204, body: '' });

    if (path === '/motorista/verify-auth' && method === 'GET') {
      return state.authenticated
        ? json(200, { authenticated: true, cnpjPrestador: '90000000000401', nome: 'Motorista E2E' })
        : json(200, { authenticated: false });
    }
    if (path === '/motorista/login' && method === 'POST') {
      state.authenticated = true;
      return json(200, { cnpjPrestador: '90000000000401', nome: 'Motorista E2E' });
    }
    if (path === '/motorista/logout' && method === 'POST') {
      state.authenticated = false;
      return noContent();
    }
    if (path === '/motorista/token/refresh' && method === 'POST') return json(200, {});
    if (path === '/motorista/empresas-proprietarias' && method === 'GET') return json(200, { empresas: ['Empresa E2E'] });
    if (path === '/motorista/movimento-aberto' && method === 'GET') return json(200, { movimento: null });

    if (path === '/motorista/adiantamento/disponibilidade' && method === 'GET') return json(200, state.disponibilidade);
    if (path === '/motorista/adiantamento/regras' && method === 'GET') return json(200, state.regras);

    if (path === '/motorista/adiantamentos' && method === 'POST') {
      const corpo = req.postDataJSON() as { configuracaoId: number };
      const id = state.proximoIdSolicitacao;
      state.proximoIdSolicitacao += 1;
      const detalhe: SolicitacaoDetalhe = {
        id,
        integrationId: `ADT-${id}`,
        status: 'AGUARDANDO_CORTE',
        motivoStatus: null,
        dataSolicitacao: state.disponibilidade.requestDate,
        dataProducao: state.disponibilidade.productionDate,
        solicitadaEm: new Date().toISOString(),
        configVersion: corpo.configuracaoId,
        calculo: null,
        contaMascarada: state.disponibilidade.bankAccount,
        previsaoPagamento: state.disponibilidade.paymentForecast,
        timeline: [{ etapa: 'Solicitado', status: 'AGUARDANDO_CORTE', ocorridoEm: new Date().toISOString(), motivo: null }],
      };
      state.solicitacoes[id] = detalhe;
      state.disponibilidade = disponibilidadeBase({
        canRequest: false,
        reason: 'ALREADY_REQUESTED',
        todayRequest: { id, status: detalhe.status, integrationId: detalhe.integrationId },
      });
      return json(200, detalhe);
    }
    if (path === '/motorista/adiantamentos' && method === 'GET') {
      const itens = Object.values(state.solicitacoes).map((s) => ({
        id: s.id, integrationId: s.integrationId, dataSolicitacao: s.dataSolicitacao, dataProducao: s.dataProducao,
        status: s.status, statusRotulo: s.status, valorLiquido: s.calculo?.liquido ?? '0.00',
      }));
      return json(200, { itens, total: itens.length, pagina: 1, porPagina: 20 });
    }
    const detalheMatch = path.match(/^\/motorista\/adiantamentos\/(\d+)$/);
    if (detalheMatch && method === 'GET') {
      const s = state.solicitacoes[Number(detalheMatch[1])];
      return s ? json(200, s) : json(404, { erro: 'NAO_ENCONTRADA' });
    }
    const cancelarMatch = path.match(/^\/motorista\/adiantamentos\/(\d+)\/cancelar$/);
    if (cancelarMatch && method === 'POST') {
      const s = state.solicitacoes[Number(cancelarMatch[1])];
      if (!s) return json(404, { erro: 'NAO_ENCONTRADA' });
      if (s.status !== 'AGUARDANDO_CORTE') return json(409, { erro: 'TRANSICAO_INVALIDA' });
      s.status = 'CANCELADA';
      s.timeline = [...s.timeline, { etapa: 'Cancelado', status: 'CANCELADA', ocorridoEm: new Date().toISOString(), motivo: null }];
      state.disponibilidade = disponibilidadeBase();
      return json(200, s);
    }

    if (path === '/motorista/conta-bancaria' && method === 'GET') return json(200, state.contaBancaria);
    if (path === '/motorista/conta-bancaria/solicitacoes' && method === 'POST') {
      const corpo = req.postDataJSON() as Record<string, string>;
      const item: ContaBancariaItem = {
        id: 99, status: 'PENDENTE', banco: state.bancos.find((b) => b.codigo === corpo.bancoCodigo)?.nome ?? corpo.bancoCodigo,
        agencia: corpo.agencia, contaMascarada: `****${corpo.contaDigito}`, tipoConta: corpo.tipoConta as 'CORRENTE' | 'POUPANCA',
        titularNome: corpo.titularNome, documentoMascarado: '***.***.***-**', chavePixTipo: corpo.chavePixTipo || null,
        emailComprovante: corpo.emailComprovante || null, solicitadaEm: new Date().toISOString(), motivoRejeicao: null,
      };
      state.contaBancaria = { ...state.contaBancaria, pendente: item };
      return json(200, item);
    }
    if (path === '/motorista/bancos' && method === 'GET') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const itens = q ? state.bancos.filter((b) => b.codigo.includes(q) || b.nome.toLowerCase().includes(q)) : state.bancos;
      return json(200, { itens });
    }

    if (path === '/motorista/notificacoes' && method === 'GET') {
      const categoria = url.searchParams.get('categoria');
      const naoLidas = url.searchParams.get('naoLidas') === 'true';
      let itens = state.notificacoes;
      if (categoria) itens = itens.filter((n) => n.categoria === categoria);
      if (naoLidas) itens = itens.filter((n) => !n.lida);
      return json(200, { itens, total: itens.length, pagina: 1, porPagina: 20 });
    }
    if (path === '/motorista/notificacoes/nao-lidas' && method === 'GET') {
      return json(200, { total: state.notificacoes.filter((n) => !n.lida).length });
    }
    const lidaMatch = path.match(/^\/motorista\/notificacoes\/(\d+)\/lida$/);
    if (lidaMatch && method === 'POST') {
      const n = state.notificacoes.find((x) => x.id === Number(lidaMatch[1]));
      if (n) n.lida = true;
      return noContent();
    }
    if (path === '/motorista/notificacoes/lidas' && method === 'POST') {
      state.notificacoes.forEach((n) => { n.lida = true; });
      return noContent();
    }

    if (path === '/motorista/repasse/extrato' && method === 'GET') {
      return state.extrato ? json(200, state.extrato) : json(404, { erro: 'NAO_DISPONIVEL' });
    }
    if (path === '/motorista/repasse' && method === 'GET') {
      return state.repasse ? json(200, state.repasse) : json(404, { erro: 'NAO_DISPONIVEL' });
    }

    if (path === '/motorista/push/chave-publica' && method === 'GET') {
      return json(200, { chavePublica: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', keyId: 'stub-key-1' });
    }
    if (path === '/motorista/push/inscricao' && method === 'PUT') return noContent();
    if (path === '/motorista/push/estado' && method === 'PUT') return noContent();
    if (path === '/motorista/push/inscricao/revogar' && method === 'POST') return noContent();

    return json(404, { erro: 'NAO_ENCONTRADO', path, method });
  });
}

async function setup(page: Page, state: StubState): Promise<string[]> {
  const external: string[] = [];
  await installNetworkGuard(page, external);
  await installApiStubs(page, state);
  await page.addInitScript(installPushStubsInit);
  return external;
}

// ───────────────────────────────────────────────────────────────────────────
// US1 — solicitar adiantamento e acompanhar o status
// ───────────────────────────────────────────────────────────────────────────
test.describe('US1 — solicitar e acompanhar adiantamento', () => {
  test('Scenario 1: disponível hoje — solicita com aceite e vê a confirmação/timeline', async ({ page }) => {
    const state = defaultState();
    const external = await setup(page, state);
    await page.goto(`${BASE}/adiantamento`);
    await expect(page.getByText('Disponível hoje')).toBeVisible();
    await page.getByRole('button', { name: 'Solicitar adiantamento' }).click();
    await expect(page.getByRole('dialog', { name: 'Confirmar solicitação' })).toBeVisible();
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Confirmar solicitação' }).click();
    await page.waitForURL((u) => /\/adiantamento\/\d+$/.test(u.pathname), { timeout: 15_000 });
    await expect(page.getByText('Aguardando fechamento')).toBeVisible();
    await expect(page.getByText('Andamento')).toBeVisible();
    expect(external, `requests externos inesperados: ${external.join(', ')}`).toEqual([]);
  });

  test('Scenario 2: já solicitado hoje — mostra o motivo e a solicitação existente', async ({ page }) => {
    const state = defaultState();
    state.disponibilidade = disponibilidadeBase({
      canRequest: false,
      reason: 'ALREADY_REQUESTED',
      todayRequest: { id: 777, status: 'AGUARDANDO_CORTE', integrationId: 'ADT-777' },
    });
    const external = await setup(page, state);
    await page.goto(`${BASE}/adiantamento`);
    await expect(page.getByText('Você já tem uma solicitação de adiantamento hoje.')).toBeVisible();
    await expect(page.getByText('Sua solicitação de hoje (ADT-777)')).toBeVisible();
    expect(external).toEqual([]);
  });

  test('Scenario 4: cancela antes do corte', async ({ page }) => {
    const state = defaultState();
    state.solicitacoes[501] = {
      id: 501, integrationId: 'ADT-501', status: 'AGUARDANDO_CORTE', motivoStatus: null,
      dataSolicitacao: '2026-09-17', dataProducao: '2026-09-16', solicitadaEm: new Date().toISOString(),
      configVersion: 3, calculo: null, contaMascarada: state.disponibilidade.bankAccount,
      previsaoPagamento: '2026-09-18', timeline: [{ etapa: 'Solicitado', status: 'AGUARDANDO_CORTE', ocorridoEm: new Date().toISOString(), motivo: null }],
    };
    const external = await setup(page, state);
    await page.goto(`${BASE}/adiantamento/501`);
    await page.getByRole('button', { name: 'Cancelar solicitação' }).click();
    // exact:true — sem isso casa também com o badge de status anterior
    // ("closeCancelado", ícone+texto concatenados).
    await expect(page.getByText('Cancelado', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancelar solicitação' })).toHaveCount(0);
    expect(external).toEqual([]);
  });

  // tasks.md 6.3.6 (edge #27, 10.5.27): o relógio do APARELHO do motorista
  // está errado — a decisão de horário é sempre do servidor
  // (disponibilidade.canRequest via GET), nunca do cliente. `setFixedTime`
  // (não `install`) só congela Date.now()/new Date(); os timers reais de
  // animação/toast continuam correndo. Grep confirma que nenhuma tela de
  // adiantamento lê `new Date()`/`Date.now()` para decidir elegibilidade
  // (só formata datas que já vêm prontas do servidor) — com o relógio local
  // apontando madrugada de domingo (dia desabilitado, fora da janela), o
  // fluxo segue idêntico ao Scenario 1 porque a tela nunca consulta o
  // relógio local para essa decisão.
  test('6.3.6: fluxo completo solicitar → timeline → cancelar, com o relógio do aparelho errado', async ({ page }) => {
    const state = defaultState();
    const external = await setup(page, state);
    await page.clock.setFixedTime(new Date('2026-09-20T03:00:00-03:00')); // domingo 03h, dia desabilitado

    await page.goto(`${BASE}/adiantamento`);
    await expect(page.getByText('Disponível hoje')).toBeVisible();
    await page.getByRole('button', { name: 'Solicitar adiantamento' }).click();
    await expect(page.getByRole('dialog', { name: 'Confirmar solicitação' })).toBeVisible();
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Confirmar solicitação' }).click();
    await page.waitForURL((u) => /\/adiantamento\/\d+$/.test(u.pathname), { timeout: 15_000 });
    await expect(page.getByText('Aguardando fechamento')).toBeVisible();
    await expect(page.getByText('Andamento')).toBeVisible();

    await page.getByRole('button', { name: 'Cancelar solicitação' }).click();
    await expect(page.getByText('Cancelado', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancelar solicitação' })).toHaveCount(0);
    expect(external, `requests externos inesperados: ${external.join(', ')}`).toEqual([]);
  });

  // tasks.md 6.3.7 (SC-001): fim a fim em menos de 2 minutos, medido pelo
  // próprio processo de teste (Date.now() do Node, nunca afetado por
  // page.clock — este teste nem usa clock fake).
  test('6.3.7: SC-001 — solicitação concluída em menos de 2 minutos', async ({ page }) => {
    const state = defaultState();
    const external = await setup(page, state);
    const inicio = Date.now();

    await page.goto(`${BASE}/adiantamento`);
    await expect(page.getByText('Disponível hoje')).toBeVisible();
    await page.getByRole('button', { name: 'Solicitar adiantamento' }).click();
    await expect(page.getByRole('dialog', { name: 'Confirmar solicitação' })).toBeVisible();
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Confirmar solicitação' }).click();
    await page.waitForURL((u) => /\/adiantamento\/\d+$/.test(u.pathname), { timeout: 15_000 });
    await expect(page.getByText('Aguardando fechamento')).toBeVisible();

    const decorridoMs = Date.now() - inicio;
    console.log(`SC-001 duracao_ms=${decorridoMs}`);
    expect(decorridoMs, `SC-001 exige < 2min; medido ${decorridoMs}ms`).toBeLessThan(120_000);
    expect(external, `requests externos inesperados: ${external.join(', ')}`).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// US2 — cadastro de dados bancários
// ───────────────────────────────────────────────────────────────────────────
test.describe('US2 — dados bancários', () => {
  test('Scenario 1: sem conta cadastrada — envia dados válidos e vê "Em análise"', async ({ page }) => {
    const state = defaultState();
    state.contaBancaria = { aprovada: null, pendente: null, ultimaRejeicao: null };
    const external = await setup(page, state);
    await page.goto(`${BASE}/conta-bancaria`);
    await expect(page.getByText('Nenhuma conta cadastrada')).toBeVisible();
    await page.getByRole('link', { name: 'Cadastrar dados bancários' }).click();
    await page.waitForURL((u) => u.pathname === '/conta-bancaria/alterar');

    await page.getByLabel('Nome ou razão social do titular').fill('Motorista E2E');
    await page.getByLabel('CPF ou CNPJ do titular').fill('123.456.789-09');
    // duas labels casam "Banco" (Label do input de busca + aria-label do
    // <select>) — getByRole restringe ao <select> (role combobox nativo).
    await page.getByRole('combobox', { name: 'Banco' }).selectOption('341');
    await page.getByLabel('Agência').fill('1234');
    // exact:true — "Conta" (substring) também casaria com o radiogroup
    // "Tipo de conta".
    await page.getByLabel('Conta', { exact: true }).fill('56789');
    await page.getByLabel('Dígito').fill('0');
    await page.getByRole('button', { name: 'Enviar para análise' }).click();

    await page.waitForURL((u) => u.pathname === '/conta-bancaria', { timeout: 15_000 });
    await expect(page.getByText('Em análise')).toBeVisible();
    expect(external, `requests externos inesperados: ${external.join(', ')}`).toEqual([]);
  });

  test('Scenario 3: conta aprovada segue valendo enquanto a nova está pendente', async ({ page }) => {
    const state = defaultState();
    state.contaBancaria.pendente = {
      id: 2, status: 'PENDENTE', banco: 'Nu Pagamentos', agencia: '0001', contaMascarada: '****9-0',
      tipoConta: 'CORRENTE', titularNome: 'Motorista E2E', documentoMascarado: '***.456.789-**',
      chavePixTipo: null, emailComprovante: null, solicitadaEm: new Date().toISOString(), motivoRejeicao: null,
    };
    const external = await setup(page, state);
    await page.goto(`${BASE}/conta-bancaria`);
    await expect(page.getByText('Aprovada')).toBeVisible();
    await expect(page.getByText('Em análise')).toBeVisible();
    await expect(page.getByText('Enquanto a alteração é analisada, seus pagamentos continuam indo para esta conta.')).toBeVisible();
    expect(external).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// US7 — central de notificações
// ───────────────────────────────────────────────────────────────────────────
test.describe('US7 — central de notificações', () => {
  test('Scenario: lista, filtra por categoria, marca uma como lida ao abrir e marca todas', async ({ page }) => {
    const state = defaultState();
    const external = await setup(page, state);
    await page.goto(`${BASE}/notificacoes`);
    await expect(page.getByText('Adiantamento liberado')).toBeVisible();
    await expect(page.getByText('Conta em análise')).toBeVisible();

    // exact:true — sem isso também casa com a linha de notificação cujo
    // corpo contém a palavra "Sistema" ("Manutenção programada ... Sistema
    // indisponível...").
    await page.getByRole('button', { name: 'Sistema', exact: true }).click();
    await expect(page.getByText('Manutenção programada')).toBeVisible();
    await expect(page.getByText('Adiantamento liberado')).toHaveCount(0);

    // exact:true — "Todas" (substring) também casaria com "Marcar todas
    // como lidas".
    await page.getByRole('button', { name: 'Todas', exact: true }).click();
    await page.getByText('Conta em análise').click();
    await page.waitForURL((u) => u.pathname === '/conta-bancaria');
    await page.goto(`${BASE}/notificacoes`);

    await page.getByRole('button', { name: 'Marcar todas como lidas' }).click();
    await expect(page.getByRole('button', { name: 'Marcar todas como lidas' })).toHaveCount(0);
    expect(external, `requests externos inesperados: ${external.join(', ')}`).toEqual([]);
  });

  // tasks.md 6.2.3: badge de não lidas na nav inferior (components/
  // bottom-nav.tsx) vem de GET /notificacoes/nao-lidas e refaz a busca a
  // cada troca de rota (useEffect em [pathname]) — aparece com 2 não lidas
  // e some depois de "Marcar todas como lidas" + trocar de rota.
  test('6.2.3: badge de notificações não lidas aparece e some ao ler', async ({ page }) => {
    const state = defaultState(); // 2 não lidas (ids 1 e 2) por padrão
    const external = await setup(page, state);
    const nav = page.locator('nav[aria-label="Navegação do app"]');

    await page.goto(`${BASE}/movimento`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByLabel('2 notificações não lidas')).toBeVisible();

    await nav.locator('a[href="/notificacoes"]').click();
    await page.waitForURL((u) => u.pathname === '/notificacoes');
    await page.getByRole('button', { name: 'Marcar todas como lidas' }).click();
    await expect(page.getByRole('button', { name: 'Marcar todas como lidas' })).toHaveCount(0);

    await nav.locator('a[href="/movimento"]').click();
    await page.waitForURL((u) => u.pathname === '/movimento');
    await page.waitForLoadState('networkidle');
    await expect(page.getByLabel(/notificações não lidas/)).toHaveCount(0);
    expect(external, `requests externos inesperados: ${external.join(', ')}`).toEqual([]);
  });

  // tasks.md 6.5.2: a central de notificações lê GET /notificacoes de forma
  // independente do estado de push — um dispositivo com push bloqueado
  // continua vendo os eventos in-app. `Notification.permission='denied'`
  // faz lib/push.ts#sincronizar() (guarda na 1ª linha da função) retornar
  // cedo sem tocar rede — ainda assim a lista de notificações é populada
  // pelo próprio GET desta tela, nunca pelo canal de push.
  test('6.5.2: notificação de evento aparece mesmo com push desativado no dispositivo', async ({ page }) => {
    const state = defaultState();
    const external = await setup(page, state);
    await page.addInitScript(() => {
      // roda DEPOIS de installPushStubsInit (já registrado por setup());
      // window.Notification aqui já é a FakeNotification do stub.
      Object.defineProperty(window.Notification, 'permission', { value: 'denied', configurable: true });
    });

    await page.goto(`${BASE}/notificacoes`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('Adiantamento liberado')).toBeVisible();
    await expect(page.getByText('Conta em análise')).toBeVisible();
    expect(external, `requests externos inesperados: ${external.join(', ')}`).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 6.8.2 — alvo de toque >= 44x44 px nas telas novas (medido no DOM, nunca
// por inspeção visual/classe Tailwind — gotcha registrado no repo).
// ───────────────────────────────────────────────────────────────────────────
const TELAS_TOQUE: { nome: string; path: string; state?: (s: StubState) => void }[] = [
  { nome: 'movimento', path: '/movimento' },
  { nome: 'adiantamento (disponível)', path: '/adiantamento' },
  { nome: 'adiantamento (indisponível + solicitação hoje)', path: '/adiantamento', state: (s) => {
    s.disponibilidade = disponibilidadeBase({ canRequest: false, reason: 'ALREADY_REQUESTED', todayRequest: { id: 501, status: 'AGUARDANDO_CORTE', integrationId: 'ADT-501' } });
  } },
  { nome: 'adiantamento/regras', path: '/adiantamento/regras' },
  { nome: 'adiantamento/historico', path: '/adiantamento/historico' },
  { nome: 'adiantamento/[id]', path: '/adiantamento/501', state: (s) => {
    s.solicitacoes[501] = {
      id: 501, integrationId: 'ADT-501', status: 'AGUARDANDO_CORTE', motivoStatus: null,
      dataSolicitacao: '2026-09-17', dataProducao: '2026-09-16', solicitadaEm: new Date().toISOString(),
      configVersion: 3, calculo: null, contaMascarada: s.disponibilidade.bankAccount, previsaoPagamento: '2026-09-18',
      timeline: [{ etapa: 'Solicitado', status: 'AGUARDANDO_CORTE', ocorridoEm: new Date().toISOString(), motivo: null }],
    };
  } },
  { nome: 'adiantamento/[id] (paga, com desconto no repasse)', path: '/adiantamento/501', state: (s) => {
    s.solicitacoes[501] = {
      id: 501, integrationId: 'ADT-501', status: 'PAGA', motivoStatus: null,
      dataSolicitacao: '2026-09-17', dataProducao: '2026-09-16', solicitadaEm: new Date().toISOString(),
      configVersion: 3,
      calculo: { producao: '320.00', percentual: 80, bruto: '256.00', taxa: '5.00', liquido: '251.00', fonte: 'importacao', calculadoEm: '2026-09-17T11:00:00Z' },
      contaMascarada: s.disponibilidade.bankAccount, previsaoPagamento: '2026-09-18',
      timeline: [{ etapa: 'Pago', status: 'PAGA', ocorridoEm: new Date().toISOString(), motivo: null }],
    };
  } },
  { nome: 'adiantamento/[id] (rejeitada)', path: '/adiantamento/501', state: (s) => {
    s.solicitacoes[501] = {
      id: 501, integrationId: 'ADT-501', status: 'REJEITADA', motivoStatus: 'Vínculo com o motorista não confirmado.',
      dataSolicitacao: '2026-09-17', dataProducao: '2026-09-16', solicitadaEm: new Date().toISOString(),
      configVersion: 3, calculo: null, contaMascarada: s.disponibilidade.bankAccount, previsaoPagamento: null,
      timeline: [{ etapa: 'Rejeitado', status: 'REJEITADA', ocorridoEm: new Date().toISOString(), motivo: null }],
    };
  } },
  { nome: 'conta-bancaria', path: '/conta-bancaria' },
  { nome: 'conta-bancaria/alterar', path: '/conta-bancaria/alterar' },
  { nome: 'notificacoes', path: '/notificacoes' },
  { nome: 'repasse', path: '/repasse', state: (s) => {
    s.repasse = {
      periodoInicio: '2026-09-10', periodoFim: '2026-09-16', dataRepasse: '2026-09-18',
      situacao: 'EM_APURACAO', creditos: '1200.00',
      adiantamentos: [{ id: 501, integrationId: 'ADT-501', dataProducao: '2026-09-16', valorBruto: '256.00', emProcessamento: false }],
      debitos: '256.00', remanescente: '944.00', negativo: false,
    };
    s.extrato = {
      periodoInicio: '2026-09-10', periodoFim: '2026-09-16', total: '1200.00',
      dias: [
        { data: '2026-09-10', total: '700.00', itens: [{ descricao: 'Corridas concluidas', quantidade: 4, valor: '700.00' }] },
        { data: '2026-09-11', total: '500.00', itens: [{ descricao: 'Corridas concluidas', quantidade: 3, valor: '500.00' }] },
      ],
    };
  } },
];

// F2 (briefing repasse-nota-producao): o motorista passa a ver DE ONDE vem o
// crédito da semana. O total do extrato é o mesmo `creditos` do repasse — se
// divergir, ele vê dois números para a mesma semana e acredita no menor.
test.describe('F2 — extrato da semana', () => {
  test('a tela do repasse abre o extrato por dia, com a quantidade por categoria', async ({ page }) => {
    const state = defaultState();
    state.repasse = {
      periodoInicio: '2026-09-10', periodoFim: '2026-09-16', dataRepasse: '2026-09-18',
      situacao: 'EM_APURACAO', creditos: '1200.00', adiantamentos: [],
      debitos: '0.00', remanescente: '1200.00', negativo: false,
    };
    state.extrato = {
      periodoInicio: '2026-09-10', periodoFim: '2026-09-16', total: '1200.00',
      dias: [
        { data: '2026-09-10', total: '700.00', itens: [{ descricao: 'Corridas concluidas', quantidade: 4, valor: '700.00' }] },
        { data: '2026-09-11', total: '500.00', itens: [{ descricao: 'Promocao - Campanha w99', quantidade: 1, valor: '500.00' }] },
      ],
    };
    await setup(page, state);
    await page.goto(`${BASE}/repasse`);

    const extrato = page.locator('details', { hasText: 'Extrato da produção' });
    await expect(extrato).toBeVisible();
    await extrato.locator('summary').click();
    await expect(extrato.getByText('Corridas concluidas', { exact: false })).toBeVisible();
    await expect(extrato.getByText('×4')).toBeVisible();
    await expect(extrato.getByText('Promocao - Campanha w99')).toBeVisible();
  });

  test('sem extrato disponível (404), a tela do repasse continua inteira', async ({ page }) => {
    const state = defaultState();
    state.repasse = {
      periodoInicio: '2026-09-10', periodoFim: '2026-09-16', dataRepasse: '2026-09-18',
      situacao: 'EM_APURACAO', creditos: '1200.00', adiantamentos: [],
      debitos: '0.00', remanescente: '1200.00', negativo: false,
    };
    state.extrato = null;   // a rota devolve 404
    await setup(page, state);
    await page.goto(`${BASE}/repasse`);

    await expect(page.getByText('Previsão a receber')).toBeVisible();
    await expect(page.locator('details', { hasText: 'Extrato da produção' })).toHaveCount(0);
  });
});

test.describe('6.8.2 — alvos de toque >= 44x44 px (medido)', () => {
  for (const tela of TELAS_TOQUE) {
    test(`${tela.nome}`, async ({ page }) => {
      const state = defaultState();
      tela.state?.(state);
      await setup(page, state);
      await page.goto(`${BASE}${tela.path}`);
      await page.waitForLoadState('networkidle');

      const medidas = await page.evaluate(() => {
        const seletor = 'a[href], button, [role="button"]';
        const els = Array.from(document.querySelectorAll<HTMLElement>(seletor));
        return els
          .filter((el) => {
            const r = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          })
          .map((el) => {
            const r = el.getBoundingClientRect();
            return {
              rotulo: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 60),
              width: Math.round(r.width),
              height: Math.round(r.height),
            };
          });
      });

      // components/notificacoes.tsx (feature push-motorista, PR #178, FORA
      // do escopo de adiantamento-motorista) renderiza em /movimento com
      // dois alvos < 44px ("Ativar notificações" 275x36, "Agora não"
      // 99x36) — achado real, mas de outra feature; não corrigido aqui
      // (não modificar arquivos alheios). Excluído explicitamente da
      // asserção desta tarefa (6.8.2), não do relatório: fica registrado
      // como Sugestão (severidade=aviso) para quem tocar aquele componente.
      const FORA_DE_ESCOPO_PUSH_MOTORISTA = new Set(['Ativar notificações', 'Agora não']);
      const violacoes = medidas.filter((m) => (m.width < 44 || m.height < 44) && !FORA_DE_ESCOPO_PUSH_MOTORISTA.has(m.rotulo));
      console.log(`ALVO_TOQUE tela="${tela.path}" elementos=${medidas.length} violacoes=${JSON.stringify(violacoes)}`);
      expect(violacoes, `alvos < 44x44px em ${tela.path}: ${JSON.stringify(violacoes)}`).toEqual([]);
    });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 6.8.3 — axe-core (escore >= 95, fórmula de ../e2e-hub-browser/axe-score.ts)
// + color-contrast (0 violações) nos dois temas (claro/escuro).
// ───────────────────────────────────────────────────────────────────────────
const TELAS_AXE = TELAS_TOQUE; // mesmo conjunto de telas novas/tocadas (6.8)

async function ativarTemaEscuro(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Ativar tema escuro' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
}

test.describe('6.8.3 — axe-core (escore >= 95) e contraste AA, 2 temas', () => {
  for (const tela of TELAS_AXE) {
    for (const tema of ['light', 'dark'] as const) {
      test(`${tela.nome} — tema ${tema}`, async ({ page }) => {
        const state = defaultState();
        tela.state?.(state);
        await setup(page, state);
        await page.goto(`${BASE}${tela.path}`);
        await page.waitForLoadState('networkidle');
        if (tema === 'dark') await ativarTemaEscuro(page);

        const resultado = await new AxeBuilder({ page }).analyze();
        const score = computeAxeScore(resultado.violations);
        console.log(`AXE_SCORE tela="${tela.path}" tema=${tema} score=${score} violacoes=${resultado.violations.length}`);
        for (const v of resultado.violations) {
          console.log(`AXE ${tela.path} [${tema}]: ${v.id} (${v.impact}) x${v.nodes.length} — ${v.help}`);
        }
        expect(score, `axe score ${tela.path} (${tema}): ${JSON.stringify(resultado.violations)}`).toBeGreaterThanOrEqual(AXE_SCORE_GATE);

        const contraste = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
        console.log(`AXE_CONTRASTE tela="${tela.path}" tema=${tema} violacoes=${contraste.violations.length}`);
        expect(contraste.violations, `contraste (${tema}) em ${tela.path}: ${JSON.stringify(contraste.violations)}`).toEqual([]);
      });
    }
  }
});
