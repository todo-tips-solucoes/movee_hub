/**
 * Testes unitários — lib/hub-csv.js (hub-faturamento/S6, tasks.md 2.1/2.2).
 * Rodam com: node --test tests/hub-csv.test.js
 *
 * Porta os testes de `escaparCelulaCsvInjection`/`quotarCelulaCsv` que
 * viviam em `hub-importacoes-dto.test.js` (mesmo comportamento, agora no
 * módulo compartilhado — research.md Decision 6) e adiciona os casos que
 * fecham o gap CHK029 (célula já começa com apóstrofo ou outro caractere
 * neutro fora de `= + - @` — nenhuma neutralização adicional aplicada,
 * sem dupla neutralização).
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { escaparCelulaCsvInjection, quotarCelulaCsv } = require('../lib/hub-csv');

describe('escaparCelulaCsvInjection (FR-016/CHK017, FR-007 hub-faturamento)', () => {
  test('prefixa aspas simples em células iniciadas por = + - @', () => {
    assert.equal(escaparCelulaCsvInjection('=1+1'), "'=1+1");
    assert.equal(escaparCelulaCsvInjection('+1+1'), "'+1+1");
    assert.equal(escaparCelulaCsvInjection('-1+1'), "'-1+1");
    assert.equal(escaparCelulaCsvInjection('@SUM(A1)'), "'@SUM(A1)");
  });

  test('células normais passam intactas', () => {
    assert.equal(escaparCelulaCsvInjection('cnpj'), 'cnpj');
    assert.equal(escaparCelulaCsvInjection('formato_invalido'), 'formato_invalido');
  });

  test('null/undefined/vazio -> string vazia, sem lançar', () => {
    assert.equal(escaparCelulaCsvInjection(null), '');
    assert.equal(escaparCelulaCsvInjection(undefined), '');
    assert.equal(escaparCelulaCsvInjection(''), '');
  });

  // CHK029 (gap fechado — tasks.md 2.2.1/2.2.2): célula já neutra por
  // apóstrofo ou outro caractere fora do conjunto perigoso NUNCA recebe
  // neutralização adicional — a função só age sobre os 4 prefixos
  // `= + - @` por construção (PREFIXOS_PERIGOSOS), então qualquer outro
  // primeiro caractere (inclusive `'`) passa 100% inalterado.
  test('CHK029: célula já iniciada por apóstrofo — um único apóstrofo, nunca dois (sem dupla neutralização)', () => {
    assert.equal(escaparCelulaCsvInjection("'já protegida"), "'já protegida");
    assert.equal(escaparCelulaCsvInjection("'=1+1"), "'=1+1");
    // confirmação explícita: NUNCA "''..." (dupla neutralização)
    assert.ok(!escaparCelulaCsvInjection("'já protegida").startsWith("''"));
  });

  test('CHK029: célula iniciada por outro caractere neutro (fora de = + - @) — preservada tal como veio', () => {
    assert.equal(escaparCelulaCsvInjection('#hashtag'), '#hashtag');
    assert.equal(escaparCelulaCsvInjection('%percentual'), '%percentual');
    assert.equal(escaparCelulaCsvInjection('*asterisco'), '*asterisco');
    assert.equal(escaparCelulaCsvInjection('123.45'), '123.45');
    assert.equal(escaparCelulaCsvInjection('SAO PAULO - ZONA SUL'.slice(0)), 'SAO PAULO - ZONA SUL');
  });
});

describe('quotarCelulaCsv (RFC 4180)', () => {
  test('célula com vírgula é envolvida em aspas duplas', () => {
    assert.equal(quotarCelulaCsv('contém, vírgula'), '"contém, vírgula"');
  });

  test('célula com aspas duplas internas é quotada e escapada ("" )', () => {
    assert.equal(quotarCelulaCsv('a"b'), '"a""b"');
  });

  test('célula com quebra de linha (CR/LF) é quotada', () => {
    assert.equal(quotarCelulaCsv('linha1\nlinha2'), '"linha1\nlinha2"');
    assert.equal(quotarCelulaCsv('linha1\r\nlinha2'), '"linha1\r\nlinha2"');
  });

  test('célula sem caractere especial passa intacta (sem aspas)', () => {
    assert.equal(quotarCelulaCsv('SAO PAULO'), 'SAO PAULO');
    assert.equal(quotarCelulaCsv("'já protegida"), "'já protegida");
  });
});
