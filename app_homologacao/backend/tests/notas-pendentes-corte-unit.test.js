'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calcularCorte, CORTE_PADRAO } = require('../lib/notas-pendentes-corte');

test('modo data devolve a data', () => {
  assert.equal(calcularCorte({ notas_pendentes_corte_modo: 'data', notas_pendentes_corte_data: '2026-08-03' }), '2026-08-03');
});
test('modo dias: hoje (fuso São Paulo) menos N', () => {
  const l = { notas_pendentes_corte_modo: 'dias', notas_pendentes_corte_dias: 90 };
  assert.equal(calcularCorte(l, new Date('2026-10-13T15:00:00Z')), '2026-07-15');
  // 01:00 UTC de 14/10 ainda é 13/10 em São Paulo
  assert.equal(calcularCorte({ ...l, notas_pendentes_corte_dias: 1 }, new Date('2026-10-14T01:00:00Z')), '2026-10-12');
});
test('sem linha, dias/data inválidos -> padrão', () => {
  assert.equal(calcularCorte(null), CORTE_PADRAO);
  assert.equal(calcularCorte({ notas_pendentes_corte_modo: 'dias', notas_pendentes_corte_dias: 0 }), CORTE_PADRAO);
  assert.equal(calcularCorte({ notas_pendentes_corte_modo: 'data', notas_pendentes_corte_data: null }), CORTE_PADRAO);
});
