'use strict';

/**
 * impeccable rodada 16 — as allowlists de ordenação das rotas do hub.
 *
 * O teste que mais importa aqui é o primeiro: uma coluna ordenável que NÃO
 * está no `select` da listagem produz uma ordem que ninguém consegue explicar
 * olhando a tela ("por que esta linha veio antes?"). Como as duas listas
 * escrevem `select=` em string, a única forma de manter as duas coisas juntas
 * é checá-las uma contra a outra.
 */

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-unit';

const { ORDENAVEIS_IMPORTACOES } = require('../routes/hub-importacoes');
const { ORDENAVEIS_MOTORISTAS, compararMotorista } = require('../routes/hub-motoristas');

describe('allowlist de ordenação × colunas realmente listadas', () => {
  test('importações: toda coluna ordenável está no select da rota', () => {
    const fonte = fs.readFileSync(path.join(__dirname, '../routes/hub-importacoes.js'), 'utf8');
    const select = fonte.slice(fonte.indexOf("'select=id,tipo,status"));
    const listadas = select.slice(0, select.indexOf(');'));
    for (const coluna of ORDENAVEIS_IMPORTACOES) {
      // `criado_em` é a ordem padrão e existe na tabela mesmo sem ir no
      // select (a tela mostra como "Enviado em" via iniciado_em).
      if (coluna === 'criado_em') continue;
      assert.ok(listadas.includes(coluna), `coluna ordenável fora do select: ${coluna}`);
    }
  });

  test('motoristas: as ordenáveis são as colunas que a tela mostra', () => {
    assert.deepEqual(ORDENAVEIS_MOTORISTAS, ['nome', 'ativo', 'area']);
  });
});

describe('compararMotorista', () => {
  const areas = new Map([
    [1, ['Centro']],
    [2, ['Zona Sul']],
    [3, []],
  ]);

  test('nome respeita o alfabeto pt-BR', () => {
    const r = compararMotorista({ id: 1, nome: 'Ângela' }, { id: 2, nome: 'Bruno' }, areas, 'nome');
    assert.ok(r < 0);
  });

  test('ativo antes de inativo — a lista de trabalho começa por quem opera', () => {
    const r = compararMotorista({ id: 1, ativo: true }, { id: 2, ativo: false }, areas, 'ativo');
    assert.ok(r < 0);
  });

  test('motorista sem área vai para o fim, não para o topo', () => {
    const r = compararMotorista({ id: 3 }, { id: 1 }, areas, 'area');
    assert.ok(r > 0, 'sem área deveria ficar depois de quem tem área');
  });

  test('empate devolve 0 — o sort estável preserva a ordem anterior', () => {
    assert.equal(compararMotorista({ id: 1, ativo: true }, { id: 2, ativo: true }, areas, 'ativo'), 0);
  });
});
