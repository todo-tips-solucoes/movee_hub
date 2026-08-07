/**
 * Testes unitários — lib/envio-selecao.js (impeccable rodada 6, disparo por
 * seleção). Rodam com: node --test tests/envio-selecao-unit.test.js
 *
 * O que estes casos protegem: `POST /start-process` sem `ids` dispara para o
 * movimento aberto INTEIRO. Qualquer entrada malformada que o parser deixasse
 * virar "ausente" mandaria mensagem para todo o movimento em vez de para a
 * seleção do operador — o acidente exato que o disparo por seleção existe para
 * impedir. Por isso lista vazia é 400, não "todo mundo".
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseIdsSelecionados } = require('../lib/envio-selecao');

describe('parseIdsSelecionados', () => {
  test('campo ausente -> ids null (movimento inteiro, comportamento histórico)', () => {
    assert.deepEqual(parseIdsSelecionados({}), { ok: true, ids: null });
    assert.deepEqual(parseIdsSelecionados({ ids: undefined }), { ok: true, ids: null });
    assert.deepEqual(parseIdsSelecionados({ ids: null }), { ok: true, ids: null });
  });

  test('corpo ausente ou não-objeto -> ids null, sem lançar', () => {
    assert.deepEqual(parseIdsSelecionados(undefined), { ok: true, ids: null });
    assert.deepEqual(parseIdsSelecionados(null), { ok: true, ids: null });
  });

  test('lista de inteiros positivos passa intacta', () => {
    assert.deepEqual(parseIdsSelecionados({ ids: [7] }), { ok: true, ids: [7] });
    assert.deepEqual(parseIdsSelecionados({ ids: [1, 2, 3] }), { ok: true, ids: [1, 2, 3] });
  });

  test('lista VAZIA é recusada — nunca vira "movimento inteiro"', () => {
    const r = parseIdsSelecionados({ ids: [] });
    assert.equal(r.ok, false);
    assert.match(r.erro, /Nenhum registro selecionado/);
    // A garantia que importa: o caminho de erro não devolve `ids: null`, que a
    // rota interpretaria como "dispare para todos".
    assert.equal(r.ids, undefined);
  });

  test('não-array é recusado', () => {
    for (const valor of ['1,2,3', 42, {}, true]) {
      const r = parseIdsSelecionados({ ids: valor });
      assert.equal(r.ok, false, `deveria recusar ${JSON.stringify(valor)}`);
      assert.equal(r.ids, undefined);
    }
  });

  test('item não-inteiro, negativo, zero ou injeção de string é recusado', () => {
    for (const valor of [[1, '2'], [1, 2.5], [-1], [0], [1, null], ['1); DROP TABLE'], [NaN], [Infinity]]) {
      const r = parseIdsSelecionados({ ids: valor });
      assert.equal(r.ok, false, `deveria recusar ${JSON.stringify(valor)}`);
      assert.equal(r.ids, undefined);
    }
  });
});
