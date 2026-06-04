import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
import { CacheFirst, NetworkFirst, StaleWhileRevalidate, Serwist } from 'serwist';

// Necessário para TypeScript reconhecer as variáveis de compilação do @serwist/next
declare global {
  interface ServiceWorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
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
      // Rotas da API do motorista: NetworkFirst (dados sempre frescos, fallback 5min)
      matcher: /\/api\/motorista\/.*/i,
      handler: new NetworkFirst({
        cacheName: 'motorista-api-cache',
        networkTimeoutSeconds: 10,
      }),
    },
  ],
});

serwist.addEventListeners();
