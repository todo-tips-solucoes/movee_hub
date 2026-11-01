/**
 * Unit — POST /motorista/token/refresh (rota REAL) relê o banco a cada renovação, na mesma tabela que o /login usa
 * conforme HUB_MOTORISTA_LOGIN_CONTA_ATIVA (ligada -> ContaMotorista; desligada -> Motorista).
 *   node --test tests/motorista-refresh-rele-banco-unit.test.js
 */

'use strict';

process.env.JWT_SECRET = 'test-secret-key-for-jest-only-32chars!!';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-32chars-here!!';
process.env.NODE_ENV = 'test';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const Module = require('module');

let consultas = []; // { tabela, query }
let respostaLegado;
let respostaConta;
let respostaEntregador;
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === '../lib/hub-postgrest') {
    return { hubPostgrestRequest: async (q) => {
      if (q.startsWith('Entregador?')) return respostaEntregador();
      consultas.push({ tabela: 'ContaMotorista', q });
      return respostaConta();
    } };
  }
  return originalLoad.apply(this, arguments);
};
const express = require('express');
const cookieParser = require('cookie-parser');
const { router, init } = require('../routes/motorista.js');
Module._load = originalLoad;

init({
  postgrestRequest: async (q) => { consultas.push({ tabela: 'Motorista', q }); return respostaLegado(); },
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

const CNPJ = '12345678000199';
beforeEach(() => {
  consultas = [];
  respostaLegado = async () => [];
  respostaConta = async () => [];
  respostaEntregador = async () => [];
});

function refreshCom(token) {
  return new Promise((resolve, reject) => {
    const url = new URL('/motorista/token/refresh', baseUrl);
    const headers = {};
    if (token) headers.Cookie = `refreshToken=${token}`;
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf), cookies: res.headers['set-cookie'] || [] }));
    });
    req.on('error', reject);
    req.end();
  });
}
const tokenValido = (extra) => jwt.sign({ cnpjPrestador: CNPJ, nome: 'Token', aud: 'motorista', ...extra }, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' });
const cookie = (r, nome) => r.cookies.find((c) => c.startsWith(`${nome}=`));
const limpou = (r) => /^accessToken=;/.test(cookie(r, 'accessToken') || '') && /^refreshToken=;/.test(cookie(r, 'refreshToken') || '');

for (const [modo, valor, tabela, setLinhas] of [
  ['chave desligada (Motorista)', undefined, 'Motorista', (l) => { respostaLegado = async () => l; }],
  ['chave ligada (ContaMotorista)', 'true', 'ContaMotorista', (l) => { respostaConta = async () => l; }],
]) {
  describe(modo, () => {
    beforeEach(() => {
      if (valor === undefined) delete process.env.HUB_MOTORISTA_LOGIN_CONTA_ATIVA;
      else process.env.HUB_MOTORISTA_LOGIN_CONTA_ATIVA = valor;
    });
    after(() => { delete process.env.HUB_MOTORISTA_LOGIN_CONTA_ATIVA; });

    test('ativo com senha: renova, consulta só a tabela da chave e usa o nome da linha', async () => {
      setLinhas([{ cnpj_prestador: CNPJ, nome: 'Nome do Banco', senha: 'hash', ativo: true }]);
      const r = await refreshCom(tokenValido());
      assert.equal(r.status, 200);
      const ac = decodeURIComponent(cookie(r, 'accessToken').split(';')[0].split('=')[1]);
      assert.equal(jwt.decode(ac).nome, 'Nome do Banco');
      assert.deepEqual(consultas.map((c) => c.tabela), [tabela]);
      assert.match(consultas[0].q, new RegExp(`cnpj_prestador=eq\\.${CNPJ}`));
    });

    test('entregadorUuid no token renovado: só com a chave ligada e vínculo existente (recalculado do banco)', async () => {
      setLinhas([{ id: 7, cnpj_prestador: CNPJ, nome: 'N', senha: 'hash', ativo: true }]);
      const acessoDe = (r) => jwt.decode(decodeURIComponent(cookie(r, 'accessToken').split(';')[0].split('=')[1]));
      respostaEntregador = async () => [{ id_externo: 'uuid-do-banco' }];
      // o token antigo traz outra claim: não deve ser copiada
      const comVinculo = acessoDe(await refreshCom(tokenValido({ entregadorUuid: 'uuid-velho' })));
      assert.equal(comVinculo.entregadorUuid, valor === 'true' ? 'uuid-do-banco' : undefined);
      respostaEntregador = async () => [];
      const semVinculo = acessoDe(await refreshCom(tokenValido({ entregadorUuid: 'uuid-velho' })));
      assert.equal(semVinculo.entregadorUuid, undefined);
      respostaEntregador = async () => { throw new Error('db fora'); };
      const comErro = await refreshCom(tokenValido());
      assert.equal(comErro.status, 200); // best-effort, igual ao login
      assert.equal(acessoDe(comErro).entregadorUuid, undefined);
    });

    test('inativo: 401 e cookies limpos', async () => {
      setLinhas([{ cnpj_prestador: CNPJ, nome: 'X', senha: 'hash', ativo: false }]);
      const r = await refreshCom(tokenValido());
      assert.equal(r.status, 401);
      assert.equal(r.body.error, 'Credenciais inválidas.');
      assert.ok(limpou(r));
    });

    test('inexistente (CNPJ trocado): 401 e cookies limpos', async () => {
      setLinhas([]);
      const r = await refreshCom(tokenValido());
      assert.equal(r.status, 401);
      assert.ok(limpou(r));
    });

    test('sem senha (reset em curso): 401 e cookies limpos', async () => {
      setLinhas([{ cnpj_prestador: CNPJ, nome: 'X', senha: null, ativo: true }]);
      const r = await refreshCom(tokenValido());
      assert.equal(r.status, 401);
      assert.ok(limpou(r));
    });

    test('erro de banco: 503, sem renovar e sem limpar cookies', async () => {
      const boom = async () => { throw new Error('db fora'); };
      if (tabela === 'Motorista') respostaLegado = boom; else respostaConta = boom;
      const r = await refreshCom(tokenValido());
      assert.equal(r.status, 503);
      assert.deepEqual(r.cookies, []);
    });

    test('audiência errada: 401 sem consultar o banco', async () => {
      const r = await refreshCom(tokenValido({ aud: 'empresa' }));
      assert.equal(r.status, 401);
      assert.equal(consultas.length, 0);
    });

    test('sem cookie: 401; token inválido: 403', async () => {
      assert.equal((await refreshCom()).status, 401);
      assert.equal((await refreshCom('lixo')).status, 403);
      assert.equal(consultas.length, 0);
    });
  });
}
