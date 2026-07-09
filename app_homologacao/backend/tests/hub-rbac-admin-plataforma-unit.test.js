/**
 * Testes unitários — lib/hub-rbac-cache.js#usuarioEhAdminPlataforma
 * (hub-auditoria-admin S9, tasks.md FASE 3.2/4.5). Rodam com: node --test
 * tests/hub-rbac-admin-plataforma-unit.test.js
 *
 * Mock de `global.fetch` (mesmo padrão de tests/hub-envio-massa-claims-unit.test.js
 * / tests/hub-envio-massa-permission-unit.test.js) — sem rede real. Cobre:
 *   - vínculo ATIVO com papel `admin_plataforma` -> true
 *   - só vínculos com outros papéis (admin_entidade/operador/leitura) -> false
 *   - sem nenhum vínculo -> false
 *   - cache (TTL 60s): 2ª chamada NÃO bate fetch de novo
 *   - invalidarUsuario limpa a entrada (prefixo `usuarioId:` — mesmo mecanismo
 *     de invalidação síncrona já usado por obterPermissoesEfetivasPorEntidade)
 *   - erro de infra -> fail-closed (false), resultado NUNCA cacheado
 *
 * Ref: research.md Decision 2, contracts/auditoria-api.md "Escopo",
 * tasks.md 3.2.5.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.PGRST_JWT_SECRET = process.env.PGRST_JWT_SECRET || 'segredo-teste-postgrest';
process.env.POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest-fake:3000';

const { usuarioEhAdminPlataforma, invalidarUsuario, limparCache } = require('../lib/hub-rbac-cache');

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

describe('usuarioEhAdminPlataforma', () => {
  beforeEach(() => {
    limparCache();
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    limparCache();
  });

  test('vínculo ativo com papel admin_plataforma -> true', async () => {
    global.fetch = async () => mockResponse([{ papel: { nome: 'admin_plataforma' } }]);
    assert.equal(await usuarioEhAdminPlataforma(42), true);
  });

  test('só vínculos com outros papéis -> false', async () => {
    global.fetch = async () => mockResponse([
      { papel: { nome: 'operador' } },
      { papel: { nome: 'admin_entidade' } },
    ]);
    assert.equal(await usuarioEhAdminPlataforma(43), false);
  });

  test('sem nenhum vínculo -> false', async () => {
    global.fetch = async () => mockResponse([]);
    assert.equal(await usuarioEhAdminPlataforma(44), false);
  });

  test('cache: 2ª chamada dentro do TTL não bate fetch de novo', async () => {
    let chamadas = 0;
    global.fetch = async () => {
      chamadas += 1;
      return mockResponse([{ papel: { nome: 'admin_plataforma' } }]);
    };
    await usuarioEhAdminPlataforma(45);
    await usuarioEhAdminPlataforma(45);
    assert.equal(chamadas, 1);
  });

  test('invalidarUsuario limpa a entrada (prefixo usuarioId: — mesmo mecanismo síncrono)', async () => {
    let chamadas = 0;
    global.fetch = async () => {
      chamadas += 1;
      return mockResponse([{ papel: { nome: 'admin_plataforma' } }]);
    };
    await usuarioEhAdminPlataforma(46);
    invalidarUsuario(46);
    await usuarioEhAdminPlataforma(46);
    assert.equal(chamadas, 2);
  });

  test('erro de infra -> fail-closed (false), NUNCA cacheado', async () => {
    let chamadas = 0;
    global.fetch = async () => {
      chamadas += 1;
      throw new Error('postgrest indisponível');
    };
    assert.equal(await usuarioEhAdminPlataforma(47), false);
    assert.equal(await usuarioEhAdminPlataforma(47), false);
    // Não cacheado -> 2ª chamada tenta de novo (mesmo padrão de
    // obterPermissoesEfetivas — erro nunca fixa o resultado por 60s).
    assert.equal(chamadas, 2);
  });
});
