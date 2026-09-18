/**
 * Teste unitário — lib/repasse-estado.ts (tasks.md 6.6.3).
 *
 *   node --experimental-strip-types --test lib/repasse-estado.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classificarErroRepasse } from './repasse-estado.ts';
import { ApiError } from './api-client.ts';

test('classificarErroRepasse: 404 NAO_DISPONIVEL (configuração desligada) não renderiza a tela', () => {
  const erro = new ApiError('Essa informação não está disponível no momento.', 404, 'NAO_DISPONIVEL');
  assert.equal(classificarErroRepasse(erro), 'indisponivel');
});

test('classificarErroRepasse: 502/infra mantém o estado de erro (com "tentar de novo")', () => {
  const erro = new ApiError('Serviço indisponível', 502, 'INDISPONIVEL');
  assert.equal(classificarErroRepasse(erro), 'erro');
});

test('classificarErroRepasse: erro não-ApiError (ex.: timeout de rede) cai em "erro"', () => {
  assert.equal(classificarErroRepasse(new Error('network')), 'erro');
});
