/**
 * Unit — POST /motorista/register (rota REAL) recusa quando a ContaMotorista daquele CNPJ tem reset de senha
 * em curso/expirado (token_reset_hash preenchido). O reset do hub zera Motorista.senha de verdade (gatilho G2,
 * 0123); sem a recusa, quem soubesse o CNPJ definiria a senha pelo /register (senha legada NULL = "livre").
 *   node --test tests/motorista-register-reset-unit.test.js
 */

'use strict';

process.env.JWT_SECRET = 'test-secret-key-for-jest-only-32chars!!';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-32chars-here!!';
process.env.NODE_ENV = 'test';
process.env.POSTGREST_URL = 'http://hub.invalid';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('module');

let contasComReset = [];
const consultasHub = [];
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === '../lib/hub-postgrest') {
    return {
      hubPostgrestRequest: async (endpoint) => {
        consultasHub.push(endpoint);
        if (endpoint.includes('token_reset_hash=not.is.null')) return contasComReset;
        return [];
      },
    };
  }
  return originalLoad.apply(this, arguments);
};
const express = require('express');
const cookieParser = require('cookie-parser');
const { router, init } = require('../routes/motorista.js');
Module._load = originalLoad;

const chamadasLegado = [];
init({
  postgrestRequest: async (endpoint, metodo = 'GET') => {
    chamadasLegado.push({ endpoint, metodo });
    if (metodo === 'GET') return [{ id: 1, senha: null, ativo: true }];
    return [];
  },
  generatePostgrestJWT: () => 'mock-jwt',
});

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/motorista', router);

let server;
let baseUrl;
before(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => { contasComReset = []; consultasHub.length = 0; chamadasLegado.length = 0; });

function register() {
  return new Promise((resolve, reject) => {
    const dados = JSON.stringify({ cnpjPrestador: '11222333000199', nome: 'Fulano', senha: 'senha1234' });
    const url = new URL('/motorista/register', baseUrl);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(dados) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf) }));
    });
    req.on('error', reject);
    req.write(dados);
    req.end();
  });
}

describe('POST /motorista/register x reset de senha do hub', () => {
  test('conta com token_reset_hash: 409 anti-enumeração e NADA é escrito no legado', async () => {
    contasComReset = [{ id: 7 }];
    const r = await register();
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'CNPJ não elegível para cadastro ou já possui conta.');
    assert.deepEqual(chamadasLegado.filter((c) => c.metodo !== 'GET'), []);
    assert.ok(consultasHub.some((e) => e.includes('token_reset_hash=not.is.null')));
  });

  test('sem reset em curso: segue o fluxo normal (201, senha gravada)', async () => {
    const r = await register();
    assert.equal(r.status, 201);
    assert.equal(chamadasLegado.filter((c) => c.metodo === 'PATCH').length, 1);
  });
});
