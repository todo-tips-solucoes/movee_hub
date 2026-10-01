// App instalável (Android/Chrome): prova no navegador o que o teste unitário
// `app/manifest.test.ts` não alcança — que o Next SERVE o manifest na rota, que
// o `<link rel="manifest">` chega no HTML, que os ícones respondem 200 e que o
// service worker registra de verdade. Sem estes quatro, o Chrome responde
// "Não é possível instalar o app" sem dizer qual faltou.
//
// Roda na tela pública `/hub/login` (sem storageState): a instalabilidade não
// depende de sessão, e assim o spec não gasta login.
import { test, expect, chromium } from '@playwright/test';


test.describe('app instalável — manifest e service worker', () => {
  test('/hub/login declara o manifest e o Next o serve com os campos exigidos', async ({ page, request }) => {
    await page.goto('/hub/login');

    const href = await page.locator('link[rel="manifest"]').first().getAttribute('href');
    expect(href, '<link rel="manifest"> ausente no HTML').toBeTruthy();

    const resp = await request.get(href!);
    expect(resp.status()).toBe(200);

    const m = await resp.json();
    expect(m.name).toMatch(/EntreGô/);
    expect(m.short_name).toBeTruthy();
    expect(m.start_url).toBe('/hub');
    expect(m.display).toBe('standalone');

    const tamanhos = (m.icons ?? []).map((i: { sizes: string }) => i.sizes);
    expect(tamanhos).toContain('192x192');
    expect(tamanhos).toContain('512x512');

    // o erro clássico: manifest válido apontando ícone que não responde
    for (const icone of m.icons ?? []) {
      const r = await request.get(icone.src);
      expect(r.status(), `ícone não responde: ${icone.src}`).toBe(200);
      expect(r.headers()['content-type']).toContain('image/png');
    }
  });

  // ⚠️ Este teste lança o PRÓPRIO browser, com `--ignore-certificate-errors`.
  //
  // Dois motivos, os dois medidos nesta entrega:
  //  1. o hub-homolog serve TLS self-signed, e o Chrome recusa registrar um SW
  //     cujo script veio de origem com certificado inválido — `ignoreHTTPSErrors`
  //     cobre a navegação, não o fetch do script ("An SSL certificate error
  //     occurred when fetching the script"). Em produção o certificado é válido
  //     (Let's Encrypt via Traefik) e nada disso se aplica;
  //  2. passar a flag por `test.use({ launchOptions })` seria pior: é opção
  //     worker-scoped, o Playwright reinicia o browser do worker e isso DERRUBOU
  //     um spec de outro arquivo (`impeccable-rodada19` morreu com "Target page,
  //     context or browser has been closed"). Browser próprio não contamina ninguém.
  test('o service worker registra e fica ativo', async ({ baseURL }) => {
    const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
    try {
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      await page.goto(`${baseURL}/hub/login`);
      const estado = await page.evaluate(async () => {
        try {
          const reg = await navigator.serviceWorker.register('/sw.js');
          await navigator.serviceWorker.ready;
          return reg.active ? 'ativo' : 'registrado sem ativar';
        } catch (e) {
          return 'ERRO: ' + (e as Error).message;
        }
      });
      expect(estado).toBe('ativo');
    } finally {
      await browser.close();
    }
  });

  test('o service worker não cacheia o bundle (deploy novo sempre chega)', async ({ page, request }) => {
    const sw = await request.get('/sw.js');
    expect(sw.status()).toBe(200);
    const codigo = await sw.text();
    expect(codigo).not.toMatch(/caches\.(open|match)/);
    expect(codigo).toMatch(/addEventListener\('fetch'/);

    // e a navegação continua vindo da rede, com o HTML do app (não do SW)
    await page.goto('/hub/login');
    await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
  });
});
