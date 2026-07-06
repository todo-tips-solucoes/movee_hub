// fastapi-mock — stub da FastAPI de validação NFS-e (§4.7).
// Nenhuma consulta real é feita. Respostas canônicas para exercitar o
// tratamento negócio-vs-infra do backend:
//   - valida         → 200 {nota_ok: "...", erro_validacao: ""}
//   - invalida       → 200 {nota_ok: "", erro_validacao: "<motivo>"}
//   - erro_negocio   → 400 {detail: "<mensagem de negócio real>"}
//   - timeout        → segura a resposta por 70s (simula infra indisponível)
// Cenário escolhido pelo header X-Mock-Scenario, campo mock_scenario do body,
// ou query ?scenario=. Default: valida.
// Todos os requests são registrados em /data/fastapi-mock.jsonl (evidência).
'use strict';
const http = require('http');
const fs = require('fs');

const PORT = parseInt(process.env.MOCK_PORT || '8080', 10);
const LOG = '/data/fastapi-mock.jsonl';

function log(entry) {
  try {
    fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('log write failed:', e.message);
  }
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = { _raw: raw.slice(0, 500) }; }

    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, mock: 'fastapi', app_env: process.env.APP_ENV }));
    }
    if (req.method === 'GET' && url.pathname === '/_log') {
      let lines = [];
      try { lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').slice(-50); } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('[' + lines.join(',') + ']');
    }

    const scenario =
      req.headers['x-mock-scenario'] ||
      (body && body.mock_scenario) ||
      url.searchParams.get('scenario') ||
      'valida';

    log({
      ts: new Date().toISOString(),
      mock: 'fastapi',
      method: req.method,
      path: url.pathname,
      scenario,
      body_keys: body && typeof body === 'object' ? Object.keys(body) : null,
    });

    if (scenario === 'timeout') {
      // Segura 70s sem responder — o cliente deve estourar timeout (infra)
      setTimeout(() => { try { res.destroy(); } catch {} }, 70000);
      return;
    }
    if (scenario === 'erro_negocio') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        detail: 'Nenhum motorista ativo encontrado para o CNPJ do prestador',
      }));
    }
    if (scenario === 'invalida') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        nota_ok: '',
        erro_validacao: 'Nota fiscal invalida: valor divergente do movimento',
        mock: true,
      }));
    }
    // default: valida
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      nota_ok: new Date().toISOString().slice(0, 10),
      erro_validacao: '',
      mock: true,
    }));
  });
});

server.listen(PORT, () => console.log(`[fastapi-mock] listening :${PORT} APP_ENV=${process.env.APP_ENV}`));
