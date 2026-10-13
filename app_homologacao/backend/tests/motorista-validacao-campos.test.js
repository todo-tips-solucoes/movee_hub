/**
 * Tradução de erro_validacao -> mensagens. node --test tests/motorista-validacao-campos.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { camposInvalidosDe, FIELD_MESSAGES } = require('../lib/motorista-validacao-campos');

test('string real de produção vira as duas mensagens certas', () => {
  assert.deepEqual(camposInvalidosDe('valid_cnpj, valid_valor'), [
    { campo: 'valid_cnpj', mensagem: 'CNPJ do tomador está incorreto na nota.' },
    { campo: 'valid_valor', mensagem: 'Valor da nota não confere com o valor do movimento.' },
  ]);
});

test('sem espaço após a vírgula também funciona', () => {
  assert.deepEqual(camposInvalidosDe('valid_valor,valid_cnpj').map((c) => c.campo), ['valid_valor', 'valid_cnpj']);
});

test('código desconhecido não quebra: mensagem padrão', () => {
  assert.deepEqual(camposInvalidosDe('valid_inventado, valid_valor'), [
    { campo: 'valid_inventado', mensagem: 'Campo inválido na nota.' },
    { campo: 'valid_valor', mensagem: FIELD_MESSAGES.valid_valor },
  ]);
});

test('vazio, nulo e só vírgulas -> []', () => {
  for (const v of ['', '  ', null, undefined, ' , ,']) assert.deepEqual(camposInvalidosDe(v), []);
});

test('os 7 campos de validação têm mensagem', () => {
  assert.equal(Object.keys(FIELD_MESSAGES).length, 7);
});
