'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lerCategorias } = require('../lib/categorias-tokens');
const { validarListasCategorias } = require('../lib/adiantamento-dto');

const M = { permiteModo: true };
const casos = [
  // [entrada, opções, esperado (null = inválida)]
  [['modo:todas'], M, ['modo:todas']],
  [['modo:todas'], {}, null],
  [['modo:todas', 'modo:todas', 'Gorjeta'], M, ['modo:todas', 'Gorjeta']],
  [['modo:todos'], M, null],
  [['modo:'], M, null],
  [['familia:promocao', 'familia:missoes', 'familia:indicador'], {}, ['familia:promocao', 'familia:missoes', 'familia:indicador']],
  [['familia:outra'], M, null],
  [['familia:'], M, null],
  [['Frete', ' Frete'], {}, ['Frete', ' Frete']],
  [[''], {}, null],
  [['x'.repeat(201)], {}, null],
  [[1], {}, null],
  [[], {}, []],
  [[], { min: 1 }, null],
  [['a', 'b'], { max: 1 }, null],
  ['x', {}, null],
  [null, {}, null],
];
for (const [entrada, opts, esperado] of casos) {
  test(`lerCategorias(${JSON.stringify(entrada)?.slice(0, 40)}, ${JSON.stringify(opts)})`, () => {
    assert.deepEqual(lerCategorias(entrada, opts), esperado);
  });
}

test('validarListasCategorias: 3 listas, campo do 1º erro, null só em extrato/nota', () => {
  const d = { categoriasProducao: ['modo:todas'], categoriasExtrato: ['modo:todas', 'modo:todas'], categoriasNota: null };
  assert.equal(validarListasCategorias(d), null);
  assert.deepEqual(d.categoriasExtrato, ['modo:todas']);
  assert.deepEqual(validarListasCategorias({ categoriasProducao: null }), { campo: 'categoriasProducao' });
  assert.deepEqual(validarListasCategorias({ categoriasNota: ['familia:x'] }), { campo: 'categoriasNota' });
  assert.equal(validarListasCategorias({}), null);
});
