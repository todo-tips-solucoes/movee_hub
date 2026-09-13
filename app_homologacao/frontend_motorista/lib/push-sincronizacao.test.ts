/**
 * Teste unitário — lib/push.ts#sincronizar / #revogar (tasks.md 6.3.3).
 *
 * Stub PURO de `window`/`navigator`/`Notification`/`fetch` (Node puro, sem
 * jsdom nem mock de módulo — `api-client.ts` usa o `fetch` global, então
 * basta substituí-lo). Cobre os cenários descritos em tasks.md 6.3.3:
 * inscrição inalterada, mudança de chave (`409`/keyId), e a ordem
 * revogar-antes-do-logout (checada estaticamente no source de
 * `contexts/auth-context.tsx`, que é um componente React e não é
 * executável fora de um DOM — ver comentário no teste de ordem abaixo).
 *
 *   node --experimental-strip-types --test lib/push-sincronizacao.test.ts
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sincronizar, revogar } from './push.ts';

// ── stub de localStorage ─────────────────────────────────────────────────

class LocalStorageStub {
  private mapa = new Map<string, string>();
  getItem(k: string): string | null {
    return this.mapa.has(k) ? this.mapa.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.mapa.set(k, v);
  }
  clear(): void {
    this.mapa.clear();
  }
}

// ── stub de PushSubscription ─────────────────────────────────────────────

interface FakeSubscription {
  endpoint: string;
  unsubscribeChamado: boolean;
  toJSON(): { endpoint: string; keys: { p256dh: string; auth: string } };
  unsubscribe(): Promise<boolean>;
}

function criarFakeSubscription(endpoint: string): FakeSubscription {
  const sub: FakeSubscription = {
    endpoint,
    unsubscribeChamado: false,
    toJSON: () => ({ endpoint, keys: { p256dh: 'p256dh-fake', auth: 'auth-fake' } }),
    async unsubscribe() {
      sub.unsubscribeChamado = true;
      return true;
    },
  };
  return sub;
}

// ── estado mutável do cenário corrente (resetado em beforeEach) ─────────

let subscriptionAtual: FakeSubscription | null = null;
let subscribeChamado = 0;
let novoEndpointGerado = 'https://push.example/nova-assinatura';
let chaveKeyIdAtual = 'chave-1';
let inscricaoRespostas: number[] = [204]; // fila de status HTTP p/ chamadas sucessivas de PUT inscricao
let revogarResposta = 204;
const localStorageStub = new LocalStorageStub();

interface FetchCall {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}
let fetchCalls: FetchCall[] = [];

function fakeResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body ?? {},
  } as unknown as Response;
}

function proximaRespostaInscricao(): number {
  return inscricaoRespostas.length > 1 ? inscricaoRespostas.shift()! : inscricaoRespostas[0];
}

function stubFetch(): void {
  (globalThis as unknown as Record<string, unknown>).fetch = async (
    input: unknown,
    init?: { method?: string; body?: unknown },
  ): Promise<Response> => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    fetchCalls.push({ url, method, body });

    if (url.endsWith('/motorista/push/inscricao') && method === 'PUT') {
      return fakeResponse(proximaRespostaInscricao());
    }
    if (url.endsWith('/motorista/push/chave-publica') && method === 'GET') {
      return fakeResponse(200, { chavePublica: 'AAAA', keyId: chaveKeyIdAtual });
    }
    if (url.endsWith('/motorista/push/estado') && method === 'PUT') {
      return fakeResponse(204);
    }
    if (url.endsWith('/motorista/push/inscricao/revogar') && method === 'POST') {
      return fakeResponse(revogarResposta);
    }
    return fakeResponse(404, { message: `rota não stubada: ${method} ${url}` });
  };
}

function stubBrowser(): void {
  const g = globalThis as unknown as Record<string, unknown>;

  const pushManager = {
    async getSubscription(): Promise<FakeSubscription | null> {
      return subscriptionAtual;
    },
    async subscribe(): Promise<FakeSubscription> {
      subscribeChamado += 1;
      subscriptionAtual = criarFakeSubscription(novoEndpointGerado);
      return subscriptionAtual;
    },
  };
  const registration = { pushManager };

  g.window = { localStorage: localStorageStub, PushManager: {}, Notification: { permission: 'granted' } };
  // `navigator` já existe em Node >= 21 como getter-only (global experimental)
  // — precisa de defineProperty para substituir (lib/push.test.ts tem a
  // mesma nota).
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)',
      serviceWorker: {
        ready: Promise.resolve(registration),
        async getRegistration() {
          return registration;
        },
      },
    },
    configurable: true,
    writable: true,
    enumerable: true,
  });
  g.Notification = { permission: 'granted' };
}

function limpar(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.window;
  delete g.navigator;
  delete g.Notification;
  delete g.fetch;
}

beforeEach(() => {
  subscriptionAtual = null;
  subscribeChamado = 0;
  novoEndpointGerado = 'https://push.example/nova-assinatura';
  chaveKeyIdAtual = 'chave-1';
  inscricaoRespostas = [204];
  revogarResposta = 204;
  fetchCalls = [];
  localStorageStub.clear();
  stubFetch();
  stubBrowser();
});

// ── sincronizar() ─────────────────────────────────────────────────────────

test('sincronizar: inscrição inalterada (subscription + keyId iguais) -> PUT inscricao chamado, subscribe() NÃO chamado', async () => {
  subscriptionAtual = criarFakeSubscription('https://push.example/existente');
  localStorageStub.setItem('push.keyId', 'chave-1');
  chaveKeyIdAtual = 'chave-1';

  await sincronizar();

  assert.equal(subscribeChamado, 0, 'não deveria gerar nova assinatura quando nada mudou');
  const put = fetchCalls.find((c) => c.method === 'PUT' && c.url.endsWith('/motorista/push/inscricao'));
  assert.ok(put, 'esperava um PUT /motorista/push/inscricao');
  assert.equal(put!.body?.endpoint, 'https://push.example/existente');
  assert.equal(subscriptionAtual!.unsubscribeChamado, false);
  limpar();
});

test('sincronizar: subscription ausente -> gera nova assinatura (subscribe) e salva o keyId novo', async () => {
  subscriptionAtual = null;
  chaveKeyIdAtual = 'chave-2';

  await sincronizar();

  assert.equal(subscribeChamado, 1);
  assert.equal(localStorageStub.getItem('push.keyId'), 'chave-2');
  const put = fetchCalls.find((c) => c.method === 'PUT' && c.url.endsWith('/motorista/push/inscricao'));
  assert.equal(put?.body?.endpoint, novoEndpointGerado);
  limpar();
});

test('sincronizar: keyId salvo diferente do atual (subscription existente) -> unsubscribe da antiga + nova assinatura', async () => {
  const antiga = criarFakeSubscription('https://push.example/antiga');
  subscriptionAtual = antiga;
  localStorageStub.setItem('push.keyId', 'chave-velha');
  chaveKeyIdAtual = 'chave-nova';

  await sincronizar();

  assert.equal(antiga.unsubscribeChamado, true);
  assert.equal(subscribeChamado, 1);
  assert.equal(localStorageStub.getItem('push.keyId'), 'chave-nova');
  limpar();
});

test('sincronizar: 409 (CHAVE_DESATUALIZADA) no PUT inalterado -> reassina uma vez sem propagar erro', async () => {
  subscriptionAtual = criarFakeSubscription('https://push.example/existente');
  localStorageStub.setItem('push.keyId', 'chave-1');
  chaveKeyIdAtual = 'chave-1'; // keyId "igual" -> cai no branch que tenta o PUT direto primeiro
  inscricaoRespostas = [409, 204]; // 1ª chamada falha (corrida), 2ª (pós-reassinatura) sucede

  const original = subscriptionAtual!;
  await assert.doesNotReject(() => sincronizar());

  assert.equal(original.unsubscribeChamado, true, 'deveria desinscrever a assinatura desatualizada');
  assert.equal(subscribeChamado, 1, 'deveria reassinar exatamente 1 vez após o 409');
  const putsInscricao = fetchCalls.filter((c) => c.method === 'PUT' && c.url.endsWith('/motorista/push/inscricao'));
  assert.equal(putsInscricao.length, 2, 'esperava a tentativa original + o retry pós-reassinatura');
  limpar();
});

test('sincronizar: Notification.permission !== "granted" -> retorna sem nenhuma chamada de rede (nunca pede permissão de novo)', async () => {
  const g = globalThis as unknown as { Notification: unknown; window: { Notification: unknown } };
  const naoConcedida = { permission: 'default' };
  g.Notification = naoConcedida;
  g.window.Notification = naoConcedida;

  await sincronizar();

  assert.equal(fetchCalls.length, 0);
  assert.equal(subscribeChamado, 0);
  limpar();
});

test('sincronizar: fluxo feliz reporta estado "ativas" ao final (PUT /motorista/push/estado)', async () => {
  subscriptionAtual = criarFakeSubscription('https://push.example/existente');
  localStorageStub.setItem('push.keyId', 'chave-1');
  chaveKeyIdAtual = 'chave-1';

  await sincronizar();

  const estado = fetchCalls.find((c) => c.method === 'PUT' && c.url.endsWith('/motorista/push/estado'));
  assert.ok(estado, 'esperava um PUT /motorista/push/estado');
  assert.equal(estado!.body?.estado, 'ativas');
  limpar();
});

// ── revogar() ─────────────────────────────────────────────────────────────

test('revogar: subscription existente -> POST revogar seguido de unsubscribe(), mesmo com 401 (access vencido) não lança', async () => {
  subscriptionAtual = criarFakeSubscription('https://push.example/existente');
  revogarResposta = 401; // access token já vencido no logout — cenário do contrato R7

  await assert.doesNotReject(() => revogar());

  const post = fetchCalls.find((c) => c.method === 'POST' && c.url.endsWith('/motorista/push/inscricao/revogar'));
  assert.ok(post, 'esperava um POST /motorista/push/inscricao/revogar mesmo sabendo que vai falhar');
  assert.equal(subscriptionAtual!.unsubscribeChamado, true, 'unsubscribe() local é a garantia real (R7), roda mesmo com falha do servidor');
  limpar();
});

test('revogar: sem subscription -> não faz nenhuma chamada de rede', async () => {
  subscriptionAtual = null;

  await assert.doesNotReject(() => revogar());

  assert.equal(fetchCalls.length, 0);
  limpar();
});

// ── ordem revogar-antes-do-logout (contexts/auth-context.tsx) ────────────
//
// `logout()` em auth-context.tsx é um `useCallback` dentro de um componente
// React — só executa dentro do ciclo de vida de um <AuthProvider> renderizado
// (chamar useCallback fora de render lança "Invalid hook call"). Testar a
// ORDEM real de chamada exigiria renderizar o provider (React Testing
// Library + jsdom), que não estão instalados neste app — nova dependência,
// não instalada por conta própria (ver bloqueio humano desta onda para
// 6.2.4/6.5.3, mesmo motivo). Esta checagem estática cobre a mesma
// regressão de que o item se preocupa (reordenar as duas chamadas) sem
// precisar renderizar React: garante que `await revogarPush()` aparece
// ANTES de `api.post('/motorista/logout')` no source.
test('contexts/auth-context.tsx: logout chama revogarPush() ANTES do POST /motorista/logout (FR-009/6.3.2)', async () => {
  const src = await readFile(new URL('../contexts/auth-context.tsx', import.meta.url), 'utf8');
  const idxRevogar = src.indexOf('await revogarPush()');
  const idxLogoutPost = src.indexOf("api.post('/motorista/logout')");
  assert.ok(idxRevogar >= 0, 'chamada a revogarPush() não encontrada em auth-context.tsx');
  assert.ok(idxLogoutPost >= 0, 'chamada a POST /motorista/logout não encontrada em auth-context.tsx');
  assert.ok(
    idxRevogar < idxLogoutPost,
    'revogarPush() deve ser chamado ANTES do POST /motorista/logout (best-effort — falha não pode impedir o logout)',
  );
});
