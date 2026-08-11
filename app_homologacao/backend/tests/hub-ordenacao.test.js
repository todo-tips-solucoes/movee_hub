'use strict';

// impeccable rodada 16 — a allowlist de ordenação.
//
// Os casos de segurança vêm primeiro de propósito: o valor validado aqui é
// interpolado na URL do PostgREST. Um teste que só cobrisse "ordena por nome"
// deixaria passar exatamente a parte perigosa.

const test = require('node:test');
const assert = require('node:assert');
const { parseOrdenacao, ordenacaoParaPostgrest } = require('../lib/hub-ordenacao');

const PERMITIDAS = ['nome', 'criado_em', 'total_linhas'];
const PADRAO = { coluna: 'criado_em', direcao: 'desc' };

test('coluna fora da allowlist cai no padrão, sem erro', () => {
  const r = parseOrdenacao({ ordenarPor: 'senha_hash', direcao: 'asc' }, PERMITIDAS, PADRAO);
  assert.deepStrictEqual(r, PADRAO);
});

test('tentativa de injeção no `order` não sobrevive', () => {
  for (const malicioso of [
    'nome.asc,id_empresa.desc',
    'nome&select=*',
    'nome.asc);--',
    '../../etc',
  ]) {
    const r = parseOrdenacao({ ordenarPor: malicioso }, PERMITIDAS, PADRAO);
    assert.strictEqual(r.coluna, PADRAO.coluna, `passou: ${malicioso}`);
  }
});

test('direção inválida cai no padrão da rota', () => {
  const r = parseOrdenacao({ ordenarPor: 'nome', direcao: 'random' }, PERMITIDAS, PADRAO);
  assert.deepStrictEqual(r, { coluna: 'nome', direcao: PADRAO.direcao });
});

test('direção sozinha NÃO inverte a ordem padrão', () => {
  // Inverter a ordem da tela sem que ninguém tenha escolhido coluna seria uma
  // mudança silenciosa de comportamento a partir de um parâmetro solto.
  const r = parseOrdenacao({ direcao: 'asc' }, PERMITIDAS, PADRAO);
  assert.deepStrictEqual(r, PADRAO);
});

test('coluna permitida + direção válida passam', () => {
  assert.deepStrictEqual(parseOrdenacao({ ordenarPor: 'nome', direcao: 'asc' }, PERMITIDAS, PADRAO), {
    coluna: 'nome',
    direcao: 'asc',
  });
  assert.deepStrictEqual(
    parseOrdenacao({ ordenarPor: 'total_linhas', direcao: 'DESC' }, PERMITIDAS, PADRAO),
    { coluna: 'total_linhas', direcao: 'desc' }
  );
});

test('query ausente ou vazia devolve o padrão', () => {
  assert.deepStrictEqual(parseOrdenacao(undefined, PERMITIDAS, PADRAO), PADRAO);
  assert.deepStrictEqual(parseOrdenacao({}, PERMITIDAS, PADRAO), PADRAO);
});

test('fragmento do PostgREST leva nullslast — ausência não encabeça o decrescente', () => {
  assert.strictEqual(
    ordenacaoParaPostgrest({ coluna: 'concluido_em', direcao: 'desc' }),
    'order=concluido_em.desc.nullslast'
  );
});
