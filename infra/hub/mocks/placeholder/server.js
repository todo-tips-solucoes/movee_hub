// placeholder — página estática servida pelo Traefik do hub enquanto o
// frontend do hub não existe (S2+). Exibe a identificação visual de ambiente
// (§13.2 / teste de isolamento §4.11 item 18 — versão S1, pré-app).
'use strict';
const http = require('http');

const PORT = parseInt(process.env.MOCK_PORT || '8080', 10);
const ENV_PT = {
  development: 'DESENVOLVIMENTO',
  test: 'TESTE',
  homologation: 'HOMOLOGAÇÃO',
  production: 'PRODUÇÃO',
};
const ENV = ENV_PT[process.env.APP_ENV] || (process.env.APP_ENV || 'DESCONHECIDO').toUpperCase();

const PAGE = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Hub de Frota — AMBIENTE DE ${ENV}</title>
<style>
  body { margin:0; font-family: system-ui, sans-serif; background:#0f172a; color:#e2e8f0;
         display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:100vh; }
  .banner { background:#f59e0b; color:#111; font-weight:700; padding:.75rem 1.5rem;
            width:100%; text-align:center; box-sizing:border-box; letter-spacing:.05em; }
  main { text-align:center; padding:2rem; }
  h1 { font-size:1.5rem; }
  p { color:#94a3b8; max-width:34rem; }
  code { background:#1e293b; padding:.15rem .4rem; border-radius:4px; }
</style>
</head>
<body>
  <div class="banner">⚠ AMBIENTE DE ${ENV} — HUB DE FROTA — DADOS SINTÉTICOS/ANONIMIZADOS — NÃO É PRODUÇÃO</div>
  <main>
    <h1>Hub de Gestão de Frota</h1>
    <p>Ambiente isolado (S1). O aplicativo do hub será servido aqui a partir da fase S2.
       Nenhuma integração real está conectada: FastAPI e n8n são <code>mocks</code>.</p>
  </main>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, app_env: process.env.APP_ENV }));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-App-Env': process.env.APP_ENV || '' });
  res.end(PAGE);
});

server.listen(PORT, () => console.log(`[placeholder] listening :${PORT} APP_ENV=${process.env.APP_ENV}`));
