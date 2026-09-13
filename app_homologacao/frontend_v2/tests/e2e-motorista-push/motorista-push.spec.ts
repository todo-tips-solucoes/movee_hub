// motorista-push — tasks.md 3.3.3 / 6.2.4 / 6.5.3 / 8.1.3 / 8.1.4.
//
// SEGURANÇA (obrigatório nesta suíte, nunca remover):
//  - app_homologacao/frontend_motorista/app/api/[...path]/route.ts é um proxy
//    SERVER-SIDE: qualquer chamada `/api/*` do browser passaria por ele até
//    process.env.BACKEND_URL. `installNetworkGuard` intercepta TODO request do
//    browser (`page.route('**/*', ...)`) e só deixa passar o que é dirigido
//    ao próprio BASE (127.0.0.1:3006); tudo mais (inclusive o `<link>` de
//    Google Fonts do layout) é abortado e contado em `external[]`. Toda test
//    termina afirmando `external` vazio.
//  - `installApiStubs` intercepta `**/api/**` ANTES de qualquer coisa chegar
//    ao proxy Next (Playwright resolve o handler mais recentemente
//    registrado primeiro — LIFO — então este stub, registrado depois do
//    guard genérico, tem prioridade sobre ele para as rotas /api/*). O
//    processo do proxy real nunca é exercitado por este spec.
//  - `installPushStubsInit` substitui `Notification`/`PushManager`/
//    `navigator.serviceWorker` via `Object.defineProperty` (getter-only no
//    Chromium real) ANTES de qualquer script da página rodar — nunca dispara
//    o Push Service real do navegador nem um Service Worker de verdade.
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const BASE = process.env.MOTORISTA_E2E_BASE_URL || 'http://127.0.0.1:3006';
const CNPJ_TESTE = '12.345.678/0001-99';
const SENHA_TESTE = 'senha-sintetica-e2e';

interface Aviso {
  id: number;
  titulo: string;
  corpo: string;
  enviadoEm: string;
}

interface StubState {
  authenticated: boolean;
  avisos: Record<string, Aviso>;
}

function defaultState(): StubState {
  return { authenticated: true, avisos: {} };
}

// app/layout.tsx (raiz, fora do escopo desta feature) tem um <link> hardcoded
// para o CSS de ícones "Material Symbols Rounded" no Google Fonts — sempre
// tentado em TODA página, independente do que estamos testando. Continua
// sendo abortado (0 bytes saem para a rede em NENHUM caso, inclusive este),
// só não entra no array `external[]` que a suíte afirma vazio, para não
// confundir "quirk pré-existente e inofensivo (uma folha de estilo de
// ícones)" com "vazamento para backend/produção real" — que é o risco de
// verdade que esta suíte guarda.
const EXTERNAL_BENIGNO_CONHECIDO = [/^https:\/\/fonts\.googleapis\.com\//, /^https:\/\/fonts\.gstatic\.com\//];

/** Bloqueia QUALQUER request fora do próprio BASE (defesa contra produção). */
async function installNetworkGuard(page: Page, external: string[]): Promise<void> {
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(BASE)) {
      await route.continue();
      return;
    }
    if (!EXTERNAL_BENIGNO_CONHECIDO.some((re) => re.test(url))) {
      external.push(url);
    }
    await route.abort();
  });
}

/** Stub de TODOS os endpoints /api/motorista/* usados pelas telas cobertas. */
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
    if (path === '/motorista/token/refresh' && method === 'POST') {
      return json(200, {});
    }
    if (path === '/motorista/empresas-proprietarias' && method === 'GET') {
      return json(200, { empresas: ['Empresa E2E'] });
    }
    if (path === '/motorista/movimento-aberto' && method === 'GET') {
      return json(200, { movimento: null });
    }
    if (path.startsWith('/motorista/avisos/') && method === 'GET') {
      const id = path.split('/').pop() as string;
      const aviso = state.avisos[id];
      return aviso ? json(200, aviso) : json(404, { message: 'Aviso não encontrado' });
    }
    if (path === '/motorista/push/chave-publica' && method === 'GET') {
      return json(200, { chavePublica: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', keyId: 'stub-key-1' });
    }
    if (path === '/motorista/push/inscricao' && method === 'PUT') {
      return noContent();
    }
    if (path === '/motorista/push/estado' && method === 'PUT') {
      return noContent();
    }
    if (path === '/motorista/push/inscricao/revogar' && method === 'POST') {
      return noContent();
    }
    return json(404, { message: 'stub sem handler', path, method });
  });
}

interface PushStubConfig {
  ua?: string;
  standalone?: boolean;
  removeNotification?: boolean;
  initialPermission?: 'default' | 'denied' | 'granted';
  requestPermissionResult?: 'default' | 'denied' | 'granted';
}

// Roda ANTES de qualquer script da página (Playwright garante a ordem) —
// substitui os 3 globais que lib/push.ts consulta, sem depender de um Push
// Service ou Service Worker reais. Não pode capturar escopo externo (é
// serializada e avaliada no browser).
function installPushStubsInit(cfg: PushStubConfig): void {
  if (cfg.ua) {
    Object.defineProperty(window.navigator, 'userAgent', { value: cfg.ua, configurable: true });
  }
  if (typeof cfg.standalone === 'boolean') {
    Object.defineProperty(window.navigator, 'standalone', { value: cfg.standalone, configurable: true });
  }
  (window as unknown as { __requestPermissionCalls: number }).__requestPermissionCalls = 0;

  if (cfg.removeNotification) {
    // 6.2.4 Scenario 6 (sem_suporte): `'Notification' in window` precisa
    // virar false — suportaPush() checa os 3 globais com `&&`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).Notification;
  } else {
    class FakeNotification {
      static permission: 'default' | 'denied' | 'granted' = cfg.initialPermission || 'default';
      static requestPermission(): Promise<'default' | 'denied' | 'granted'> {
        (window as unknown as { __requestPermissionCalls: number }).__requestPermissionCalls += 1;
        const resultado = cfg.requestPermissionResult || 'granted';
        FakeNotification.permission = resultado;
        return Promise.resolve(resultado);
      }
    }
    Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true, writable: true });
  }

  if (!('PushManager' in window)) {
    Object.defineProperty(window, 'PushManager', {
      value: function PushManagerStub() {},
      configurable: true,
    });
  }

  const fakeSubscription = {
    endpoint: 'https://fake-push.example.test/e/stub',
    toJSON() {
      return { endpoint: this.endpoint, keys: { p256dh: 'stub-p256dh', auth: 'stub-auth' } };
    },
    unsubscribe: async () => true,
  };
  // @serwist/next injeta um script de auto-registro que chama
  // `registration.addEventListener('updatefound', ...)` — precisa ser um
  // EventTarget de verdade pelo mesmo motivo do container acima.
  const fakeRegistration = Object.assign(new EventTarget(), {
    pushManager: {
      getSubscription: async () => null,
      subscribe: async () => fakeSubscription,
    },
    update: async () => undefined,
  });
  // components/sw-updater.tsx trata `navigator.serviceWorker` como um
  // EventTarget real (addEventListener/removeEventListener/controller) — um
  // objeto plano sem essa interface derruba a árvore React inteira com
  // "navigator.serviceWorker.addEventListener is not a function" (achado
  // desta suíte). `new EventTarget()` dá addEventListener/removeEventListener
  // reais de graça; anexamos as propriedades específicas de push por cima.
  const fakeServiceWorkerContainer = Object.assign(new EventTarget(), {
    ready: Promise.resolve(fakeRegistration),
    getRegistration: async () => fakeRegistration,
    register: async () => fakeRegistration,
    controller: null,
  });
  Object.defineProperty(window.navigator, 'serviceWorker', {
    value: fakeServiceWorkerContainer,
    configurable: true,
  });
}

async function setup(page: Page, state: StubState, pushCfg: PushStubConfig = {}): Promise<string[]> {
  const external: string[] = [];
  await installNetworkGuard(page, external);
  await installApiStubs(page, state);
  await page.addInitScript(installPushStubsInit, pushCfg);
  return external;
}

async function fazerLogin(page: Page): Promise<void> {
  await page.getByLabel('CNPJ do Prestador').fill(CNPJ_TESTE);
  await page.getByLabel('Senha').fill(SENHA_TESTE);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

// ───────────────────────────────────────────────────────────────────────────
// 3.3.3 — Teste E2E do redirecionamento seguro de `next` (mesmos 6 casos de
// 3.3.2/lib/next-seguro.test.ts), agora contra o app real renderizado.
// ───────────────────────────────────────────────────────────────────────────
const casosRedirect: Array<{ nome: string; next: string; esperado: string }> = [
  { nome: 'origem diferente (protocol-relative //evil.example)', next: '//evil.example', esperado: '/movimento' },
  { nome: 'barra invertida (/\\evil.example)', next: '/\\evil.example', esperado: '/movimento' },
  { nome: 'TAB antes do host (/\\t/evil.example)', next: '/\t/evil.example', esperado: '/movimento' },
  { nome: 'LF antes do host (/\\n/evil.example)', next: '/\n/evil.example', esperado: '/movimento' },
  { nome: 'esquema javascript: (javascript:alert(1))', next: 'javascript:alert(1)', esperado: '/movimento' },
  { nome: 'caminho válido mesma origem (/avisos/123)', next: '/avisos/123', esperado: '/avisos/123' },
];

for (const caso of casosRedirect) {
  test(`3.3.3 redirecionamento seguro de next: ${caso.nome}`, async ({ page }) => {
    const state = defaultState();
    state.authenticated = false;
    state.avisos['123'] = { id: 123, titulo: 'Aviso 123', corpo: 'corpo 123', enviadoEm: new Date().toISOString() };
    const external = await setup(page, state);

    await page.goto(`${BASE}/login?next=${encodeURIComponent(caso.next)}`);
    await fazerLogin(page);
    await page.waitForURL((url) => url.pathname === caso.esperado, { timeout: 15_000 });
    expect(new URL(page.url()).pathname).toBe(caso.esperado);
    expect(external, `requests externos inesperados: ${external.join(', ')}`).toEqual([]);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// 6.2.4 — US1 Acceptance Scenarios 1/2/4/5/6/7 do passo de contexto de
// notificações (components/notificacoes.tsx, montado em /movimento).
// ───────────────────────────────────────────────────────────────────────────
test('6.2.4 Scenario 1: nenhum pedido automático de permissão ao montar', async ({ page }) => {
  const external = await setup(page, defaultState(), { initialPermission: 'default' });
  await page.goto(`${BASE}/movimento`);
  await expect(page.getByRole('button', { name: 'Ativar notificações' })).toBeVisible();
  const chamadas = await page.evaluate(() => (window as unknown as { __requestPermissionCalls: number }).__requestPermissionCalls);
  expect(chamadas, 'Notification.requestPermission não pode ser chamado sem gesto do usuário').toBe(0);
  expect(external).toEqual([]);
});

test('6.2.4 Scenario 2: ativar com gesto explícito do usuário', async ({ page }) => {
  const external = await setup(page, defaultState(), { initialPermission: 'default', requestPermissionResult: 'granted' });
  await page.goto(`${BASE}/movimento`);
  await page.getByRole('button', { name: 'Ativar notificações' }).click();
  await expect(page.getByText('Notificações ativas neste aparelho.')).toBeVisible();
  const chamadas = await page.evaluate(() => (window as unknown as { __requestPermissionCalls: number }).__requestPermissionCalls);
  expect(chamadas).toBe(1);
  expect(external).toEqual([]);
});

test('6.2.4 Scenario 4: iOS sem instalação (fora do PWA)', async ({ page }) => {
  const external = await setup(page, defaultState(), {
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    standalone: false,
  });
  await page.goto(`${BASE}/movimento`);
  await expect(page.getByText('Instale o app para receber avisos')).toBeVisible();
  expect(external).toEqual([]);
});

test('6.2.4 Scenario 5: permissão já bloqueada pelo navegador', async ({ page }) => {
  const external = await setup(page, defaultState(), { initialPermission: 'denied' });
  await page.goto(`${BASE}/movimento`);
  await expect(page.getByText('Notificações bloqueadas')).toBeVisible();
  expect(external).toEqual([]);
});

test('6.2.4 Scenario 6: navegador sem suporte a push', async ({ page }) => {
  const external = await setup(page, defaultState(), { removeNotification: true });
  await page.goto(`${BASE}/movimento`);
  await expect(page.getByText('Este navegador não recebe notificações.')).toBeVisible();
  expect(external).toEqual([]);
});

test('6.2.4 Scenario 7: ponto de entrada compacto após dispensar (persiste no reload)', async ({ page }) => {
  const external = await setup(page, defaultState(), { initialPermission: 'default' });
  await page.goto(`${BASE}/movimento`);
  await page.getByRole('button', { name: 'Agora não' }).click();
  await expect(page.getByRole('button', { name: 'Ativar notificações de avisos' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Ativar notificações de avisos' })).toBeVisible();
  expect(external).toEqual([]);
});

// ───────────────────────────────────────────────────────────────────────────
// 6.5.3 — sessão válida / sessão expirada / aviso indisponível (US2).
// ───────────────────────────────────────────────────────────────────────────
test('6.5.3 Cenário 1: sessão válida exibe o conteúdo do aviso', async ({ page }) => {
  const state = defaultState();
  state.avisos['501'] = {
    id: 501,
    titulo: 'Manutenção programada',
    corpo: 'Sistema indisponível às 22h de hoje.',
    enviadoEm: new Date().toISOString(),
  };
  const external = await setup(page, state);
  await page.goto(`${BASE}/avisos/501`);
  await expect(page.getByText('Manutenção programada')).toBeVisible();
  await expect(page.getByText('Sistema indisponível às 22h de hoje.')).toBeVisible();
  expect(external).toEqual([]);
});

test('6.5.3 Cenário 2: sessão expirada vai ao login e retorna ao destino após autenticar', async ({ page }) => {
  const state = defaultState();
  state.authenticated = false;
  state.avisos['777'] = {
    id: 777,
    titulo: 'Aviso pós-login',
    corpo: 'conteúdo visível só após autenticar de novo',
    enviadoEm: new Date().toISOString(),
  };
  const external = await setup(page, state);
  await page.goto(`${BASE}/avisos/777`);
  await page.waitForURL((url) => url.pathname === '/login', { timeout: 15_000 });
  expect(new URL(page.url()).searchParams.get('next')).toBe('/avisos/777');
  await fazerLogin(page);
  await page.waitForURL((url) => url.pathname === '/avisos/777', { timeout: 15_000 });
  await expect(page.getByText('Aviso pós-login')).toBeVisible();
  expect(external).toEqual([]);
});

test('6.5.3 Cenário 3: aviso expurgado/inexistente/fora-de-escopo mostram a MESMA mensagem, sem distinção', async ({ page }) => {
  const external = await setup(page, defaultState());
  // Nenhum dos 3 ids está em state.avisos — o stub responde 404 aos 3, tal
  // como o backend real (contracts/motorista-push.md: sem distinção entre
  // expurgado/inexistente/fora-de-escopo).
  for (const id of ['888', '889', '890']) {
    await page.goto(`${BASE}/avisos/${id}`);
    await expect(page.getByText('Aviso não disponível')).toBeVisible();
  }
  expect(external).toEqual([]);
});

// ───────────────────────────────────────────────────────────────────────────
// 8.1.3 — verificação manual com teclado apenas (Tab/Shift+Tab/Enter/Espaço).
// ───────────────────────────────────────────────────────────────────────────
test('8.1.3 teclado: "Ativar notificações" alcançável por Tab e operável por Enter', async ({ page }) => {
  const external = await setup(page, defaultState(), { initialPermission: 'default', requestPermissionResult: 'denied' });
  await page.goto(`${BASE}/movimento`);
  const botaoAtivar = page.getByRole('button', { name: 'Ativar notificações' });
  await expect(botaoAtivar).toBeVisible();

  let alcancado = false;
  for (let i = 0; i < 30 && !alcancado; i += 1) {
    await page.keyboard.press('Tab');
    alcancado = await botaoAtivar.evaluate((el) => el === document.activeElement);
  }
  expect(alcancado, 'Tab deveria alcançar o botão "Ativar notificações" em até 30 passos').toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.getByText('Notificações bloqueadas')).toBeVisible();
  console.log('8.1.3: controle 1/3 ("Ativar notificações", Enter) — operável via teclado');
  expect(external).toEqual([]);
});

test('8.1.3 teclado: "Agora não" alcançável por Tab e operável por Espaço', async ({ page }) => {
  const external = await setup(page, defaultState(), { initialPermission: 'default' });
  await page.goto(`${BASE}/movimento`);
  const botaoDispensar = page.getByRole('button', { name: 'Agora não' });
  await expect(botaoDispensar).toBeVisible();

  let alcancado = false;
  for (let i = 0; i < 30 && !alcancado; i += 1) {
    await page.keyboard.press('Tab');
    alcancado = await botaoDispensar.evaluate((el) => el === document.activeElement);
  }
  expect(alcancado, 'Tab deveria alcançar o botão "Agora não" em até 30 passos').toBe(true);
  await page.keyboard.press(' ');
  await expect(page.getByRole('button', { name: 'Ativar notificações de avisos' })).toBeVisible();
  console.log('8.1.3: controle 2/3 ("Agora não", Espaço) — operável via teclado');
  expect(external).toEqual([]);
});

test('8.1.3 teclado: formulário de login operável via Tab + Enter (sem mouse)', async ({ page }) => {
  const state = defaultState();
  state.authenticated = false;
  const external = await setup(page, state);
  await page.goto(`${BASE}/login`);
  await page.getByLabel('CNPJ do Prestador').click(); // foco inicial equivalente a 1º Tab do usuário
  await page.keyboard.type(CNPJ_TESTE);
  await page.keyboard.press('Tab');
  await page.keyboard.type(SENHA_TESTE);
  await page.keyboard.press('Tab');
  const focoNoBotao = await page.getByRole('button', { name: 'Entrar' }).evaluate((el) => el === document.activeElement);
  expect(focoNoBotao, 'Tab a partir do campo Senha deveria alcançar o botão Entrar').toBe(true);
  await page.keyboard.press('Enter');
  await page.waitForURL((url) => url.pathname === '/movimento', { timeout: 15_000 });
  console.log('8.1.3: controle 3/3 (form de login, Tab+Enter) — operável via teclado');
  expect(external).toEqual([]);
});

// ───────────────────────────────────────────────────────────────────────────
// 8.1.4 — verificação automatizada (axe-core) nas 3 telas cobertas.
//
// Escopo literal da subtarefa (tasks.md): "0 violações de NOME ACESSÍVEL
// (meta) ou a lista de achados com severidade" — o mesmo tema de 8.1.2, não
// uma varredura geral de a11y. Por isso o gate desta subtarefa é só sobre as
// regras axe de nome acessível; qualquer OUTRA violação (ex.: contraste de
// cor) é reportada à parte, sem falhar o teste — é um achado real, mas fora
// do escopo desta subtarefa específica.
// ───────────────────────────────────────────────────────────────────────────
const AXE_REGRAS_NOME_ACESSIVEL = new Set([
  'button-name',
  'link-name',
  'image-alt',
  'input-image-alt',
  'area-alt',
  'aria-command-name',
  'aria-input-field-name',
  'aria-toggle-field-name',
  'aria-tooltip-name',
  'select-name',
  'label',
  'form-field-multiple-labels',
  'document-title',
  'frame-title',
  'svg-img-alt',
]);

test('8.1.4 axe-core: 0 violações de nome acessível em movimento, avisos/[id] e login', async ({ page }) => {
  const state = defaultState();
  state.avisos['999'] = {
    id: 999,
    titulo: 'Aviso para varredura de acessibilidade',
    corpo: 'corpo do aviso',
    enviadoEm: new Date().toISOString(),
  };
  const external = await setup(page, state);

  const achadosNome: Record<string, number> = {};
  const achadosOutros: Record<string, number> = {};

  async function varrer(rotulo: string, url: string) {
    await page.goto(url);
    const resultado = await new AxeBuilder({ page }).analyze();
    const nome = resultado.violations.filter((v) => AXE_REGRAS_NOME_ACESSIVEL.has(v.id));
    const outros = resultado.violations.filter((v) => !AXE_REGRAS_NOME_ACESSIVEL.has(v.id));
    for (const v of nome) console.log(`AXE ${rotulo} [NOME ACESSÍVEL]: ${v.id} (${v.impact}) — ${v.help}`);
    for (const v of outros) console.log(`AXE ${rotulo} [fora do escopo 8.1.4, achado à parte]: ${v.id} (${v.impact}) — ${v.help}`);
    achadosNome[rotulo] = nome.length;
    achadosOutros[rotulo] = outros.length;
  }

  await varrer('/movimento', `${BASE}/movimento`);
  await varrer('/avisos/999', `${BASE}/avisos/999`);
  state.authenticated = false;
  await varrer('/login', `${BASE}/login`);

  console.log(`8.1.4: violações de nome acessível por tela = ${JSON.stringify(achadosNome)}`);
  console.log(`8.1.4: achados fora de escopo (outras regras axe, reportados à parte) = ${JSON.stringify(achadosOutros)}`);
  expect(achadosNome, JSON.stringify(achadosNome)).toEqual({ '/movimento': 0, '/avisos/999': 0, '/login': 0 });
  expect(external).toEqual([]);
});
