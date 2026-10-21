'use strict';
// Smoke HTTP real de GET /bancos: router verdadeiro, sem mock da busca.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { router } = require('../routes/motorista-adiantamento');

let server;
let base;
test.before(async () => {
  const app = express();
  app.use(router);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((r) => server.close(r)));

const get = async (qs) => {
  const res = await fetch(`${base}/bancos${qs}`);
  return { status: res.status, itens: (await res.json()).itens };
};
const q = (t) => get(`?q=${encodeURIComponent(t)}`);

// PROVAS (falham contra a rota antiga)
test('nubank -> 260', async () => {
  assert.ok((await q('nubank')).itens.some((b) => b.codigo === '260'));
});
test('itau -> 341 antes de 479', async () => {
  const c = (await q('itau')).itens.map((b) => b.codigo);
  assert.ok(c.includes('341') && c.indexOf('341') < c.indexOf('479'));
});
test('nu -> 260 em 1o', async () => {
  assert.equal((await q('nu')).itens[0].codigo, '260');
});

// GUARDAS de nao-regressao
test('mercado pago -> 323', async () => {
  assert.ok((await q('mercado pago')).itens.some((b) => b.codigo === '323'));
});
test('260 -> item exato', async () => {
  const { itens } = await q('260');
  assert.equal(itens.length, 1);
  assert.deepEqual(Object.keys(itens[0]).sort(), ['codigo', 'nome']);
  assert.equal(itens[0].codigo, '260');
});
test('banco -> 20 itens com a substring', async () => {
  const { itens } = await q('banco');
  assert.equal(itens.length, 20);
  assert.ok(itens.every((b) => b.nome.toLowerCase().includes('banco')));
});
test('vazio -> 20 itens', async () => {
  assert.equal((await q('')).itens.length, 20);
});
// PROVA (a rota antiga devolve 0 itens): acento solto U+00B4 nao filtra nada
test('acento solto -> 20 itens', async () => {
  assert.equal((await q('´')).itens.length, 20);
});

// Bordas HTTP
test('q repetido, objeto e chaves hostis nao dao 500', async () => {
  for (const qs of ['?q=a&q=b', '?q[x]=1', '?q=constructor', '?q=__proto__']) {
    const r = await get(qs);
    assert.equal(r.status, 200, qs);
    assert.ok(Array.isArray(r.itens));
    r.itens.forEach((b) => assert.deepEqual(Object.keys(b).sort(), ['codigo', 'nome']));
  }
});
