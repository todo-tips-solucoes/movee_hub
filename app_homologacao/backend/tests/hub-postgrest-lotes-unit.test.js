/**
 * Testes unitários — lib/hub-postgrest-lotes.js. Rodam com:
 * node --test tests/hub-postgrest-lotes-unit.test.js
 *
 * Cobre (mock de `global.fetch`, sem rede real) — quickstart.md Cenários
 * F1.2 (lotes de 100) e F1.3 (falha propaga total, nunca parcial).
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.PGRST_JWT_SECRET = process.env.PGRST_JWT_SECRET || 'segredo-teste-postgrest';
process.env.POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest-fake:3000';

const jwt = require('jsonwebtoken');
const { buscarEmLotes } = require('../lib/hub-postgrest-lotes');

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

describe('hub-postgrest-lotes — buscarEmLotes', () => {
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
  });

  test('opts.campoId ausente -> lança antes de qualquer fetch', async () => {
    await assert.rejects(() => buscarEmLotes('Entregador', [1, 2]), /campoId/);
  });

  test('ids vazio/todo null -> [] sem chamar fetch', async () => {
    let chamadas = 0;
    global.fetch = async () => { chamadas += 1; return mockResponse([]); };
    const out = await buscarEmLotes('Entregador?select=id,id_externo', [null, undefined], { campoId: 'id' });
    assert.deepEqual(out, []);
    assert.equal(chamadas, 0);
  });

  // ── Cenário F1.2 (quickstart.md) ────────────────────────────────────────
  test('1.021 ids distintos -> 11 chamadas, nenhuma com mais de 100 ids', async () => {
    const urls = [];
    global.fetch = async (url) => {
      urls.push(url);
      // devolve 1 linha por id pedido, para conferir agregação também.
      const m = url.match(/id=in\.\(([^)]*)\)/);
      const idsDoLote = m[1].split(',');
      return mockResponse(idsDoLote.map((id) => ({ id: Number(id), id_externo: `uuid-${id}` })));
    };

    const ids = Array.from({ length: 1021 }, (_, i) => i + 1);
    const out = await buscarEmLotes('Entregador?select=id,id_externo', ids, { campoId: 'id' });

    assert.equal(urls.length, 11);
    for (const url of urls) {
      const m = url.match(/id=in\.\(([^)]*)\)/);
      const qtdNoLote = m[1].split(',').length;
      assert.ok(qtdNoLote <= 100, `lote com ${qtdNoLote} ids excede 100`);
    }
    assert.equal(out.length, 1021);
  });

  // ── Cenário F1.2 (quickstart.md) — dedup ────────────────────────────────
  test('ids duplicados e null são ignorados antes do chunking', async () => {
    const urls = [];
    global.fetch = async (url) => {
      urls.push(url);
      return mockResponse([{ id: 1 }, { id: 2 }]);
    };

    await buscarEmLotes('Entregador?select=id,id_externo', [1, 1, 2, null, 2, undefined], { campoId: 'id' });

    assert.equal(urls.length, 1);
    assert.match(urls[0], /id=in\.\(1,2\)/);
  });

  // ── Cenário F1.3 (quickstart.md) ────────────────────────────────────────
  test('erro num lote intermediário propaga falha total, sem resultado parcial', async () => {
    let chamada = 0;
    global.fetch = async () => {
      chamada += 1;
      if (chamada === 2) {
        return {
          ok: false,
          status: 502,
          statusText: 'Bad Gateway',
          headers: { get: () => null },
          text: async () => 'erro simulado',
        };
      }
      return mockResponse([{ id: chamada }]);
    };

    const ids = Array.from({ length: 250 }, (_, i) => i + 1); // 3 lotes: 100+100+50
    await assert.rejects(
      () => buscarEmLotes('Entregador?select=id,id_externo', ids, { campoId: 'id' }),
      (err) => err.status === 502
    );
    assert.equal(chamada, 2); // parou no lote que falhou — nunca tenta "completar" com parcial
  });

  test('opts.claims é repassado ao hubPostgrestRequest (RLS por escopo, ex. Entregador)', async () => {
    let authHeader;
    global.fetch = async (url, init) => {
      authHeader = init.headers.Authorization;
      return mockResponse([]);
    };
    await buscarEmLotes('Entregador?select=id,id_externo', [1], { campoId: 'id', claims: { escopo: [42] } });
    const token = authHeader.replace('Bearer ', '');
    const payload = jwt.verify(token, process.env.PGRST_JWT_SECRET);
    assert.deepEqual(payload.escopo, [42]);
  });

  test('caminho sem "?" prévio usa "?" como separador do filtro', async () => {
    const urls = [];
    global.fetch = async (url) => { urls.push(url); return mockResponse([]); };
    await buscarEmLotes('Entregador', [1, 2], { campoId: 'id' });
    assert.match(urls[0], /\/Entregador\?id=in\.\(1,2\)$/);
  });
});
