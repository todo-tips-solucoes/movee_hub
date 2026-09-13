/**
 * Teste — app/sw.ts, handlers `push` e `notificationclick` (tasks.md 6.4.4).
 *
 * `frontend_motorista` não tem Playwright configurado (diferente do hub em
 * `frontend_v2`) e instalá-lo aqui seria dependência nova só para este
 * arquivo — não decidido por conta própria. Em vez de um E2E de browser,
 * este teste importa o MÓDULO REAL do service worker num `self` stub PURO
 * de Node (sem jsdom): registramos os listeners de `push`/`notificationclick`
 * exatamente como o navegador faria e disparamos eventos sintéticos neles,
 * observando os efeitos reais (`showNotification`, `clients.matchAll`,
 * `focus`/`navigate`/`openWindow`) — a mesma superfície que um E2E de
 * browser verificaria, sem precisar de um browser real. Viabilidade
 * confirmada por sondagem prévia: `new Serwist({...})` + `addEventListeners()`
 * rodam sem erro em Node puro com um `self` mínimo (registration/clients/
 * caches stubados), e os handlers `push`/`notificationclick` do próprio
 * sw.ts são capturados normalmente via `self.addEventListener`.
 *
 *   node --experimental-strip-types --test app/sw.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

type Handler = (event: unknown) => void;
const listeners = new Map<string, Handler[]>();

interface ShowNotificationCall {
  title: string;
  options: Record<string, unknown>;
}
const showNotificationCalls: ShowNotificationCall[] = [];

interface WindowClientFake {
  url: string;
  focusChamado: boolean;
  navigateChamadoCom?: string;
  focus(): Promise<WindowClientFake>;
  navigate(url: string): Promise<WindowClientFake>;
}
function criarWindowClientFake(url: string): WindowClientFake {
  const c: WindowClientFake = {
    url,
    focusChamado: false,
    async focus() {
      c.focusChamado = true;
      return c;
    },
    async navigate(destino: string) {
      c.navigateChamadoCom = destino;
      return c;
    },
  };
  return c;
}

let clientesAbertos: WindowClientFake[] = [];
let openWindowChamadoCom: string | undefined;

const selfStub = {
  __SW_MANIFEST: [] as unknown[],
  addEventListener(type: string, fn: Handler) {
    const arr = listeners.get(type) ?? [];
    arr.push(fn);
    listeners.set(type, arr);
  },
  registration: {
    async showNotification(title: string, options: Record<string, unknown>) {
      showNotificationCalls.push({ title, options });
    },
    navigationPreload: { enable: async () => {} },
  },
  clients: {
    async matchAll(): Promise<WindowClientFake[]> {
      return clientesAbertos;
    },
    async claim() {},
    async openWindow(url: string) {
      openWindowChamadoCom = url;
      return null;
    },
  },
  skipWaiting: async () => {},
  caches: {
    open: async () => ({
      keys: async () => [],
      put: async () => {},
      match: async () => undefined,
      delete: async () => true,
    }),
    keys: async () => [],
    delete: async () => true,
    match: async () => undefined,
  },
  location: { href: 'https://app.motorista.moveelog.com.br/' },
};

(globalThis as unknown as { self: unknown }).self = selfStub;

// Import dinâmico DEPOIS do stub de `self` (o módulo executa side-effects —
// `new Serwist(...)`, `serwist.addEventListeners()`, e os 2 `self.addEventListener`
// deste arquivo — assim que é carregado; um `import` estático seria hoisted
// e rodaria antes do stub acima existir).
await import('./sw.ts');

function pushHandler(): Handler {
  const h = listeners.get('push')?.[0];
  assert.ok(h, 'esperava exatamente 1 listener de "push" registrado por sw.ts');
  return h!;
}
function notificationClickHandler(): Handler {
  const h = listeners.get('notificationclick')?.[0];
  assert.ok(h, 'esperava exatamente 1 listener de "notificationclick" registrado por sw.ts');
  return h!;
}

function dispararPush(payload: unknown): Promise<unknown> | undefined {
  let promiseCapturada: Promise<unknown> | undefined;
  const event = {
    data: payload === undefined ? null : { json: () => payload },
    waitUntil(p: Promise<unknown>) {
      promiseCapturada = p;
    },
  };
  pushHandler()(event);
  return promiseCapturada;
}

function dispararNotificationClick(data: { url?: string } | undefined): Promise<unknown> | undefined {
  let promiseCapturada: Promise<unknown> | undefined;
  const notification = { close: () => {}, data };
  const event = {
    notification,
    action: '',
    waitUntil(p: Promise<unknown>) {
      promiseCapturada = p;
    },
  };
  notificationClickHandler()(event);
  return promiseCapturada;
}

// ── push (6.4.1) ──────────────────────────────────────────────────────────

test('push: payload válido -> showNotification chamado com titulo/corpo/tag/icon/data.url', async () => {
  showNotificationCalls.length = 0;
  const p = dispararPush({ avisoId: 42, titulo: 'Novo aviso', corpo: 'Confira o aviso 42' });
  assert.ok(p, 'handler deveria chamar event.waitUntil para payload válido');
  await p;

  assert.equal(showNotificationCalls.length, 1);
  const [chamada] = showNotificationCalls;
  assert.equal(chamada.title, 'Novo aviso');
  assert.equal(chamada.options.body, 'Confira o aviso 42');
  assert.equal(chamada.options.tag, 'aviso-42');
  assert.equal(chamada.options.icon, '/icons/icon-192x192.png');
  assert.deepEqual(chamada.options.data, { url: '/avisos/42' });
});

test('push: payload sem data (event.data null) -> descartado, showNotification NÃO chamado', () => {
  showNotificationCalls.length = 0;
  const p = dispararPush(undefined);
  assert.equal(p, undefined, 'handler não deveria chamar event.waitUntil sem payload');
  assert.equal(showNotificationCalls.length, 0);
});

test('push: payload com campo faltando (sem corpo) -> descartado, showNotification NÃO chamado', () => {
  showNotificationCalls.length = 0;
  const p = dispararPush({ avisoId: 1, titulo: 'Sem corpo' });
  assert.equal(p, undefined);
  assert.equal(showNotificationCalls.length, 0);
});

test('push: payload com tipo errado (avisoId como string) -> descartado, showNotification NÃO chamado', () => {
  showNotificationCalls.length = 0;
  const p = dispararPush({ avisoId: '42', titulo: 'x', corpo: 'y' });
  assert.equal(p, undefined);
  assert.equal(showNotificationCalls.length, 0);
});

test('push: event.data.json() lança (payload não-JSON) -> descartado, showNotification NÃO chamado', () => {
  showNotificationCalls.length = 0;
  let promiseCapturada: Promise<unknown> | undefined;
  const event = {
    data: {
      json() {
        throw new Error('payload não é JSON válido');
      },
    },
    waitUntil(p: Promise<unknown>) {
      promiseCapturada = p;
    },
  };
  pushHandler()(event);
  assert.equal(promiseCapturada, undefined);
  assert.equal(showNotificationCalls.length, 0);
});

// ── notificationclick (6.4.2) ────────────────────────────────────────────

test('notificationclick: com janela existente -> focus() + navigate(data.url), NÃO abre nova janela', async () => {
  const existente = criarWindowClientFake('https://app.motorista.moveelog.com.br/movimento');
  clientesAbertos = [existente];
  openWindowChamadoCom = undefined;

  const p = dispararNotificationClick({ url: '/avisos/42' });
  assert.ok(p);
  await p;

  assert.equal(existente.focusChamado, true);
  assert.equal(existente.navigateChamadoCom, '/avisos/42');
  assert.equal(openWindowChamadoCom, undefined);
});

test('notificationclick: sem janela existente -> abre nova janela em data.url via clients.openWindow', async () => {
  clientesAbertos = [];
  openWindowChamadoCom = undefined;

  const p = dispararNotificationClick({ url: '/avisos/99' });
  assert.ok(p);
  await p;

  assert.equal(openWindowChamadoCom, '/avisos/99');
});

test('notificationclick: sem data.url -> cai no fallback /movimento', async () => {
  clientesAbertos = [];
  openWindowChamadoCom = undefined;

  const p = dispararNotificationClick(undefined);
  assert.ok(p);
  await p;

  assert.equal(openWindowChamadoCom, '/movimento');
});
