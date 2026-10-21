'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { APELIDOS_BANCOS, normalizarTermo, buscarBancos } = require('../lib/bancos-busca');
const todos = require('../lib/fixtures/bancos-compe.json').bancos;

const cods = (q) => buscarBancos(todos, q).map((b) => b.codigo);

test('marcas e acento', () => {
  assert.deepEqual(cods('nubank'), ['260']);
  assert.deepEqual(cods('itau').slice(0, 2), ['341', '479']);
  assert.deepEqual(cods('itaú'), cods('itau'));
  assert.deepEqual(cods('mercado pago'), ['323']);
  assert.deepEqual(cods('picpay').slice(0, 3), ['380', '079', '469']);
  assert.equal(cods('inter')[0], '077');
  assert.deepEqual(cods('c6').slice(0, 2), ['336', '626']);
  assert.equal(cods('nu')[0], '260');
});

test('código por prefixo e termo genérico', () => {
  assert.deepEqual(cods('260'), ['260']);
  const c60 = cods('60');
  assert.deepEqual(c60.slice(0, 2), ['604', '600']);
  assert.ok(!c60.includes('260'));
  const b = buscarBancos(todos, 'banco');
  assert.equal(b.length, 20);
  assert.ok(b.every((x) => x.nome.toLowerCase().includes('banco')));
});

test('vazio, espaços e robustez', () => {
  for (const q of ['', '   ', '´', undefined, null]) assert.equal(buscarBancos(todos, q).length, 20);
  assert.deepEqual(cods('mercado  pago'), cods('mercado pago'));
  const longo = 'nubank' + 'x'.repeat(194);
  assert.doesNotThrow(() => buscarBancos(todos, longo));
  assert.equal(normalizarTermo('a'.repeat(200)).length, 60);
});

test('termos hostis ao mapa não lançam', () => {
  for (const q of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const r = buscarBancos(todos, q);
    assert.ok(Array.isArray(r));
  }
});

test('invariantes do mapa e reuso', () => {
  const existentes = new Set(todos.map((b) => b.codigo));
  for (const [k, v] of Object.entries(APELIDOS_BANCOS)) {
    assert.equal(normalizarTermo(k), k);
    v.forEach((c) => assert.ok(existentes.has(c), c));
  }
  assert.match(fs.readFileSync(require.resolve('../lib/bancos-busca'), 'utf8'), /require\('\.\/hub-motoristas-dto'\)/);
});

test('dedup e fidelidade à fixture (FR-003)', () => {
  const r = buscarBancos(todos, 'itau');
  assert.equal(new Set(r.map((b) => b.codigo)).size, r.length);
  r.forEach((b) => assert.equal(b, todos.find((x) => x.codigo === b.codigo)));
});
