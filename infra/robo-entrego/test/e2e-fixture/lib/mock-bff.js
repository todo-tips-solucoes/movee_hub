// mock-bff.js (tasks.md 6.3.1) — helpers de rota Playwright para a suíte de
// fixture/mock do portal EntreGô (test/e2e-fixture/scenarios.test.js).
//
// Reflete CORS (Origin + Access-Control-Request-Headers) porque as chamadas
// reais em src/entrego-portal.js usam `fetch(..., {credentials:'include'})`
// de DENTRO do browser via `page.evaluate` — e no caminho feliz (sessão já
// válida) a página NUNCA navega antes dessas chamadas (fica em about:blank,
// origem opaca/nula). Headers customizados (`X-IFood-Logistics-Auth` etc.)
// disparam preflight OPTIONS. Sem refletir a origem exata do pedido, o
// fetch falha por CORS antes mesmo de chegar no mock — confirmado
// empiricamente (2 probes fora do repo, 2026-08-28) rodando
// `sondarSessaoValida`/`buscarUrlsRelatorio` REAIS (não reimplementadas)
// contra este mesmo padrão de resposta.
'use strict';

function headersCors(route, extra = {}) {
  const req = route.request();
  const origin = req.headers()['origin'] || 'null';
  const reqHeaders = req.headers()['access-control-request-headers'];
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    ...(reqHeaders ? { 'access-control-allow-headers': reqHeaders } : {}),
    ...extra,
  };
}

async function fulfillJson(route, status, corpo) {
  return route.fulfill({ status, contentType: 'application/json', headers: headersCors(route), body: JSON.stringify(corpo) });
}

/**
 * Registra o mock do BFF (`https://api.entregolog.com/logistics-web-bff/**`) numa `page` Playwright real.
 * @param {import('playwright').Page} page
 * @param {object} [opts]
 * @param {number} [opts.sondaStatus] status de `GET .../authentication/me` (200 válida, 401 expirada)
 * @param {(route, url: URL) => Promise<void>} [opts.urlsHandler] override de `GET .../reports/:tipo/urls`
 */
async function mockBff(page, { sondaStatus = 200, urlsHandler } = {}) {
  await page.route('https://api.entregolog.com/logistics-web-bff/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: headersCors(route) });
    }
    const url = new URL(req.url());
    if (url.pathname.endsWith('/operation/users/authentication/me')) {
      return fulfillJson(route, sondaStatus, {});
    }
    if (url.pathname.includes('/operation/logistics-operator/reports/') && url.pathname.endsWith('/urls')) {
      if (urlsHandler) return urlsHandler(route, url);
      return fulfillJson(route, 200, [{ url: 'https://s3.amazonaws.com/fixture-bucket/relatorio.csv', date: '2026-08-27' }]);
    }
    return fulfillJson(route, 404, { erro: `rota nao mockada: ${url.pathname}` });
  });
}

/** Registra o mock da página de login (`https://franqueado.entregolog.com/**`) devolvendo o HTML da fixture. */
async function mockLoginPage(page, html) {
  await page.route('https://franqueado.entregolog.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
}

module.exports = { headersCors, fulfillJson, mockBff, mockLoginPage };
