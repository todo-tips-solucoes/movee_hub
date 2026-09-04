'use strict';
// Throttle do backfill (pedido do operador no deploy de 2026-09-04).
// Injeta `dormir` para não esperar de verdade — o teste afere as CHAMADAS,
// não o relógio, senão ele mesmo levaria minutos.
const { test } = require('node:test');
const assert = require('node:assert');
const { processarBackfill } = require('../scripts/backfill-vinculo-motorista');

const motoristas = [
  { cnpj_prestador: '11222333000199', nome: 'SINTETICO Um' },
  { cnpj_prestador: '11222333000280', nome: 'SINTETICO Dois' },
  { cnpj_prestador: '11222333000361', nome: 'SINTETICO Tres' },
];
const vincularOk = async () => ({ status: 'vinculado' });

test('3 motoristas com intervalo => espera 2x (N-1), nunca antes do primeiro', async () => {
  const esperas = [];
  await processarBackfill(motoristas, vincularOk, {
    intervaloMs: 3000,
    dormir: async (ms) => { esperas.push(ms); },
  });
  assert.deepEqual(esperas, [3000, 3000], 'deveria esperar entre os motoristas, não antes do 1o');
});

test('intervalo 0 (default) => nenhuma espera, comportamento anterior preservado', async () => {
  const esperas = [];
  await processarBackfill(motoristas, vincularOk, {
    intervaloMs: 0,
    dormir: async (ms) => { esperas.push(ms); },
  });
  assert.equal(esperas.length, 0);
});

test('1 motorista => nenhuma espera (nao atrasa a toa)', async () => {
  const esperas = [];
  await processarBackfill([motoristas[0]], vincularOk, {
    intervaloMs: 3000,
    dormir: async (ms) => { esperas.push(ms); },
  });
  assert.equal(esperas.length, 0);
});
