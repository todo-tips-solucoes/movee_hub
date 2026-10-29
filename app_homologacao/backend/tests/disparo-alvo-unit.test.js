'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { selecionarAlvoDisparo } = require('../lib/disparo-alvo');

const D = [
  { id: 1, valor: 100 }, { id: 2, valor: 0 }, { id: 3, valor: '0,00' },
  { id: 4, valor: null }, { id: 5, valor: -5 }, { id: 6, valor: '12,50' },
];

test('disparo-alvo: exclui valor <= 0, nulo e negativo (so-gorjeta nao recebe "emita NF de R$ 0,00")', () => {
  assert.deepStrictEqual(selecionarAlvoDisparo(D).map((x) => x.id), [1, 6]);
});
test('disparo-alvo: ids so RESTRINGE; id de valor 0 selecionado continua fora', () => {
  assert.deepStrictEqual(selecionarAlvoDisparo(D, [2, 6]).map((x) => x.id), [6]);
});
test('disparo-alvo: planilha com valor > 0 segue inteira (nao restringe o que serve a planilha)', () => {
  assert.strictEqual(selecionarAlvoDisparo([{ id: 1, valor: '1.234,56' }, { id: 2, valor: 0.01 }]).length, 2);
});

test('valorEmissivel: recusa 0, negativo, NaN (upload e correcao usam a mesma chave)', () => {
  const { valorEmissivel } = require('../lib/disparo-alvo');
  assert.deepStrictEqual([0, -1, NaN, 0.01, 10].map(valorEmissivel), [false, false, false, true, true]);
});

// ---------------------------------------------------------------------------
// Testes de LIGACAO (revisao adversarial 28/10). O padrao de defeito dominante
// deste projeto e "feature escrita, caminho nao ligado": o helper existe, tem
// teste, e a rota nao o chama. Os testes acima cobrem a REGRA; estes cobrem o
// FIO. Sao deliberadamente acoplados ao texto do `server.js` — se alguem mover
// a chamada, este teste cai, e e exatamente isso que se quer.
// ---------------------------------------------------------------------------
test.describe('ligacao: as regras de valor estao de fato ligadas nas rotas', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  test('o /upload condiciona a recusa a temColunaGorjeta (senao o round trip exportar->reimportar derruba a planilha)', () => {
    assert.match(server, /temColunaGorjeta && linhaSemNada\(/,
      'a validacao do /upload deve exigir a coluna presente antes de concluir "nao ha gorjeta"');
    // CONTROLE NEGATIVO de forma: a chamada CRUA (sem a guarda) nao pode mais existir no arquivo
    const cruas = server.match(/(?<!temColunaGorjeta && )linhaSemNada\(/g) || [];
    assert.equal(cruas.length, 0, `linhaSemNada chamada sem a guarda de coluna em ${cruas.length} lugar(es)`);
  });

  test('o /export-envio-massa exporta a coluna gorjeta (sem ela, a reimportacao perde a gorjeta)', () => {
    const selectExport = server.match(/EnvioMassa\?id_empresa=eq\.\$\{idEmp\}&mov_fechado=eq\.false&select=([^`']+)/);
    assert.ok(selectExport, 'nao achei o select do /export-envio-massa');
    assert.match(selectExport[1], /(^|,)gorjeta(,|$)/,
      'o export precisa trazer `gorjeta`: o operador reimporta o que exportou');
  });

  test('o /validate-xml-batch filtra valor=gt.0, igual as 4 rotas do app (5a porta)', () => {
    assert.match(server, /EnvioMassa\?mov_fechado=eq\.false&valor=gt\.0&id_empresa=eq\./,
      'sem o filtro, um erro_validacao numa linha de valor <= 0 bloqueia o lote e o motorista nao a ve');
  });

  test('o disparo usa selecionarAlvoDisparo, nao o filtro cru de selecionados', () => {
    assert.match(server, /selecionarAlvoDisparo\(/,
      'processBatchMessages deve escolher o alvo pelo helper (nao dispara nota de R$ 0,00)');
  });
});
