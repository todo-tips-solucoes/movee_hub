// mailpit-like — mock de envio de e-mail para recuperação de senha (§Decision 11
// research.md hub-fundacoes). Nenhum e-mail real sai do ambiente hub-* (isolamento
// S1). O backend do hub chama este mock via MAIL_MOCK_URL (mesmo padrão de
// FASTAPI_URL/N8N_URL) em vez de um provedor SMTP real.
//
// Contrato mínimo esperado pelo backend (routes/hub-auth.js, FASE 3):
//   POST /send  { to, subject, text }  -> 202 { ok: true, id }
// Todo envio "recebido" fica disponível para inspeção em teste via:
//   GET /_log            -> últimos 50 envios (jsonl)
//   GET /_log?to=<email> -> filtra por destinatário (usado pelos testes de
//                           recuperação de senha para extrair o token enviado)
'use strict';
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const PORT = parseInt(process.env.MOCK_PORT || '8080', 10);
const LOG = '/data/mailpit-like.jsonl';

function log(entry) {
  try {
    fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('log write failed:', e.message);
  }
}

function readLog() {
  try {
    return fs
      .readFileSync(LOG, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = { _raw: raw.slice(0, 2000) };
    }

    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, mock: 'mailpit-like', app_env: process.env.APP_ENV }));
    }

    if (req.method === 'GET' && url.pathname === '/_log') {
      const to = url.searchParams.get('to');
      let entries = readLog();
      if (to) entries = entries.filter((e) => e.to === to);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(entries.slice(-50)));
    }

    if (req.method === 'POST' && (url.pathname === '/send' || url.pathname === '/')) {
      const id = crypto.randomUUID();
      const entry = {
        ts: new Date().toISOString(),
        mock: 'mailpit-like',
        id,
        to: body && body.to,
        subject: body && body.subject,
        text: body && body.text,
      };
      log(entry);
      res.writeHead(202, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, id }));
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
});

server.listen(PORT, () => console.log(`[mailpit-like] listening :${PORT} APP_ENV=${process.env.APP_ENV}`));
