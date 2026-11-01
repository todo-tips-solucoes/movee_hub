/**
 * Unit — POST /motorista/login (rota REAL) compara contra o DUMMY_HASH único (lib/senha.js) quando NÃO há linha ou a
 * linha não tem senha. Anti-enumeração por tempo (CWE-208): sem isso, "CNPJ sem acesso" respondia 401 em ~1 ms e
 * "CNPJ com acesso, senha errada" em ~60 ms, e a diferença revela quais CNPJs têm credencial.
 *   node --test tests/motorista-login-dummy-hash.test.js
 *
 * Cobre o caso "0 linhas" do PostgREST (`[]`) e o pré-cadastro (senha NULL), nos dois caminhos do login (legado e
 * via ContaMotorista), e que server.js/hub-auth.js usam a MESMA constante.
 */

'use strict';

process.env.JWT_SECRET = 'test-secret-key-for-jest-only-32chars!!';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-32chars-here!!';
process.env.NODE_ENV = 'test';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bcrypt = require('bcrypt');
const Module = require('module');
const { DUMMY_HASH } = require('../lib/senha');

let linhasLegado = [];
let linhasConta = [];
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === '../lib/hub-postgrest') {
    return { hubPostgrestRequest: async () => linhasConta };
  }
  return originalLoad.apply(this, arguments);
};
const express = require('express');
const cookieParser = require('cookie-parser');
const { router, init } = require('../routes/motorista.js');
Module._load = originalLoad;

init({ postgrestRequest: async () => linhasLegado, generatePostgrestJWT: () => 'mock-jwt' });

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

const comparadoCom = [];
const compareOriginal = bcrypt.compare;
let contador = 0;
beforeEach(() => {
  comparadoCom.length = 0;
  linhasLegado = [];
  linhasConta = [];
  // cada login usa um CNPJ distinto: o limitador por (IP, CNPJ) não interfere
  contador += 1;
  bcrypt.compare = async (s, h) => { comparadoCom.push(h); return compareOriginal.call(bcrypt, s, h); };
});
after(() => { bcrypt.compare = compareOriginal; });

function login(cnpj) {
  return new Promise((resolve, reject) => {
    const dados = JSON.stringify({ cnpjPrestador: cnpj, senha: 'SenhaQualquer1' });
    const url = new URL('/motorista/login', baseUrl);
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
const cnpjDoTeste = () => String(10000000000000 + contador);

describe('login legado (Motorista)', () => {
  beforeEach(() => { delete process.env.HUB_MOTORISTA_LOGIN_CONTA_ATIVA; });

  test('0 linhas: 401 genérico E compara contra o DUMMY_HASH', async () => {
    const r = await login(cnpjDoTeste());
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'Credenciais inválidas.');
    assert.deepEqual(comparadoCom, [DUMMY_HASH]);
  });

  test('pré-cadastro (senha NULL): 401 genérico E compara contra o DUMMY_HASH', async () => {
    linhasLegado = [{ cnpj_prestador: cnpjDoTeste(), senha: null, ativo: true }];
    const r = await login(cnpjDoTeste());
    assert.equal(r.status, 401);
    assert.deepEqual(comparadoCom, [DUMMY_HASH]);
  });

  test('linha com senha: compara contra o hash REAL (não o dummy)', async () => {
    const hash = await bcrypt.hash('OutraSenha1', 4);
    linhasLegado = [{ cnpj_prestador: cnpjDoTeste(), senha: hash, ativo: true }];
    const r = await login(cnpjDoTeste());
    assert.equal(r.status, 401);
    assert.deepEqual(comparadoCom, [hash]);
  });
});

describe('login via ContaMotorista (HUB_MOTORISTA_LOGIN_CONTA_ATIVA=true)', () => {
  beforeEach(() => { process.env.HUB_MOTORISTA_LOGIN_CONTA_ATIVA = 'true'; });
  after(() => { delete process.env.HUB_MOTORISTA_LOGIN_CONTA_ATIVA; });

  test('0 linhas: 401 genérico E compara contra o DUMMY_HASH', async () => {
    const r = await login(cnpjDoTeste());
    assert.equal(r.status, 401);
    assert.deepEqual(comparadoCom, [DUMMY_HASH]);
  });

  test('conta sem senha (reset em curso): 401 genérico E compara contra o DUMMY_HASH', async () => {
    linhasConta = [{ id: 1, cnpj_prestador: cnpjDoTeste(), senha: null, ativo: true }];
    const r = await login(cnpjDoTeste());
    assert.equal(r.status, 401);
    assert.deepEqual(comparadoCom, [DUMMY_HASH]);
  });
});

test('o DUMMY_HASH é um bcrypt de 60 caracteres e é o MESMO em server.js, hub-auth.js e lib/senha.js', () => {
  assert.equal(DUMMY_HASH.length, 60);
  assert.match(DUMMY_HASH, /^\$2b\$10\$/);
  const fs = require('node:fs');
  const path = require('node:path');
  for (const arq of ['../server.js', '../routes/hub-auth.js']) {
    const fonte = fs.readFileSync(path.resolve(__dirname, arq), 'utf8');
    assert.match(fonte, /DUMMY_HASH: BCRYPT_DUMMY_HASH\s*\}\s*=\s*require\('(\.\/|\.\.\/)lib\/senha'\)/, arq);
    assert.equal(/\$2b\$10\$abcdefghijklmnopqrstuu/.test(fonte), false, `${arq} ainda tem o literal duplicado`);
  }
});
