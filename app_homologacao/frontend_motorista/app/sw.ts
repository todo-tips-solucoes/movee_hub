import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
import { CacheFirst, NetworkOnly, StaleWhileRevalidate, Serwist } from 'serwist';

// Necessário para TypeScript reconhecer as variáveis de compilação do @serwist/next.
//
// push-motorista (tasks.md 6.4) — este projeto usa `lib: ["dom", ...]` (sem
// "webworker", que conflitaria com "dom" no MESMO tsconfig usado pelo
// restante do app). Por isso `ExtendableEvent`/`PushEvent`/`NotificationEvent`/
// `Clients`/`WindowClient` — que só existem em lib.webworker.d.ts — são
// declarados aqui manualmente, o mínimo necessário para os handlers abaixo
// (mesma técnica já usada pelo `SW_MANIFEST` original, só que estendida).
interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface PushMessageData {
  json(): unknown;
}
interface PushEvent extends ExtendableEvent {
  readonly data: PushMessageData | null;
}
interface NotificationEvent extends ExtendableEvent {
  readonly notification: Notification;
  readonly action: string;
}
interface WindowClient {
  readonly url: string;
  readonly focused: boolean;
  focus(): Promise<WindowClient>;
  navigate(url: string): Promise<WindowClient | null>;
}
interface Clients {
  matchAll(options?: { type?: string; includeUncontrolled?: boolean }): Promise<WindowClient[]>;
  openWindow(url: string): Promise<WindowClient | null>;
}

declare global {
  interface ServiceWorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
    readonly registration: ServiceWorkerRegistration;
    readonly clients: Clients;
    addEventListener(type: 'push', listener: (event: PushEvent) => void): void;
    addEventListener(type: 'notificationclick', listener: (event: NotificationEvent) => void): void;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  // Precache do app shell (gerado em build pelo @serwist/next)
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: false,
  runtimeCaching: [
    {
      matcher: /^https:\/\/fonts\.googleapis\.com\/.*/i,
      handler: new CacheFirst({
        cacheName: 'google-fonts-cache',
        plugins: [],
      }),
    },
    {
      matcher: /\.(?:jpg|jpeg|gif|png|svg|ico|webp)$/i,
      handler: new StaleWhileRevalidate({
        cacheName: 'static-images-cache',
      }),
    },
    {
      // push-motorista (tasks.md 6.4.3, contracts/motorista-push.md §Service
      // worker) — inscrição/estado/aviso nunca podem servir de cache (o app
      // depende de 409 CHAVE_DESATUALIZADA e do conteúdo fresco do aviso).
      // Regra MAIS específica, então DEVE vir antes da regra genérica abaixo
      // (a primeira `matcher` que casar vence, sw.ts:33-40 original).
      matcher: /\/api\/motorista\/(avisos|push)\/.*/i,
      handler: new NetworkOnly(),
    },
    {
      // Revisão de segurança 2026-09-18: era `NetworkFirst` com o cache
      // `motorista-api-cache`. Com a feature de adiantamento, essas rotas
      // passaram a devolver conta bancária, valores e histórico — que ficavam
      // gravados no aparelho e eram servidos offline mesmo depois do logout
      // (o `logout` não apagava a Cache Storage, e o próprio handler desiste
      // da rede em 10 s). `Cache-Control: no-store` NÃO resolveria: o cache do
      // service worker filtra por status HTTP, não pelo cabeçalho.
      // Nenhuma tela do app funciona offline (todas são 'use client' e buscam
      // no `useEffect`), então `NetworkOnly` não tira comportamento nenhum.
      matcher: /\/api\/motorista\/.*/i,
      handler: new NetworkOnly(),
    },
  ],
});

serwist.addEventListeners();

// ──────────────────────────────────────────────────────────────────────────
// push-motorista (tasks.md 6.4.1/6.4.2, contracts/motorista-push.md §Service
// worker) — payload em claro é `{ avisoId, titulo, corpo }` (<=1024 bytes,
// sem PII, FR-012). Payload inválido é descartado SEM notificar.
// ──────────────────────────────────────────────────────────────────────────

interface PayloadAviso {
  avisoId: number;
  titulo: string;
  corpo: string;
}

function parsePayloadAviso(event: PushEvent): PayloadAviso | null {
  if (!event.data) return null;
  let json: unknown;
  try {
    json = event.data.json();
  } catch {
    return null;
  }
  if (
    !json ||
    typeof json !== 'object' ||
    typeof (json as PayloadAviso).avisoId !== 'number' ||
    typeof (json as PayloadAviso).titulo !== 'string' ||
    typeof (json as PayloadAviso).corpo !== 'string'
  ) {
    return null;
  }
  return json as PayloadAviso;
}

self.addEventListener('push', (event: PushEvent) => {
  const payload = parsePayloadAviso(event);
  if (!payload) return; // payload inválido -> descartado sem notificação

  event.waitUntil(
    self.registration.showNotification(payload.titulo, {
      body: payload.corpo,
      tag: `aviso-${payload.avisoId}`,
      icon: '/icons/icon-192x192.png',
      data: { url: `/avisos/${payload.avisoId}` },
    }),
  );
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string } | undefined)?.url || '/movimento';

  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existente = clientsList.find((c) => 'focus' in c) as WindowClient | undefined;
      if (existente) {
        await existente.focus();
        if ('navigate' in existente) await existente.navigate(url);
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
