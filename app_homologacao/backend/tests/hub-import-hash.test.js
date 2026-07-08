/**
 * Testes unitários — hub-import-hash.js (tasks.md 2.4.2, 2.4.3).
 * Rodam com: node --test tests/hub-import-hash.test.js
 *
 * Ref: research.md Decision 6 — idempotência é o requisito central (US2).
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { hashLinha, canonicalizarValor } = require('../lib/hub-import-hash');
const { CAMPOS_HASH_FATURAMENTO, normalizarLinhaFaturamento, indiceHeader, HEADER_FATURAMENTO } = require('../lib/hub-import-normalizer');

describe('hashLinha (2.4.1/2.4.2)', () => {
  test('mesma linha normalizada 2x produz hash idêntico (determinismo)', () => {
    const valores = { a: 'X', b: 10.5, c: null };
    const campos = ['a', 'b', 'c'];
    assert.equal(hashLinha(valores, campos), hashLinha(valores, campos));
    // e recomputando a partir de um objeto NOVO com o mesmo conteúdo:
    const valores2 = { a: 'X', b: 10.5, c: null };
    assert.equal(hashLinha(valores, campos), hashLinha(valores2, campos));
  });

  test('sha256 hex de 64 caracteres', () => {
    const hash = hashLinha({ a: '1' }, ['a']);
    assert.equal(hash.length, 64);
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  test('conteúdo diferente produz hash diferente', () => {
    const h1 = hashLinha({ a: '1' }, ['a']);
    const h2 = hashLinha({ a: '2' }, ['a']);
    assert.notEqual(h1, h2);
  });

  test('ordem dos campos importa (contrato de estabilidade)', () => {
    const h1 = hashLinha({ a: '1', b: '2' }, ['a', 'b']);
    const h2 = hashLinha({ a: '1', b: '2' }, ['b', 'a']);
    assert.notEqual(h1, h2);
  });
});

describe('canonicalizarValor', () => {
  test('null/undefined -> string vazia', () => {
    assert.equal(canonicalizarValor(null), '');
    assert.equal(canonicalizarValor(undefined), '');
  });

  test('texto é trim + uppercase', () => {
    assert.equal(canonicalizarValor('  fulano de tal  '), 'FULANO DE TAL');
  });

  test('número inteiro vira string sem casas decimais', () => {
    assert.equal(canonicalizarValor(10), '10');
  });

  test('número decimal vira string com 2 casas fixas', () => {
    assert.equal(canonicalizarValor(10.5), '10.50');
    assert.equal(canonicalizarValor(1234.567), '1234.57');
  });
});

describe('hashLinha aplicado a linhas normalizadas reais (2.4.3 — idempotência de reimportação)', () => {
  const IDX = indiceHeader(HEADER_FATURAMENTO);

  function linhaComOverrides(overrides) {
    const base = {
      data_do_lancamento_financeiro: '2026-07-03',
      data_do_periodo_de_referencia: '2026-07-02',
      data_do_repasse: '2026-07-08',
      periodo: 'ALMOCO',
      praca: 'SAO PAULO',
      subpraca: 'ITAQUERA',
      origem: '',
      id_da_pessoa_entregadora: 'd9752e14-1234-4abc-9def-0123456789ab',
      recebedor: 'Fulano de Tal',
      tipo: 'Credito',
      valor: '25,19',
      descricao: 'Corridas concluidas',
      atingido: '',
      percentual_de_tempo_disponivel: '',
      percentual_de_aceitacao: '',
      percentual_de_conclusao: '',
      criterio_tempo_disponivel: '',
      criterio_rotas_aceitas: '',
      criterio_rotas_concluidas: '',
      margem_fee_porcentagem: '',
    };
    const linha = { ...base, ...overrides };
    return HEADER_FATURAMENTO.map((h) => linha[h]);
  }

  test('reimportar a MESMA linha (mesmo texto bruto) produz o mesmo hash', () => {
    const { valores: v1 } = normalizarLinhaFaturamento(linhaComOverrides({}), IDX);
    const { valores: v2 } = normalizarLinhaFaturamento(linhaComOverrides({}), IDX);
    assert.equal(hashLinha(v1, CAMPOS_HASH_FATURAMENTO), hashLinha(v2, CAMPOS_HASH_FATURAMENTO));
  });

  test('linhas semanticamente iguais mas com whitespace/case de origem diferentes produzem o MESMO hash', () => {
    const { valores: v1 } = normalizarLinhaFaturamento(
      linhaComOverrides({ periodo: 'almoco', recebedor: '  Fulano de Tal  ', tipo: 'Credito' }),
      IDX
    );
    const { valores: v2 } = normalizarLinhaFaturamento(
      linhaComOverrides({ periodo: 'ALMOCO', recebedor: 'FULANO DE TAL', tipo: 'Credito' }),
      IDX
    );
    assert.equal(hashLinha(v1, CAMPOS_HASH_FATURAMENTO), hashLinha(v2, CAMPOS_HASH_FATURAMENTO));
  });

  test('decimal com formatação de origem diferente (mesmo valor semântico) produz o MESMO hash', () => {
    // "25,19" e "25,190" (zero à direita) representam o mesmo número —
    // normalizarDecimalVirgula converte ambos para o mesmo float, e
    // canonicalizarValor fixa 2 casas decimais no hash.
    const { valores: v1 } = normalizarLinhaFaturamento(linhaComOverrides({ valor: '25,19' }), IDX);
    const { valores: v2 } = normalizarLinhaFaturamento(linhaComOverrides({ valor: '25,190' }), IDX);
    assert.equal(hashLinha(v1, CAMPOS_HASH_FATURAMENTO), hashLinha(v2, CAMPOS_HASH_FATURAMENTO));
  });

  test('linha genuinamente diferente (valor distinto) produz hash diferente', () => {
    const { valores: v1 } = normalizarLinhaFaturamento(linhaComOverrides({ valor: '25,19' }), IDX);
    const { valores: v2 } = normalizarLinhaFaturamento(linhaComOverrides({ valor: '99,99' }), IDX);
    assert.notEqual(hashLinha(v1, CAMPOS_HASH_FATURAMENTO), hashLinha(v2, CAMPOS_HASH_FATURAMENTO));
  });
});
