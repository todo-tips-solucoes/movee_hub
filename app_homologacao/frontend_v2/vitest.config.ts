// hub-shell (S3) — configuração mínima do vitest, introduzida na task 1.3.4
// (dec-032): frontend_v2 não tinha nenhum test runner. Escopo confinado a
// devDependencies + este arquivo; não afeta `next build`/`next dev`/produção.
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['node_modules', '.next'],
    setupFiles: ['./vitest.setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
