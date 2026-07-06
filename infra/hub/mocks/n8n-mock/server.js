// n8n-mock — mock HTTP do n8n (disparo de mensagens do envio em massa, §4.7).
// NENHUMA mensagem sai daqui: todo payload recebido é registrado em
// /data/n8n-mock.jsonl (evidência do teste de isolamento §4.11 item 15) e a
// resposta é sempre sucesso simulado. O token de produção nunca existe neste
// ambiente (env exclusivo + preflight).
'use strict';
const http = require('http');
const fs = require('fs');

const PORT = parseInt(process.env.MOCK_PORT || '8080', 10);
const LOG = '/data/n8n-mock.jsonl';

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
      return res.end(JSON.stringify({ ok: true, mock: 'n8n', app_env: process.env.APP_ENV }));
    }
    if (req.method === 'GET' && url.pathname === '/_log') {
      let lines = [];
      try { lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').slice(-50); } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('[' + lines.join(',') + ']');
    }

    log({
      ts: new Date().toISOString(),
      mock: 'n8n',
      method: req.method,
      path: url.pathname,
      payload: body,
      note: 'MENSAGEM NAO ENVIADA (mock) — registro para evidencia',
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mock: true, delivered: false }));
  });
});

server.listen(PORT, () => console.log(`[n8n-mock] listening :${PORT} APP_ENV=${process.env.APP_ENV}`));
