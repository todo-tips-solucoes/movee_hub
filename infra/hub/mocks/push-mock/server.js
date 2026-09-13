// push-mock — mock HTTPS de um serviço Web Push (FCM/Mozilla/Apple/Windows),
// tasks.md 9.1 (push-motorista). NENHUMA notificação sai daqui: todo POST
// recebido (corpo cifrado aes128gcm + cabeçalhos VAPID) é registrado em
// /data/push-mock.jsonl e a resposta HTTP é a que foi PROGRAMADA para aquele
// path via /_programar — sem programação, responde 201 (sucesso padrão do
// protocolo Web Push, RFC 8030 §5).
//
// HTTPS (não HTTP, diferente dos demais mocks) porque `web-push` só fala
// https.request; o certificado autoassinado é gerado pelo DRIVER de teste via
// openssl (fora deste arquivo) e passado por MOCK_TLS_CERT_FILE/
// MOCK_TLS_KEY_FILE (research.md Decision 21).
//
// Decifrar o corpo (Scenario 11 do quickstart, "corpo decifrado que o
// push-mock registra") é responsabilidade de quem lê o log (o mock de teste
// conhece a chave privada da inscrição que ele mesmo gerou) — fora do escopo
// de 9.1.1, que só cobre HTTPS + status programável + log JSONL.
'use strict';
const https = require('https');
const fs = require('fs');

const PORT = parseInt(process.env.MOCK_PORT || '8443', 10);
const LOG = '/data/push-mock.jsonl';
const CERT_FILE = process.env.MOCK_TLS_CERT_FILE;
const KEY_FILE = process.env.MOCK_TLS_KEY_FILE;

if (!CERT_FILE || !KEY_FILE) {
  console.error('push-mock: MOCK_TLS_CERT_FILE e MOCK_TLS_KEY_FILE são obrigatórios');
  process.exit(1);
}

// path -> fila de respostas programadas (FIFO; a última é repetida depois de
// esgotada, então um array de 1 elemento vale "sempre este status"). Valor
// pode ser um inteiro (status HTTP) ou a string 'ECONNRESET' (simula "erro
// local sem statusCode": destrói a conexão sem responder, 9.1.1).
const programado = new Map();

function log(entry) {
  try {
    fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('log write failed:', e.message);
  }
}

function proximaResposta(path) {
  const fila = programado.get(path);
  if (!fila || fila.length === 0) return 201; // default: sucesso (RFC 8030 §5)
  return fila.length > 1 ? fila.shift() : fila[0];
}

const server = https.createServer(
  {
    cert: fs.readFileSync(CERT_FILE),
    key: fs.readFileSync(KEY_FILE),
  },
  (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url, 'https://localhost');

      if (req.method === 'GET' && url.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, mock: 'push' }));
      }

      if (req.method === 'GET' && url.pathname === '/_log') {
        let lines = [];
        try {
          lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean);
        } catch {
          /* sem log ainda */
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('[' + lines.join(',') + ']');
      }

      // Controle de teste: programa a(s) próxima(s) resposta(s) para um path.
      // Body: { "path": "/e/1", "respostas": [500, 500, 201] } ou
      //       { "path": "/e/2", "respostas": [410] } (sempre 410) ou
      //       { "path": "/e/3", "respostas": ["ECONNRESET"] }
      if (req.method === 'POST' && url.pathname === '/_programar') {
        let body;
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, erro: 'body inválido' }));
        }
        if (!body || typeof body.path !== 'string' || !Array.isArray(body.respostas)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, erro: 'path/respostas obrigatórios' }));
        }
        programado.set(body.path, [...body.respostas]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }

      if (req.method === 'POST' && url.pathname === '/_reset') {
        programado.clear();
        try {
          fs.writeFileSync(LOG, '');
        } catch {
          /* sem log ainda */
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }

      // Envio real (chamado pelo hub-push-worker.js via web-push): registra o
      // POST cifrado e responde conforme programado para este path.
      const status = proximaResposta(url.pathname);

      log({
        ts: new Date().toISOString(),
        mock: 'push',
        method: req.method,
        path: url.pathname,
        headers: {
          authorization: req.headers['authorization'] || null,
          'content-encoding': req.headers['content-encoding'] || null,
          'crypto-key': req.headers['crypto-key'] || null,
          ttl: req.headers['ttl'] || null,
          urgency: req.headers['urgency'] || null,
        },
        body_cifrado_base64: raw.length > 0 ? raw.toString('base64') : null,
        status_respondido: status,
      });

      if (status === 'ECONNRESET') {
        return req.socket.destroy();
      }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: status < 300, mock: true }));
    });
  }
);

server.listen(PORT, () => console.log(`[push-mock] listening :${PORT} (HTTPS)`));
