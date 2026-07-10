/**
 * Testes unitários — lib/hub-rbac-cache.js#obterModulosAtivosPorEntidade/
 * invalidarEntidadeModulos + middleware/hub-require-modulo.js#requireModuloAtivo
 * (hub-auditoria-admin S9, tasks.md FASE 4.1.4). Rodam com: node --test
 * tests/hub-require-modulo-unit.test.js
 *
 * Mock de `global.fetch` (mesmo padrão de tests/hub-envio-massa-permission-unit
 * .test.js). Cobre:
 *   - obterModulosAtivosPorEntidade: hit/miss/TTL/invalidação/fail-closed
 *   - requireModuloAtivo: módulo ativo -> next(); inativo -> 403
 *     MODULO_DESABILITADO; erro de infra -> 403 (nunca next()); sem cookie/
 *     token -> 401; sem entidade ativa -> 403 MODULO_DESABILITADO
 *
 * Ref: research.md Decision 3, contracts/admin-modulos-api.md, tasks.md 4.1.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-unit';
process.env.PGRST_JWT_SECRET = process.env.PGRST_JWT_SECRET || 'segredo-teste-postgrest';
process.env.POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest-fake:3000';

const {
  obterModulosAtivosPorEntidade,
  invalidarEntidadeModulos,
  limparCache,
} = require('../lib/hub-rbac-cache');
const { requireModuloAtivo } = require('../middleware/hub-require-modulo');

const ORIGINAL_FETCH = global.fetch;

function mockResponse(body) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

function tokenValido({ sub = 1, entidadeAtiva = 9001 } = {}) {
  return jwt.sign({ sub, entidade_ativa: entidadeAtiva }, process.env.JWT_SECRET, { algorithm: 'HS256' });
}

function mockReqRes({ accessToken } = {}) {
  const req = { cookies: accessToken !== undefined ? { accessToken } : {} };
  let statusCode = null;
  let jsonBody = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { jsonBody = body; return this; },
  };
  let nextCalled = false;
  const next = () => { nextCalled = true; };
  return { req, res, next, getStatus: () => statusCode, getJson: () => jsonBody, wasNextCalled: () => nextCalled };
}

describe('obterModulosAtivosPorEntidade', () => {
  beforeEach(() => { limparCache(); });
  afterEach(() => { global.fetch = ORIGINAL_FETCH; limparCache(); });

  test('retorna o Set de códigos ativos', async () => {
    global.fetch = async () => mockResponse([
      { modulo: { codigo: 'usuarios' } },
      { modulo: { codigo: 'auditoria' } },
    ]);
    const s = await obterModulosAtivosPorEntidade(9001);
    assert.deepEqual([...s].sort(), ['auditoria', 'usuarios']);
  });

  test('sem linhas -> Set vazio', async () => {
    global.fetch = async () => mockResponse([]);
    const s = await obterModulosAtivosPorEntidade(9002);
    assert.equal(s.size, 0);
  });

  test('cache: 2ª chamada dentro do TTL não bate fetch de novo', async () => {
    let chamadas = 0;
    global.fetch = async () => { chamadas += 1; return mockResponse([{ modulo: { codigo: 'admin' } }]); };
    await obterModulosAtivosPorEntidade(9003);
    await obterModulosAtivosPorEntidade(9003);
    assert.equal(chamadas, 1);
  });

  test('invalidarEntidadeModulos limpa a entrada — próxima chamada bate fetch de novo', async () => {
    let chamadas = 0;
    global.fetch = async () => { chamadas += 1; return mockResponse([{ modulo: { codigo: 'admin' } }]); };
    await obterModulosAtivosPorEntidade(9004);
    invalidarEntidadeModulos(9004);
    await obterModulosAtivosPorEntidade(9004);
    assert.equal(chamadas, 2);
  });

  test('erro de infra -> fail-closed (Set vazio), NUNCA cacheado', async () => {
    let chamadas = 0;
    global.fetch = async () => { chamadas += 1; throw new Error('postgrest indisponível'); };
    const s1 = await obterModulosAtivosPorEntidade(9005);
    const s2 = await obterModulosAtivosPorEntidade(9005);
    assert.equal(s1.size, 0);
    assert.equal(s2.size, 0);
    assert.equal(chamadas, 2);
  });

  test('invalidarEntidadeModulos não colide com cache de usuário (namespace mod: distinto)', async () => {
    // entidadeId numericamente igual a um usuarioId não deve colidir — chaves
    // `mod:<id>` vs `<id>`/`<id>:*` são namespaces distintos por construção.
    global.fetch = async () => mockResponse([{ modulo: { codigo: 'usuarios' } }]);
    const s = await obterModulosAtivosPorEntidade(1);
    assert.equal(s.has('usuarios'), true);
  });
});

describe('requireModuloAtivo', () => {
  beforeEach(() => { limparCache(); });
  afterEach(() => { global.fetch = ORIGINAL_FETCH; limparCache(); });

  test('sem cookie/token -> 401 NAO_AUTENTICADO (nunca consulta módulos)', async () => {
    global.fetch = async () => { throw new Error('não deveria consultar módulos sem auth'); };
    const mw = requireModuloAtivo('usuarios');
    const { req, res, next, getStatus, getJson, wasNextCalled } = mockReqRes({});
    await mw(req, res, next);
    assert.equal(getStatus(), 401);
    assert.deepEqual(getJson(), { erro: 'NAO_AUTENTICADO' });
    assert.equal(wasNextCalled(), false);
  });

  test('token válido sem entidade_ativa -> 403 MODULO_DESABILITADO', async () => {
    global.fetch = async () => { throw new Error('não deveria consultar módulos sem entidade ativa'); };
    const mw = requireModuloAtivo('usuarios');
    const { req, res, next, getStatus, getJson, wasNextCalled } = mockReqRes({ accessToken: tokenValido({ entidadeAtiva: undefined }) });
    await mw(req, res, next);
    assert.equal(getStatus(), 403);
    assert.deepEqual(getJson(), { erro: 'MODULO_DESABILITADO' });
    assert.equal(wasNextCalled(), false);
  });

  test('módulo ATIVO na entidade -> next()', async () => {
    global.fetch = async () => mockResponse([{ modulo: { codigo: 'usuarios' } }, { modulo: { codigo: 'auditoria' } }]);
    const mw = requireModuloAtivo('usuarios');
    const { req, res, next, wasNextCalled } = mockReqRes({ accessToken: tokenValido({ entidadeAtiva: 9010 }) });
    await mw(req, res, next);
    assert.equal(wasNextCalled(), true);
  });

  test('módulo INATIVO/ausente na entidade -> 403 MODULO_DESABILITADO', async () => {
    global.fetch = async () => mockResponse([{ modulo: { codigo: 'auditoria' } }]);
    const mw = requireModuloAtivo('admin');
    const { req, res, next, getStatus, getJson, wasNextCalled } = mockReqRes({ accessToken: tokenValido({ entidadeAtiva: 9011 }) });
    await mw(req, res, next);
    assert.equal(getStatus(), 403);
    assert.deepEqual(getJson(), { erro: 'MODULO_DESABILITADO' });
    assert.equal(wasNextCalled(), false);
  });

  test('erro de infra ao resolver módulos -> 403 (fail-closed, NUNCA next())', async () => {
    global.fetch = async () => { throw new Error('postgrest indisponível'); };
    const mw = requireModuloAtivo('usuarios');
    const { req, res, next, getStatus, getJson, wasNextCalled } = mockReqRes({ accessToken: tokenValido({ entidadeAtiva: 9012 }) });
    await mw(req, res, next);
    assert.equal(getStatus(), 403);
    assert.deepEqual(getJson(), { erro: 'MODULO_DESABILITADO' });
    assert.equal(wasNextCalled(), false);
  });

  test('token assinado com segredo errado -> 401 (nunca next())', async () => {
    global.fetch = async () => { throw new Error('não deveria consultar módulos com token inválido'); };
    const tokenInvalido = jwt.sign({ sub: 1, entidade_ativa: 9013 }, 'segredo-errado', { algorithm: 'HS256' });
    const mw = requireModuloAtivo('usuarios');
    const { req, res, next, getStatus, wasNextCalled } = mockReqRes({ accessToken: tokenInvalido });
    await mw(req, res, next);
    assert.equal(getStatus(), 401);
    assert.equal(wasNextCalled(), false);
  });
});
