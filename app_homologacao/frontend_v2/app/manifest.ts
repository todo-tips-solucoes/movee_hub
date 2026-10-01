import type { MetadataRoute } from 'next';

/**
 * Manifest do app instalável (Chrome Android exige manifest + service worker
 * com fetch handler; o `public/sw.js` é a outra metade).
 *
 * Marca: EntreGô, porque é o que o produto JÁ mostra na tela — o `Wordmark`
 * no login e no header do hub, a aba ("EntreGô — Envio em Massa") e o manifest
 * do app motorista ("EntreGô — App Motorista"). "Movee" vive no domínio e nos
 * e-mails; usá-la aqui criaria um terceiro vocabulário na tela inicial do
 * celular (CLAUDE.md §Propor UI nova).
 *
 * `start_url` é `/hub`, que redireciona para `/hub/dashboard` e deixa a guarda
 * de sessão do layout mandar para o login quando não há sessão — assim o app
 * instalado nunca abre numa tela morta.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'EntreGô — Hub de Frota',
    short_name: 'Hub',
    description: 'Gestão de frota: motoristas, faturamento, performance e adiantamentos.',
    start_url: '/hub',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    lang: 'pt-BR',
    background_color: '#ffffff',
    theme_color: '#0f172a',
    icons: [
      { src: '/brand/go-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/brand/go-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/brand/go-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
