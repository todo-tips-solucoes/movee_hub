/**
 * Testes de integração — POST /motorista/login via ContaMotorista canônica
 * (FASE 5, tasks.md 5.4). Rodam com:
 *   node --test tests/hub-motorista-app-login.test.js
 *
 * Mesmo design de tests/motorista-integration.test.js (node:test + node:http
 * nativos + mock de dependência via Module._load), mas mockando
 * `../lib/hub-postgrest` (em vez de `_postgrestRequest` injetado) — o
 * caminho novo (`loginViaContaMotorista`, routes/motorista.js) usa
 * `hubPostgrestRequest` diretamente, igual às rotas do hub
 * (routes/hub-motoristas.js).
 *
 * Cobre (5.4.2):
 *   - env HUB_MOTORISTA_LOGIN_CONTA_ATIVA=true: conta inexistente/senha
 *     NULL/senha incorreta -> 401 genérico (mesma mensagem do legado);
 *     credencial desativada (ativo=false) -> 403 ANTES de qualquer
 *     token/cookie/chamada extra ao PostgREST (critério de aceite central);
 *     credencial ativa + senha correta -> 200 com cookies.
 *   - env ausente/"false": NUNCA toca `hubPostgrestRequest` — o fluxo legado
 *     (contra `Motorista` via `_postgrestRequest` injetado) roda como
 *     sempre, comportamento 100% preservado (FR-023/SC-007).
 *
 * Ref: docs/specs/hub-motorista-canonico/tasks.md FASE 5 (5.4).
 */

'use strict';

process.env.JWT_SECRET = 'test-secret-key-for-jest-only-32chars!!';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-32chars-here!!';
process.env.NODE_ENV = 'test';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bcrypt = require('bcrypt');

// ──────────────────────────────────────────────────────────────────────────────
// Mock de estado em memória para ContaMotorista (lib/hub-postgrest)
// ──────────────────────────────────────────────────────────────────────────────
const HUB_DB = { ContaMotorista: [] };
function resetHubDB() {
  HUB_DB.ContaMotorista = [];
}

let chamadasHubPostgrest = 0;
async function mockHubPostgrestRequest(endpoint, method = 'GET') {
  chamadasHubPostgrest += 1;
  const [table, query] = endpoint.split('?');
  const params = query ? Object.fromEntries(new URLSearchParams(query)) : {};
  if (method === 'GET') {
    let rows = [...(HUB_DB[table] || [])];
    for (const [key, val] of Object.entries(params)) {
      if (key === 'select') continue;
      const value = String(val).replace(/^eq\./, '');
      rows = rows.filter((r) => String(r[key]) === String(value));
    }
    return rows;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Setup: carregar rota substituindo `../lib/hub-postgrest` (mesma técnica de
// mock via Module._cache já usada em tests/motorista-integration.test.js para
// `axios`).
// ──────────────────────────────────────────────────────────────────────────────
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../lib/hub-postgrest') {
    return { hubPostgrestRequest: (...args) => mockHubPostgrestRequest(...args) };
  }
  return originalLoad.apply(this, arguments);
};

const express = require('express');
const cookieParser = require('cookie-parser');
const { router, init } = require('../routes/motorista.js');

Module._load = originalLoad;

// Fluxo LEGADO (env desligada) usa `_postgrestRequest` injetado — mockado
// para sempre devolver `[]` (Motorista não encontrado), suficiente para
// provar que o fluxo legado nunca toca `hubPostgrestRequest`.
init({ postgrestRequest: async () => [], generatePostgrestJWT: () => 'mock-jwt' });

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/motorista', router);

let server;
let baseUrl;

function request(method, path, { body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const headers = {};
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(data);
        } catch (_) {
          json = data;
        }
        resolve({ status: res.statusCode, body: json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
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

describe('POST /motorista/login — via ContaMotorista (HUB_MOTORISTA_LOGIN_CONTA_ATIVA=true)', () => {
  beforeEach(() => {
    resetHubDB();
    chamadasHubPostgrest = 0;
    process.env.HUB_MOTORISTA_LOGIN_CONTA_ATIVA = 'true';
  });

  test('conta inexistente -> 401 genérico (anti-enumeração, mesma mensagem do legado)', async () => {
    const r = await request('POST', '/motorista/login', { body: { cnpjPrestador: '12345678000195', senha: 'senhaqualquer' } });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'Credenciais inválidas.');
  });

  test('conta com senha NULL (credencial ainda não criada) -> 401 genérico, sem crashar', async () => {
    HUB_DB.ContaMotorista.push({ id: 1, cnpj_prestador: '12345678000195', nome: 'Fulano', ativo: true, senha: null });
    const r = await request('POST', '/motorista/login', { body: { cnpjPrestador: '12345678000195', senha: 'qualquercoisa' } });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'Credenciais inválidas.');
  });

  test('senha incorreta -> 401 genérico', async () => {
    const hash = await bcrypt.hash('SenhaCorreta1', 12);
    HUB_DB.ContaMotorista.push({ id: 1, cnpj_prestador: '12345678000195', nome: 'Fulano', ativo: true, senha: hash });
    const r = await request('POST', '/motorista/login', { body: { cnpjPrestador: '12345678000195', senha: 'SenhaErrada1' } });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'Credenciais inválidas.');
  });

  test('credencial desativada (ativo=false) -> 403 ANTES de qualquer token/cookie, sem chamada extra ao PostgREST (5.4.2)', async () => {
    const hash = await bcrypt.hash('SenhaCorreta1', 12);
    HUB_DB.ContaMotorista.push({ id: 1, cnpj_prestador: '12345678000195', nome: 'Fulano', ativo: false, senha: hash });
    const r = await request('POST', '/motorista/login', { body: { cnpjPrestador: '12345678000195', senha: 'SenhaCorreta1' } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'Conta inativa. Entre em contato com o suporte.');
    assert.equal(r.headers['set-cookie'], undefined);
    // Única chamada ao PostgREST foi o SELECT inicial — nenhum efeito
    // colateral/registro de atividade antes da negação.
    assert.equal(chamadasHubPostgrest, 1);
  });

  test('credencial ativa + senha correta -> 200, cookies emitidos, MESMAS funções de token do legado', async () => {
    const hash = await bcrypt.hash('SenhaCorreta1', 12);
    HUB_DB.ContaMotorista.push({ id: 1, cnpj_prestador: '12345678000195', nome: 'Fulano', ativo: true, senha: hash });
    const r = await request('POST', '/motorista/login', { body: { cnpjPrestador: '12345678000195', senha: 'SenhaCorreta1' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.cnpjPrestador, '12345678000195');
    assert.ok(r.headers['set-cookie'] && r.headers['set-cookie'].length >= 2);
  });
});

describe('POST /motorista/login — HUB_MOTORISTA_LOGIN_CONTA_ATIVA desligada/ausente: comportamento legado 100% preservado (FR-023/SC-007)', () => {
  beforeEach(() => {
    resetHubDB();
    chamadasHubPostgrest = 0;
    delete process.env.HUB_MOTORISTA_LOGIN_CONTA_ATIVA;
  });

  test('env var ausente -> fluxo legado (contra Motorista via _postgrestRequest), NUNCA toca hubPostgrestRequest', async () => {
    const r = await request('POST', '/motorista/login', { body: { cnpjPrestador: '12345678000195', senha: 'senhaqualquer' } });
    assert.equal(r.status, 401); // Motorista mockado para devolver []
    assert.equal(chamadasHubPostgrest, 0);
  });

  test('env var explicitamente "false" -> comportamento legado preservado', async () => {
    process.env.HUB_MOTORISTA_LOGIN_CONTA_ATIVA = 'false';
    const r = await request('POST', '/motorista/login', { body: { cnpjPrestador: '12345678000195', senha: 'senhaqualquer' } });
    assert.equal(r.status, 401);
    assert.equal(chamadasHubPostgrest, 0);
  });
});
