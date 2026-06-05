import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';
import withSerwistInit from '@serwist/next';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
};

// Serwist (PWA) — habilitado em produção; no-op em dev para evitar interferência no HMR.
// Para ativar em dev também: remova a guarda `phase !== PHASE_DEVELOPMENT_SERVER`.
export default (phase) => {
  if (phase === PHASE_DEVELOPMENT_SERVER) {
    return nextConfig;
  }

  const withSerwist = withSerwistInit({
    swSrc: 'app/sw.ts',
    swDest: 'public/sw.js',
    // Revalidação do app shell a cada 7 dias
    cacheOnNavigation: true,
    reloadOnOnline: true,
  });

  return withSerwist(nextConfig);
};
