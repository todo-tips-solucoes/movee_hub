/**
 * Testes unitários — lib/hub-postgrest.js. Rodam com:
 * node --test tests/hub-postgrest-unit.test.js
 *
 * Cobre (mock de `global.fetch`, sem rede real):
 *   - F9 (pós-review PR #57): fallback de paginação quando `Content-Range`
 *     está ausente ou termina em `*` — NUNCA deve virar `total: 0` (isso
 *     "some" com a paginação na UI quando há linhas reais).
 *   - F1.2 (pós-review PR #57): `opts.signal` é repassado a `fetch` (permite
 *     ao processor abortar uma chamada pendurada após TIMEOUT_IMPORTACAO_MS).
 *   - comportamento pré-existente: parse de corpo JSON, `opts.range`,
 *     `opts.count` com Content-Range normal, erro HTTP propaga com `.status`.
 *
 * Ref: lib/hub-postgrest.js, docs "pr57-fixes.md" F9.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.PGRST_JWT_SECRET = process.env.PGRST_JWT_SECRET || 'segredo-teste-postgrest';
process.env.POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest-fake:3000';

const { hubPostgrestRequest } = require('../lib/hub-postgrest');

const ORIGINAL_FETCH = global.fetch;

function mockResponse({ ok = true, status = 200, statusText = 'OK', contentRange, body = null } = {}) {
  return {
    ok,
    status,
    statusText,
    headers: { get: (nome) => (nome.toLowerCase() === 'content-range' ? (contentRange ?? null) : null) },
    text: async () => (body === null ? '' : JSON.stringify(body)),
  };
}

describe('hub-postgrest — hubPostgrestRequest', () => {
  let ultimaChamadaFetch;

  beforeEach(() => {
    ultimaChamadaFetch = null;
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
  });

  test('corpo JSON simples (sem opts.count) -> devolve o array parseado direto', async () => {
    global.fetch = async (url, init) => {
      ultimaChamadaFetch = { url, init };
      return mockResponse({ body: [{ id: 1 }, { id: 2 }] });
    };
    const out = await hubPostgrestRequest('ImportacaoArquivo?select=id', 'GET');
    assert.deepEqual(out, [{ id: 1 }, { id: 2 }]);
  });

  test('resposta 204 (sem corpo) -> null', async () => {
    global.fetch = async () => mockResponse({ status: 204, body: null });
    const out = await hubPostgrestRequest('ImportacaoArquivo', 'DELETE');
    assert.equal(out, null);
  });

  test('erro HTTP (!ok) -> lança com .status/.body', async () => {
    global.fetch = async () => mockResponse({ ok: false, status: 409, statusText: 'Conflict', body: { detail: 'x' } });
    await assert.rejects(
      () => hubPostgrestRequest('ImportacaoArquivo', 'POST', {}),
      (err) => err.status === 409 && /409/.test(err.message)
    );
  });

  test('opts.range -> headers Range-Unit/Range enviados corretamente', async () => {
    global.fetch = async (url, init) => {
      ultimaChamadaFetch = { url, init };
      return mockResponse({ body: [] });
    };
    await hubPostgrestRequest('ImportacaoArquivo', 'GET', null, {}, { range: { from: 20, to: 39 } });
    assert.equal(ultimaChamadaFetch.init.headers['Range-Unit'], 'items');
    assert.equal(ultimaChamadaFetch.init.headers.Range, '20-39');
  });

  test('opts.signal -> repassado ao fetch (F1.2, watchdog do processor)', async () => {
    global.fetch = async (url, init) => {
      ultimaChamadaFetch = { url, init };
      return mockResponse({ body: [] });
    };
    const controller = new AbortController();
    await hubPostgrestRequest('ImportacaoArquivo', 'GET', null, {}, { signal: controller.signal });
    assert.equal(ultimaChamadaFetch.init.signal, controller.signal);
  });

  test('opts.count com Content-Range normal ("0-9/42") -> total extraído do header', async () => {
    global.fetch = async () => mockResponse({ contentRange: '0-9/42', body: [{ id: 1 }] });
    const out = await hubPostgrestRequest('ImportacaoArquivo', 'GET', null, {}, { count: true, range: { from: 0, to: 9 } });
    assert.equal(out.total, 42);
    assert.deepEqual(out.data, [{ id: 1 }]);
  });

  // ── F9 ───────────────────────────────────────────────────────────────
  test('F9: Content-Range AUSENTE com opts.count -> fallback offset+data.length, NUNCA total:0 quando há linhas', async () => {
    global.fetch = async () => mockResponse({ contentRange: undefined, body: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const out = await hubPostgrestRequest(
      'ImportacaoArquivo', 'GET', null, {},
      { count: true, range: { from: 40, to: 59 } }
    );
    // offset (40) + 3 linhas retornadas = 43 — nunca 0 (esconderia que há
    // páginas anteriores + a atual com dados reais).
    assert.equal(out.total, 43);
    assert.notEqual(out.total, 0);
  });

  test('F9: Content-Range = "*/*" (PostgREST não conseguiu contar) -> mesmo fallback, não 0', async () => {
    global.fetch = async () => mockResponse({ contentRange: '0-19/*', body: new Array(20).fill({ x: 1 }) });
    const out = await hubPostgrestRequest(
      'ImportacaoArquivo', 'GET', null, {},
      { count: true, range: { from: 0, to: 19 } }
    );
    assert.equal(out.total, 20); // offset 0 + 20 linhas
    assert.notEqual(out.total, 0);
  });

  test('F9: sem opts.range (from ausente) e sem Content-Range -> fallback usa offset 0 + data.length', async () => {
    global.fetch = async () => mockResponse({ contentRange: undefined, body: [{ id: 1 }] });
    const out = await hubPostgrestRequest('ImportacaoArquivo', 'GET', null, {}, { count: true });
    assert.equal(out.total, 1);
  });
});
