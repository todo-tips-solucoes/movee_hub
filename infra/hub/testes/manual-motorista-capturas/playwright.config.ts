import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: /capturar\.spec\.ts/,
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
});
