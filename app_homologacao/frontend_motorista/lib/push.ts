/**
 * push-motorista — lib/push.ts (tasks.md 6.1)
 *
 * Detecção de suporte/plataforma/estado (FR-007) e ciclo de vida da
 * inscrição push: ativar (FR-001 a FR-004), sincronizar a cada abertura
 * (FR-008) e revogar no logout (FR-009). Nenhum PII em `localStorage` — só
 * `dispositivoId` (UUID aleatório) e `keyId` (hash público da chave VAPID
 * ativa), ver contracts/motorista-push.md §Estado local.
 *
 * Ref: contracts/motorista-push.md, spec FR-001 a FR-010, tasks.md 6.1/6.3.
 */

// Extensão `.ts` explícita (tasks.md 6.1.3/6.3.3, allowImportingTsExtensions):
// este módulo agora é importado diretamente pelo runner nativo do Node
// (lib/push.test.ts, lib/push-sincronizacao.test.ts) — o resolvedor ESM do
// Node exige especificador completo; extensão explícita não quebra o build
// do Next.js (webpack já resolve o arquivo literal).
import { api, ApiError } from './api-client.ts';

export type PlataformaPush = 'android' | 'ios' | 'desktop_outros';
export type EstadoPush = 'ativas' | 'bloqueadas' | 'ios_sem_instalacao' | 'sem_suporte' | 'nao_ativadas';

export interface ResultadoAtivacao {
  ok: boolean;
  estado: EstadoPush;
  erro?: string;
}

interface ChavePublica {
  chavePublica: string;
  keyId: string;
}

const LS_DISPOSITIVO_ID = 'push.dispositivoId';
const LS_KEY_ID = 'push.keyId';

// ──────────────────────────────────────────────────────────────────────────
// localStorage (sem token, sem PII — contracts §Estado local)
// ──────────────────────────────────────────────────────────────────────────

export function obterDispositivoId(): string {
  if (typeof window === 'undefined') return '';
  let id = window.localStorage.getItem(LS_DISPOSITIVO_ID);
  if (!id) {
    id = crypto.randomUUID();
    window.localStorage.setItem(LS_DISPOSITIVO_ID, id);
  }
  return id;
}

function obterKeyIdSalvo(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(LS_KEY_ID);
}

function salvarKeyId(keyId: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LS_KEY_ID, keyId);
}

// ──────────────────────────────────────────────────────────────────────────
// Detecção de plataforma/suporte/estado (FR-004, FR-005, FR-006, FR-007)
// ──────────────────────────────────────────────────────────────────────────

export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // iPadOS moderno se anuncia como "Macintosh" — só o touch denuncia o iPad.
  return /iP(hone|ad|od)/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return (window.matchMedia?.('(display-mode: standalone)').matches ?? false) || nav.standalone === true;
}

export function detectarPlataforma(): PlataformaPush {
  if (isIOS()) return 'ios';
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return /Android/i.test(ua) ? 'android' : 'desktop_outros';
}

export function suportaPush(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/**
 * Estado atual de ativação (FR-007, 5 estados) — só leitura, sem efeito
 * colateral. iOS sem instalação é checado ANTES do suporte (Safari em iOS
 * expõe `Notification`/`PushManager` só dentro do PWA instalado; fora dele
 * o motorista precisa da orientação de instalar, não de "sem suporte").
 */
export function estadoAtual(): EstadoPush {
  if (isIOS() && !isStandalone()) return 'ios_sem_instalacao';
  if (!suportaPush()) return 'sem_suporte';
  const permissao = typeof Notification !== 'undefined' ? Notification.permission : 'default';
  if (permissao === 'denied') return 'bloqueadas';
  if (permissao === 'granted') return 'ativas';
  return 'nao_ativadas';
}

// ──────────────────────────────────────────────────────────────────────────
// base64url <-> Uint8Array (applicationServerKey do PushManager.subscribe)
// ──────────────────────────────────────────────────────────────────────────

export function base64UrlParaUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  // `new ArrayBuffer(n)` explícito (em vez de deixar o construtor inferir):
  // TS 5.7+ tipa `Uint8Array` como genérico sobre `ArrayBufferLike`, que
  // inclui `SharedArrayBuffer` — incompatível com `BufferSource` exigido por
  // `PushSubscriptionOptionsInit.applicationServerKey`.
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

// ──────────────────────────────────────────────────────────────────────────
// Backend (contracts/motorista-push.md)
// ──────────────────────────────────────────────────────────────────────────

async function registrarInscricao(subscription: PushSubscription, keyId: string): Promise<void> {
  const json = subscription.toJSON();
  await api.put('/motorista/push/inscricao', {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
    keyId,
    plataforma: detectarPlataforma(),
    dispositivoId: obterDispositivoId(),
  });
}

/** Best-effort (FR-007) — nunca lança; um estado não reportado não impede o app. */
export async function reportarEstado(estado: EstadoPush): Promise<void> {
  try {
    await api.put('/motorista/push/estado', {
      dispositivoId: obterDispositivoId(),
      estado,
      plataforma: detectarPlataforma(),
    });
  } catch {
    // silencioso — telemetria de estado não é crítica para o motorista
  }
}

async function assinarComChaveAtual(
  registration: ServiceWorkerRegistration,
  chave: ChavePublica,
): Promise<PushSubscription> {
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlParaUint8Array(chave.chavePublica),
  });
  await registrarInscricao(subscription, chave.keyId);
  salvarKeyId(chave.keyId);
  return subscription;
}

/**
 * Só chame a partir de um gesto explícito de clique (FR-002) — nunca em
 * efeito de montagem. Pede a permissão do navegador e, se concedida, assina
 * o push e registra a inscrição no backend.
 */
export async function ativar(): Promise<ResultadoAtivacao> {
  const precheck = estadoAtual();
  if (precheck === 'ios_sem_instalacao' || precheck === 'sem_suporte') {
    // FR-004/FR-006 — nenhum pedido de permissão nesses dois estados
    return { ok: false, estado: precheck };
  }

  let permissao: NotificationPermission;
  try {
    permissao = await Notification.requestPermission();
  } catch {
    return { ok: false, estado: 'nao_ativadas', erro: 'Não foi possível pedir permissão de notificação.' };
  }
  if (permissao !== 'granted') {
    // FR-005 — negada agora vira "bloqueadas"; o navegador não deixa pedir de novo
    return { ok: false, estado: permissao === 'denied' ? 'bloqueadas' : 'nao_ativadas' };
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const chave = await api.get<ChavePublica>('/motorista/push/chave-publica');
    const existente = await registration.pushManager.getSubscription();
    if (existente) {
      // reusa a inscrição já existente do ServiceWorker em vez de gerar outra
      await registrarInscricao(existente, chave.keyId);
      salvarKeyId(chave.keyId);
    } else {
      await assinarComChaveAtual(registration, chave);
    }
    await reportarEstado('ativas');
    return { ok: true, estado: 'ativas' };
  } catch (e) {
    return { ok: false, estado: 'nao_ativadas', erro: e instanceof Error ? e.message : 'Falha ao ativar notificações.' };
  }
}

/**
 * Chamada a cada abertura autenticada (FR-008/6.3.1). Só age com permissão
 * já concedida — NUNCA pede de novo. Reconfirma a inscrição do
 * ServiceWorker e reenvia ao backend se ela mudou, sumiu, ou a chave
 * (`keyId`) foi substituída (`409 CHAVE_DESATUALIZADA`).
 */
export async function sincronizar(): Promise<void> {
  if (typeof window === 'undefined' || !suportaPush()) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

  try {
    const registration = await navigator.serviceWorker.ready;
    const chave = await api.get<ChavePublica>('/motorista/push/chave-publica');
    let subscription = await registration.pushManager.getSubscription();
    const keyIdMudou = obterKeyIdSalvo() !== chave.keyId;

    if (!subscription || keyIdMudou) {
      if (subscription && keyIdMudou) await subscription.unsubscribe().catch(() => {});
      subscription = await assinarComChaveAtual(registration, chave);
    } else {
      try {
        await registrarInscricao(subscription, chave.keyId);
      } catch (e) {
        // Corrida entre a leitura da chave acima e o PUT: o servidor já trocou
        // de chave. Reassina 1x com a chave atual e tenta de novo.
        if (e instanceof ApiError && e.status === 409) {
          await subscription.unsubscribe().catch(() => {});
          subscription = await assinarComChaveAtual(registration, chave);
        } else {
          throw e;
        }
      }
    }

    await reportarEstado('ativas');
  } catch {
    // best-effort (FR-008) — sincronização silenciosa, nunca interrompe o app
  }
}

/**
 * Revogação no logout (FR-009, 6.3.2). Best-effort no servidor — a garantia
 * real é o `unsubscribe()` local do aparelho (R7, contracts §Convenções).
 * NUNCA lança: falha do servidor (ex.: access token já vencido) não pode
 * impedir o logout.
 */
export async function revogar(): Promise<void> {
  if (typeof window === 'undefined' || !suportaPush()) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    await api
      .post('/motorista/push/inscricao/revogar', {
        endpoint: subscription.endpoint,
        dispositivoId: obterDispositivoId(),
      })
      .catch(() => {});
    await subscription.unsubscribe().catch(() => {});
  } catch {
    // best-effort — nunca bloqueia o logout
  }
}
