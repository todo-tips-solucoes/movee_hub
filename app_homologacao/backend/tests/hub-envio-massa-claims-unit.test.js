/**
 * Testes unitários — middleware/hub-envio-massa-claims.js (S8, tasks.md
 * FASE 2.1.6). Rodam com: node --test tests/hub-envio-massa-claims-unit.test.js
 *
 * Mock de `global.fetch` (mesmo padrão de tests/hub-postgrest-unit.test.js) —
 * sem rede real, sem depender de hub-homolog estar de pé.
 *
 * Cobre os 3 ramos do discriminador (research.md Decision 2, contracts/
 * claims-adapter.md):
 *   1. sessão hub (`req.user.sub` presente) — sem entidade_ativa (403
 *      SEM_ENTIDADE_ATIVA), com entidade_ativa OK (reescreve req.user +
 *      req.hubContext), falha de infra (502 ADAPTADOR_INDISPONIVEL)
 *   2. sessão legada (`sub` ausente, `empresaId` presente) — next() imediato,
 *      zero leitura/mutação adicional
 *   3. nem legado nem hub — 401 TOKEN_INVALIDO
 *   + caso de drift (achado F1): payload com `sub` E `empresaId`
 *     simultâneos cai SEMPRE no ramo 1 (ordem de discriminação)
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.PGRST_JWT_SECRET = process.env.PGRST_JWT_SECRET || 'segredo-teste-postgrest';
process.env.POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest-fake:3000';

const { hubEnvioMassaClaimsBridge } = require('../middleware/hub-envio-massa-claims');

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

function mockReqRes(user) {
  const req = { user };
  let statusCode = null;
  let jsonBody = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      jsonBody = body;
      return this;
    },
  };
  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };
  return { req, res, next, getStatus: () => statusCode, getJson: () => jsonBody, wasNextCalled: () => nextCalled };
}

describe('hub-envio-massa-claims — hubEnvioMassaClaimsBridge', () => {
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
  });

  test('ramo 1: sub presente, entidade_ativa ausente -> 403 SEM_ENTIDADE_ATIVA, sem next()', async () => {
    const { req, res, next, getStatus, getJson, wasNextCalled } = mockReqRes({
      sub: 42,
      email: 'a@b.com',
    });
    await hubEnvioMassaClaimsBridge(req, res, next);
    assert.equal(getStatus(), 403);
    assert.equal(getJson().error.code, 'SEM_ENTIDADE_ATIVA');
    assert.equal(wasNextCalled(), false);
  });

  test('ramo 1: sub + entidade_ativa OK, sem grupo -> reescreve req.user + req.hubContext, next()', async () => {
    global.fetch = async (url) => {
      // Empresa?id=eq.<entidade_ativa>&select=id,id_grupo
      return mockResponse([{ id: 7, id_grupo: null }]);
    };
    const { req, res, next, wasNextCalled } = mockReqRes({ sub: 42, email: 'a@b.com', entidade_ativa: 7 });
    await hubEnvioMassaClaimsBridge(req, res, next);
    assert.equal(wasNextCalled(), true);
    assert.deepEqual(req.user, { empresaId: 7, id_grupo: null, is_grupo_pai: false });
    assert.deepEqual(req.hubContext, { viaHub: true, usuarioId: 42 });
  });

  test('ramo 1: sub + entidade_ativa, id_grupo presente e é pai -> is_grupo_pai=true, id_grupo=Grupo.id', async () => {
    let chamada = 0;
    global.fetch = async (url) => {
      chamada += 1;
      if (chamada === 1) return mockResponse([{ id: 7, id_grupo: 3 }]);
      // Grupo?id_empresa_pai=eq.7&select=id
      return mockResponse([{ id: 99 }]);
    };
    const { req, res, next, wasNextCalled } = mockReqRes({ sub: 42, email: 'a@b.com', entidade_ativa: 7 });
    await hubEnvioMassaClaimsBridge(req, res, next);
    assert.equal(wasNextCalled(), true);
    assert.deepEqual(req.user, { empresaId: 7, id_grupo: 99, is_grupo_pai: true });
  });

  test('ramo 1: sub + entidade_ativa, id_grupo presente mas NÃO é pai -> is_grupo_pai=false, id_grupo=Empresa.id_grupo', async () => {
    let chamada = 0;
    global.fetch = async () => {
      chamada += 1;
      if (chamada === 1) return mockResponse([{ id: 8, id_grupo: 3 }]);
      return mockResponse([]); // não é pai de nenhum grupo
    };
    const { req, res, next, wasNextCalled } = mockReqRes({ sub: 42, email: 'a@b.com', entidade_ativa: 8 });
    await hubEnvioMassaClaimsBridge(req, res, next);
    assert.equal(wasNextCalled(), true);
    assert.deepEqual(req.user, { empresaId: 8, id_grupo: 3, is_grupo_pai: false });
  });

  test('ramo 1: falha de infra (fetch lança) -> 502 ADAPTADOR_INDISPONIVEL, sem next()', async () => {
    global.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const { req, res, next, getStatus, getJson, wasNextCalled } = mockReqRes({ sub: 42, entidade_ativa: 7 });
    await hubEnvioMassaClaimsBridge(req, res, next);
    assert.equal(getStatus(), 502);
    assert.equal(getJson().error.code, 'ADAPTADOR_INDISPONIVEL');
    assert.equal(wasNextCalled(), false);
  });

  test('ramo 2: sessão legada (sub ausente, empresaId presente) -> next() imediato, req.user intocado', async () => {
    global.fetch = async () => {
      throw new Error('não deveria chamar fetch para sessão legada');
    };
    const userOriginal = { empresaId: 5, id_grupo: null, is_grupo_pai: false };
    const { req, res, next, wasNextCalled } = mockReqRes(userOriginal);
    await hubEnvioMassaClaimsBridge(req, res, next);
    assert.equal(wasNextCalled(), true);
    assert.strictEqual(req.user, userOriginal); // mesma referência, nenhuma mutação
  });

  test('ramo 3: nem legado nem hub -> 401 TOKEN_INVALIDO', async () => {
    const { req, res, next, getStatus, getJson, wasNextCalled } = mockReqRes({});
    await hubEnvioMassaClaimsBridge(req, res, next);
    assert.equal(getStatus(), 401);
    assert.equal(getJson().error.code, 'TOKEN_INVALIDO');
    assert.equal(wasNextCalled(), false);
  });

  test('achado F1 (drift): payload com sub E empresaId simultâneos cai no ramo 1 (hub), não no legado', async () => {
    global.fetch = async () => mockResponse([{ id: 7, id_grupo: null }]);
    const { req, res, next, wasNextCalled } = mockReqRes({ sub: 42, empresaId: 999, entidade_ativa: 7 });
    await hubEnvioMassaClaimsBridge(req, res, next);
    assert.equal(wasNextCalled(), true);
    // req.user foi REESCRITO pelo ramo hub (empresaId=999 do payload legado
    // NÃO sobrevive — prova que o ramo 1 venceu, não o ramo 2).
    assert.deepEqual(req.user, { empresaId: 7, id_grupo: null, is_grupo_pai: false });
    assert.deepEqual(req.hubContext, { viaHub: true, usuarioId: 42 });
  });
});
