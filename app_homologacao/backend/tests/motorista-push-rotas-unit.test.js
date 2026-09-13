/**
 * Testes unitários — routes/motorista-push.js (push-motorista, tasks.md
 * FASE 3, 3.1.4). Rodam com: node --test tests/motorista-push-rotas-unit.test.js
 *
 * Mesma técnica de tests/hub-robo-entrego-unit.test.js: express real +
 * node:http + app.listen(0), mockando `../lib/hub-postgrest` (sem PostgREST
 * real) e `../lib/hub-push-vapid` (controla getKeyAtual sem depender de
 * arquivo em disco) via Module._load. `authenticateMotorista` NÃO faz parte
 * deste router (é aplicado pelo server.js na montagem) — o app de teste
 * simula esse contrato com um middleware simples que seta `req.motorista`
 * a partir de um header de teste, mesma identidade que o middleware real
 * extrairia do token.
 *
 * Cobre (3.1.4): as 5 rotas, identidade do corpo ignorada (FR-003), rate
 * limit 30/15min por cnpjPrestador (429 na 31ª — FR-027), 503 sem chave
 * VAPID válida, 409 com keyId divergente.
 *
 * Ref: contracts/motorista-push.md, tasks.md 3.1.
 */

'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// ──────────────────────────────────────────────────────────────────────────
// Mocks via Module._load (mesma técnica de tests/hub-robo-entrego-unit.test.js)
// ──────────────────────────────────────────────────────────────────────────
let chamadasPostgrest = [];
let comportamentoPostgrest = async () => null;
let vapidDisponivel = true;
let vapidChaveAtual = { chavePublica: 'CHAVE-PUBLICA-DE-TESTE', keyId: 'keyid-ativo' };

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../lib/hub-postgrest') {
    return {
      hubPostgrestRequest: async (endpoint, method, body, claims, opts) => {
        chamadasPostgrest.push({ endpoint, method, body, claims, opts });
        return comportamentoPostgrest(endpoint, method, body, claims, opts);
      },
    };
  }
  if (request === '../lib/hub-push-vapid') {
    return {
      getKeyAtual: () => {
        if (!vapidDisponivel) throw new Error('PUSH_INDISPONIVEL');
        return vapidChaveAtual;
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

const express = require('express');
const { router } = require('../routes/motorista-push.js');

Module._load = originalLoad;

const app = express();
app.use(express.json());
// Simula authenticateMotorista: identidade só via header de teste, nunca do corpo.
app.use((req, res, next) => {
  req.motorista = { cnpjPrestador: req.headers['x-test-cnpj'] || '11111111000191' };
  next();
});
app.use('/motorista', router);

let server;
let baseUrl;

function request(method, path, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const h = Object.assign({}, headers);
    if (bodyStr) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method, headers: h },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let json;
          try {
            json = data ? JSON.parse(data) : null;
          } catch (_) {
            json = data;
          }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function b64url(buf) {
  return buf.toString('base64url');
}

const P256DH_VALIDO = b64url(Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 1)]));
const AUTH_VALIDO = b64url(Buffer.alloc(16, 2));
const ENDPOINT_VALIDO = 'https://fcm.googleapis.com/fcm/send/abc123';
const DISPOSITIVO_VALIDO = '11111111-1111-4111-8111-111111111111';

function inscricaoValida(overrides) {
  return Object.assign(
    {
      endpoint: ENDPOINT_VALIDO,
      keys: { p256dh: P256DH_VALIDO, auth: AUTH_VALIDO },
      keyId: 'keyid-ativo',
      plataforma: 'android',
      dispositivoId: DISPOSITIVO_VALIDO,
    },
    overrides
  );
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  chamadasPostgrest = [];
  comportamentoPostgrest = async () => null;
  vapidDisponivel = true;
  vapidChaveAtual = { chavePublica: 'CHAVE-PUBLICA-DE-TESTE', keyId: 'keyid-ativo' };
});

describe('GET /motorista/push/chave-publica', () => {
  test('chave carregada -> 200 com chavePublica e keyId', async () => {
    const r = await request('GET', '/motorista/push/chave-publica', {
      headers: { 'x-test-cnpj': 'cnpj-chave-ok' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.chavePublica, 'CHAVE-PUBLICA-DE-TESTE');
    assert.equal(r.body.keyId, 'keyid-ativo');
  });

  test('sem chave VAPID válida -> 503 PUSH_INDISPONIVEL', async () => {
    vapidDisponivel = false;
    const r = await request('GET', '/motorista/push/chave-publica', {
      headers: { 'x-test-cnpj': 'cnpj-chave-indisponivel' },
    });
    assert.equal(r.status, 503);
    assert.equal(r.body.erro, 'PUSH_INDISPONIVEL');
  });
});

describe('PUT /motorista/push/inscricao', () => {
  test('corpo válido -> 204, claim motorista_cnpj vem do token (não do corpo)', async () => {
    const r = await request('PUT', '/motorista/push/inscricao', {
      headers: { 'x-test-cnpj': '22222222000199' },
      body: inscricaoValida({ cnpjPrestador: '00000000000000', empresa: 999 }),
    });
    assert.equal(r.status, 204);
    assert.equal(chamadasPostgrest.length, 1);
    assert.equal(chamadasPostgrest[0].endpoint, 'rpc/hub_push_inscricao_registrar');
    assert.equal(chamadasPostgrest[0].claims.motoristaCnpj, '22222222000199');
    assert.equal(chamadasPostgrest[0].body.p_dispositivo_id, DISPOSITIVO_VALIDO);
  });

  test('endpoint inválido -> 400 DADOS_INVALIDOS motivo=endpoint', async () => {
    const r = await request('PUT', '/motorista/push/inscricao', {
      headers: { 'x-test-cnpj': 'cnpj-a' },
      body: inscricaoValida({ endpoint: 'http://fcm.googleapis.com/x' }),
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.erro, 'DADOS_INVALIDOS');
    assert.equal(r.body.motivo, 'endpoint');
  });

  test('p256dh malformado -> 400 DADOS_INVALIDOS motivo=p256dh', async () => {
    const r = await request('PUT', '/motorista/push/inscricao', {
      headers: { 'x-test-cnpj': 'cnpj-b' },
      body: inscricaoValida({ keys: { p256dh: 'curto', auth: AUTH_VALIDO } }),
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.motivo, 'p256dh');
  });

  test('auth malformado -> 400 DADOS_INVALIDOS motivo=auth', async () => {
    const r = await request('PUT', '/motorista/push/inscricao', {
      headers: { 'x-test-cnpj': 'cnpj-c' },
      body: inscricaoValida({ keys: { p256dh: P256DH_VALIDO, auth: 'curto' } }),
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.motivo, 'auth');
  });

  test('host fora da allowlist -> 400 ENDPOINT_NAO_PERMITIDO', async () => {
    const r = await request('PUT', '/motorista/push/inscricao', {
      headers: { 'x-test-cnpj': 'cnpj-d' },
      body: inscricaoValida({ endpoint: 'https://evil-push.example.com/x' }),
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.erro, 'ENDPOINT_NAO_PERMITIDO');
  });

  test('keyId ausente -> 400 DADOS_INVALIDOS motivo=keyId', async () => {
    const r = await request('PUT', '/motorista/push/inscricao', {
      headers: { 'x-test-cnpj': 'cnpj-e' },
      body: inscricaoValida({ keyId: undefined }),
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.motivo, 'keyId');
  });

  test('plataforma inválida -> 400 DADOS_INVALIDOS motivo=plataforma', async () => {
    const r = await request('PUT', '/motorista/push/inscricao', {
      headers: { 'x-test-cnpj': 'cnpj-f' },
      body: inscricaoValida({ plataforma: 'windows-phone' }),
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.motivo, 'plataforma');
  });

  test('dispositivoId inválido -> 400 DADOS_INVALIDOS motivo=dispositivoId', async () => {
    const r = await request('PUT', '/motorista/push/inscricao', {
      headers: { 'x-test-cnpj': 'cnpj-g' },
      body: inscricaoValida({ dispositivoId: 'nao-e-uuid' }),
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.motivo, 'dispositivoId');
  });

  test('keyId divergente do ativo -> 409 CHAVE_DESATUALIZADA', async () => {
    const r = await request('PUT', '/motorista/push/inscricao', {
      headers: { 'x-test-cnpj': 'cnpj-h' },
      body: inscricaoValida({ keyId: 'keyid-antigo' }),
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.erro, 'CHAVE_DESATUALIZADA');
  });

  test('sem chave VAPID válida -> 503 PUSH_INDISPONIVEL (nem chega a validar o corpo)', async () => {
    vapidDisponivel = false;
    const r = await request('PUT', '/motorista/push/inscricao', {
      headers: { 'x-test-cnpj': 'cnpj-i' },
      body: inscricaoValida(),
    });
    assert.equal(r.status, 503);
    assert.equal(r.body.erro, 'PUSH_INDISPONIVEL');
    assert.equal(chamadasPostgrest.length, 0);
  });

  test('falha do PostgREST -> 502 INDISPONIVEL', async () => {
    comportamentoPostgrest = async () => {
      throw new Error('hub-postgrest: 500 Internal Server Error — boom');
    };
    const r = await request('PUT', '/motorista/push/inscricao', {
      headers: { 'x-test-cnpj': 'cnpj-j' },
      body: inscricaoValida(),
    });
    assert.equal(r.status, 502);
    assert.equal(r.body.erro, 'INDISPONIVEL');
  });
});

describe('POST /motorista/push/inscricao/revogar', () => {
  test('corpo válido -> 204, identidade vem do token', async () => {
    const r = await request('POST', '/motorista/push/inscricao/revogar', {
      headers: { 'x-test-cnpj': 'cnpj-k' },
      body: { endpoint: ENDPOINT_VALIDO, dispositivoId: DISPOSITIVO_VALIDO, cnpj: '99999999999999' },
    });
    assert.equal(r.status, 204);
    assert.equal(chamadasPostgrest[0].endpoint, 'rpc/hub_push_inscricao_revogar');
    assert.equal(chamadasPostgrest[0].claims.motoristaCnpj, 'cnpj-k');
  });

  test('endpoint inválido -> 400 DADOS_INVALIDOS motivo=endpoint', async () => {
    const r = await request('POST', '/motorista/push/inscricao/revogar', {
      headers: { 'x-test-cnpj': 'cnpj-l' },
      body: { endpoint: 'ftp://x', dispositivoId: DISPOSITIVO_VALIDO },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.motivo, 'endpoint');
  });

  test('dispositivoId inválido -> 400 DADOS_INVALIDOS motivo=dispositivoId', async () => {
    const r = await request('POST', '/motorista/push/inscricao/revogar', {
      headers: { 'x-test-cnpj': 'cnpj-m' },
      body: { endpoint: ENDPOINT_VALIDO, dispositivoId: 'xyz' },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.motivo, 'dispositivoId');
  });
});

describe('PUT /motorista/push/estado', () => {
  test('corpo válido -> 204', async () => {
    const r = await request('PUT', '/motorista/push/estado', {
      headers: { 'x-test-cnpj': 'cnpj-n' },
      body: { dispositivoId: DISPOSITIVO_VALIDO, estado: 'ativas', plataforma: 'ios' },
    });
    assert.equal(r.status, 204);
    assert.equal(chamadasPostgrest[0].endpoint, 'rpc/hub_push_estado_reportar');
  });

  test('estado inválido -> 400 DADOS_INVALIDOS motivo=estado', async () => {
    const r = await request('PUT', '/motorista/push/estado', {
      headers: { 'x-test-cnpj': 'cnpj-o' },
      body: { dispositivoId: DISPOSITIVO_VALIDO, estado: 'desligado', plataforma: 'ios' },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.motivo, 'estado');
  });

  test('plataforma inválida -> 400 DADOS_INVALIDOS motivo=plataforma', async () => {
    const r = await request('PUT', '/motorista/push/estado', {
      headers: { 'x-test-cnpj': 'cnpj-p' },
      body: { dispositivoId: DISPOSITIVO_VALIDO, estado: 'ativas', plataforma: 'symbian' },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.motivo, 'plataforma');
  });

  test('dispositivoId inválido -> 400 DADOS_INVALIDOS motivo=dispositivoId', async () => {
    const r = await request('PUT', '/motorista/push/estado', {
      headers: { 'x-test-cnpj': 'cnpj-q' },
      body: { dispositivoId: 'xyz', estado: 'ativas', plataforma: 'ios' },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.motivo, 'dispositivoId');
  });
});

describe('GET /motorista/avisos/:id', () => {
  test('destinatário do aviso -> 200 com id/titulo/corpo/enviadoEm', async () => {
    comportamentoPostgrest = async () => [
      { id: 123, titulo: 'Texto da equipe', corpo: 'Mensagem curta', criado_em: '2026-09-11T12:00:00Z' },
    ];
    const r = await request('GET', '/motorista/avisos/123', {
      headers: { 'x-test-cnpj': 'cnpj-r' },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      id: 123,
      titulo: 'Texto da equipe',
      corpo: 'Mensagem curta',
      enviadoEm: '2026-09-11T12:00:00Z',
    });
  });

  test('não destinatário (0 linhas) -> 404 AVISO_NAO_DISPONIVEL', async () => {
    comportamentoPostgrest = async () => [];
    const r = await request('GET', '/motorista/avisos/999', {
      headers: { 'x-test-cnpj': 'cnpj-s' },
    });
    assert.equal(r.status, 404);
    assert.equal(r.body.erro, 'AVISO_NAO_DISPONIVEL');
  });

  test('id não numérico -> 404 AVISO_NAO_DISPONIVEL sem chamar o PostgREST', async () => {
    const r = await request('GET', '/motorista/avisos/abc', {
      headers: { 'x-test-cnpj': 'cnpj-t' },
    });
    assert.equal(r.status, 404);
    assert.equal(chamadasPostgrest.length, 0);
  });
});

describe('Rate limit (FR-027): 30 req/15min por cnpjPrestador, somando inscrição/revogação/estado', () => {
  test('31ª requisição no mesmo cnpjPrestador -> 429 LIMITE_EXCEDIDO', async () => {
    const cnpj = 'cnpj-rate-limit-unico';
    let ultima;
    for (let i = 0; i < 30; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      ultima = await request('PUT', '/motorista/push/estado', {
        headers: { 'x-test-cnpj': cnpj },
        body: { dispositivoId: DISPOSITIVO_VALIDO, estado: 'ativas', plataforma: 'ios' },
      });
      assert.notEqual(ultima.status, 429, `requisição ${i + 1}/30 não deveria ser limitada`);
    }
    const r31 = await request('PUT', '/motorista/push/estado', {
      headers: { 'x-test-cnpj': cnpj },
      body: { dispositivoId: DISPOSITIVO_VALIDO, estado: 'ativas', plataforma: 'ios' },
    });
    assert.equal(r31.status, 429);
    assert.equal(r31.body.erro, 'LIMITE_EXCEDIDO');
  });
});
