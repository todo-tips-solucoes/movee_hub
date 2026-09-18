/**
 * Teste unitário — lib/notificacao-link.ts (tasks.md 6.5.1).
 *
 *   node --experimental-strip-types --test lib/notificacao-link.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkPermitido } from './notificacao-link.ts';

test('linkPermitido: aceita cada rota da allowlist', () => {
  assert.equal(linkPermitido('/adiantamento'), '/adiantamento');
  assert.equal(linkPermitido('/adiantamento/123'), '/adiantamento/123');
  assert.equal(linkPermitido('/conta-bancaria'), '/conta-bancaria');
  assert.equal(linkPermitido('/avisos/45'), '/avisos/45');
  assert.equal(linkPermitido('/repasse'), '/repasse');
});

test('linkPermitido: recusa null/undefined/vazio', () => {
  assert.equal(linkPermitido(null), null);
  assert.equal(linkPermitido(undefined), null);
  assert.equal(linkPermitido(''), null);
});

test('linkPermitido: recusa rota fora da allowlist (defesa em profundidade)', () => {
  assert.equal(linkPermitido('/admin'), null);
  assert.equal(linkPermitido('https://evil.example/adiantamento'), null);
  assert.equal(linkPermitido('/adiantamento/abc'), null);
  assert.equal(linkPermitido('/avisos/'), null);
});
