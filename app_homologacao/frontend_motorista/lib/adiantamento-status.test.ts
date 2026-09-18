/**
 * Teste unitário — lib/adiantamento-status.ts (tasks.md 6.3).
 *
 *   node --experimental-strip-types --test lib/adiantamento-status.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusInfo } from './adiantamento-status.ts';

test('statusInfo: status conhecido devolve variante/rótulo mapeados', () => {
  const info = statusInfo('PAGA');
  assert.equal(info.label, 'Pago');
  assert.equal(info.variant, 'success');
});

test('statusInfo: status desconhecido cai em badge neutro com o próprio código (nunca lança)', () => {
  const info = statusInfo('ALGO_NOVO_AINDA_NAO_MAPEADO');
  assert.equal(info.label, 'ALGO_NOVO_AINDA_NAO_MAPEADO');
  assert.equal(info.variant, 'muted');
});

test('statusInfo: cobre todos os status do enum StatusAdiantamento sem cair no fallback', () => {
  const statuses = [
    'AGUARDANDO_CORTE', 'AGUARDANDO_PRODUCAO', 'LIBERADA', 'EM_LOTE',
    'EXPORTADA', 'PAGA', 'REJEITADA', 'INELEGIVEL', 'FALHOU', 'ENCERRADA',
    'CANCELADA',
  ];
  for (const s of statuses) {
    const info = statusInfo(s);
    assert.notEqual(info.label, s, `status ${s} caiu no fallback (sem mapeamento dedicado)`);
  }
});
