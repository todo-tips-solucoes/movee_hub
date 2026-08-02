/**
 * Testes unitários — lib/hub-access-token.js.
 * Rodam com: node --test tests/hub-access-token-unit.test.js
 *
 * O módulo é a fonte única do `jwt.verify` do hub, extraído de 8 cópias
 * idênticas em `routes/hub-*.js` mais 3 variantes inline (os dois middlewares
 * `hub-require-*` e `decodificarUsuarioIdDoAccessToken` em hub-auth.js).
 *
 * O caso que justifica o módulo existir é o `alg: none`: enquanto a pinagem
 * `algorithms: ['HS256']` estava replicada em 11 lugares, bastava um deles
 * esquecer a opção para aceitar token não assinado. Aqui isso é asserção.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const { decodificarAccessToken } = require('../lib/hub-access-token');

const SEGREDO = 'segredo-de-teste-hub-access-token';
let segredoOriginal;

beforeEach(() => {
  segredoOriginal = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SEGREDO;
});

afterEach(() => {
  if (segredoOriginal === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = segredoOriginal;
});

describe('decodificarAccessToken', () => {
  test('token válido HS256 → devolve o payload', () => {
    const token = jwt.sign({ sub: 42, entidade_ativa: 9001 }, SEGREDO, { algorithm: 'HS256' });
    const payload = decodificarAccessToken(token);
    assert.equal(payload.sub, 42);
    assert.equal(payload.entidade_ativa, 9001);
  });

  test('ausente/vazio → null, sem lançar', () => {
    assert.equal(decodificarAccessToken(undefined), null);
    assert.equal(decodificarAccessToken(null), null);
    assert.equal(decodificarAccessToken(''), null);
  });

  test('malformado → null, sem lançar', () => {
    assert.equal(decodificarAccessToken('nao-e-um-jwt'), null);
    assert.equal(decodificarAccessToken('a.b.c'), null);
  });

  test('assinado com outra chave → null', () => {
    const token = jwt.sign({ sub: 42 }, 'outra-chave-qualquer', { algorithm: 'HS256' });
    assert.equal(decodificarAccessToken(token), null);
  });

  test('expirado → null', () => {
    const token = jwt.sign({ sub: 42 }, SEGREDO, { algorithm: 'HS256', expiresIn: -10 });
    assert.equal(decodificarAccessToken(token), null);
  });

  // O motivo de existir a fonte única: pinagem de algoritmo (Decision 12 /
  // owasp-security). Sem `algorithms: ['HS256']`, este token passaria.
  test('alg: none → null (pinagem de algoritmo)', () => {
    const tokenNone = jwt.sign({ sub: 42 }, '', { algorithm: 'none' });
    assert.equal(decodificarAccessToken(tokenNone), null);
  });

  test('HS384/HS512 com o mesmo segredo → null (só HS256 é aceito)', () => {
    assert.equal(decodificarAccessToken(jwt.sign({ sub: 42 }, SEGREDO, { algorithm: 'HS384' })), null);
    assert.equal(decodificarAccessToken(jwt.sign({ sub: 42 }, SEGREDO, { algorithm: 'HS512' })), null);
  });
});
