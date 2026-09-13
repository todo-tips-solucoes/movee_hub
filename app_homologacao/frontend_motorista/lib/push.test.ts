/**
 * Teste unitário — lib/push.ts (tasks.md 6.1.3).
 *
 * Cobre os 5 estados de `estadoAtual()` (FR-004 a FR-007) + detecção de
 * plataforma/suporte via stub PURO de `window`/`navigator`/`Notification`
 * (Node puro, sem jsdom — as funções tocam só propriedades pontuais desses
 * três globais, nunca o DOM em si).
 *
 *   node --experimental-strip-types --test lib/push.test.ts
 *
 * Mesma exigência de Node já registrada em next-seguro.test.ts
 * (`--experimental-strip-types` exige Node >= 22.6).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estadoAtual, detectarPlataforma, isIOS, isStandalone, suportaPush } from './push.ts';

const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
const UA_IPAD_MODERNO = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/605.1.15';
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile';
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0';

interface StubOpts {
  userAgent?: string;
  maxTouchPoints?: number;
  standaloneMatch?: boolean;
  navigatorStandalone?: boolean;
  temServiceWorker?: boolean;
  temPushManager?: boolean;
  temNotification?: boolean;
  permission?: NotificationPermission;
}

function stubBrowser(opts: StubOpts): void {
  const {
    userAgent = UA_DESKTOP,
    maxTouchPoints = 0,
    standaloneMatch = false,
    navigatorStandalone,
    temServiceWorker = true,
    temPushManager = true,
    temNotification = true,
    permission = 'default',
  } = opts;

  const notification = temNotification ? { permission, requestPermission: async () => permission } : undefined;

  const win: Record<string, unknown> = {
    matchMedia: (query: string) => ({ matches: query.includes('standalone') ? standaloneMatch : false }),
  };
  if (temPushManager) win.PushManager = {};
  if (notification) win.Notification = notification;

  const nav: Record<string, unknown> = { userAgent, maxTouchPoints };
  if (temServiceWorker) nav.serviceWorker = {};
  if (navigatorStandalone !== undefined) nav.standalone = navigatorStandalone;

  (globalThis as unknown as Record<string, unknown>).window = win;
  // `navigator` já existe em Node >= 21 como getter-only (global experimental)
  // — precisa de defineProperty para substituir; `window`/`Notification` não
  // existem por padrão em Node, então atribuição direta basta.
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true, enumerable: true });
  (globalThis as unknown as Record<string, unknown>).Notification = notification;
}

function limpar(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.window;
  delete g.navigator;
  delete g.Notification;
}

// ── detecção de plataforma (isIOS/detectarPlataforma) ───────────────────

test('detectarPlataforma: iPhone -> ios', () => {
  stubBrowser({ userAgent: UA_IPHONE });
  assert.equal(detectarPlataforma(), 'ios');
  limpar();
});

test('detectarPlataforma: iPad moderno (UA Macintosh + touch) -> ios', () => {
  stubBrowser({ userAgent: UA_IPAD_MODERNO, maxTouchPoints: 5 });
  assert.equal(isIOS(), true);
  assert.equal(detectarPlataforma(), 'ios');
  limpar();
});

test('detectarPlataforma: Macintosh sem touch -> desktop_outros (não confundir com iPad)', () => {
  stubBrowser({ userAgent: UA_IPAD_MODERNO, maxTouchPoints: 0 });
  assert.equal(isIOS(), false);
  assert.equal(detectarPlataforma(), 'desktop_outros');
  limpar();
});

test('detectarPlataforma: Android -> android', () => {
  stubBrowser({ userAgent: UA_ANDROID });
  assert.equal(detectarPlataforma(), 'android');
  limpar();
});

test('detectarPlataforma: desktop -> desktop_outros', () => {
  stubBrowser({ userAgent: UA_DESKTOP });
  assert.equal(detectarPlataforma(), 'desktop_outros');
  limpar();
});

// ── isStandalone ─────────────────────────────────────────────────────────

test('isStandalone: true via matchMedia(display-mode: standalone)', () => {
  stubBrowser({ userAgent: UA_IPHONE, standaloneMatch: true });
  assert.equal(isStandalone(), true);
  limpar();
});

test('isStandalone: true via navigator.standalone (Safari legado)', () => {
  stubBrowser({ userAgent: UA_IPHONE, standaloneMatch: false, navigatorStandalone: true });
  assert.equal(isStandalone(), true);
  limpar();
});

test('isStandalone: false quando nenhum dos dois indica instalado', () => {
  stubBrowser({ userAgent: UA_IPHONE, standaloneMatch: false, navigatorStandalone: false });
  assert.equal(isStandalone(), false);
  limpar();
});

// ── suportaPush ──────────────────────────────────────────────────────────

test('suportaPush: false sem serviceWorker', () => {
  stubBrowser({ temServiceWorker: false });
  assert.equal(suportaPush(), false);
  limpar();
});

test('suportaPush: false sem PushManager', () => {
  stubBrowser({ temPushManager: false });
  assert.equal(suportaPush(), false);
  limpar();
});

test('suportaPush: false sem Notification', () => {
  stubBrowser({ temNotification: false });
  assert.equal(suportaPush(), false);
  limpar();
});

test('suportaPush: true com serviceWorker + PushManager + Notification presentes', () => {
  stubBrowser({});
  assert.equal(suportaPush(), true);
  limpar();
});

// ── estadoAtual: os 5 estados de PushEstadoAtivacao (FR-004 a FR-007) ───

test('estadoAtual: iOS sem standalone -> ios_sem_instalacao (mesmo com push suportado)', () => {
  stubBrowser({ userAgent: UA_IPHONE, standaloneMatch: false, permission: 'granted' });
  assert.equal(estadoAtual(), 'ios_sem_instalacao');
  limpar();
});

test('estadoAtual: iOS standalone mas sem PushManager -> sem_suporte (iOS antigo)', () => {
  stubBrowser({ userAgent: UA_IPHONE, standaloneMatch: true, temPushManager: false });
  assert.equal(estadoAtual(), 'sem_suporte');
  limpar();
});

test('estadoAtual: iOS standalone + suportado + permissão concedida -> ativas', () => {
  stubBrowser({ userAgent: UA_IPHONE, standaloneMatch: true, permission: 'granted' });
  assert.equal(estadoAtual(), 'ativas');
  limpar();
});

test('estadoAtual: iOS standalone + suportado + permissão negada -> bloqueadas', () => {
  stubBrowser({ userAgent: UA_IPHONE, standaloneMatch: true, permission: 'denied' });
  assert.equal(estadoAtual(), 'bloqueadas');
  limpar();
});

test('estadoAtual: Android sem suporte (sem PushManager) -> sem_suporte', () => {
  stubBrowser({ userAgent: UA_ANDROID, temPushManager: false });
  assert.equal(estadoAtual(), 'sem_suporte');
  limpar();
});

test('estadoAtual: Android permissão negada -> bloqueadas', () => {
  stubBrowser({ userAgent: UA_ANDROID, permission: 'denied' });
  assert.equal(estadoAtual(), 'bloqueadas');
  limpar();
});

test('estadoAtual: Android permissão default -> nao_ativadas', () => {
  stubBrowser({ userAgent: UA_ANDROID, permission: 'default' });
  assert.equal(estadoAtual(), 'nao_ativadas');
  limpar();
});

test('estadoAtual: Android permissão concedida -> ativas', () => {
  stubBrowser({ userAgent: UA_ANDROID, permission: 'granted' });
  assert.equal(estadoAtual(), 'ativas');
  limpar();
});

test('estadoAtual: desktop_outros permissão concedida -> ativas', () => {
  stubBrowser({ userAgent: UA_DESKTOP, permission: 'granted' });
  assert.equal(estadoAtual(), 'ativas');
  limpar();
});

test('estadoAtual: desktop_outros sem suporte -> sem_suporte', () => {
  stubBrowser({ userAgent: UA_DESKTOP, temNotification: false });
  assert.equal(estadoAtual(), 'sem_suporte');
  limpar();
});
