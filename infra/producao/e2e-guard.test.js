/**
 * Testes do e2e-guard. Rodam com: node --test infra/producao/e2e-guard.test.js
 *
 * O foco é a leitura do PLACAR. Este guard existe porque uma dívida ficou
 * invisível por um mês; um guard que lê o placar errado recria exatamente esse
 * problema, com a agravante de parecer cobertura. O caso mais perigoso não é
 * "ler failed errado" — é **tratar log sem placar como sucesso**: o driver
 * morre antes de testar (build, seed, ambiente fora) e o guard diria "tudo ok".
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { placarDe, corpoDoAlerta } = require('./e2e-guard');

describe('placarDe', () => {
  test('lê o placar verde do Playwright', () => {
    assert.deepEqual(placarDe('  139 passed (3.7m)\n'), { passed: 139, failed: 0 });
  });

  test('lê passed e failed juntos', () => {
    assert.deepEqual(placarDe('  4 failed\n  135 passed (5.1m)\n'), { passed: 135, failed: 4 });
  });

  test('log SEM placar devolve null — nunca "0 falhas"', () => {
    // O driver morre antes de testar em vários pontos reais: build do frontend,
    // seeds, ambiente fora, rito anti-starvation. Se isso virasse `failed: 0`,
    // o guard marcaria o commit como testado e a próxima execução nem tentaria.
    assert.equal(placarDe('=== rito anti-starvation: OK ===\nFAIL: build do backend\n'), null);
    assert.equal(placarDe(''), null);
  });

  test('só failed, sem passed, continua sendo falha', () => {
    assert.deepEqual(placarDe('  6 failed\n'), { passed: 0, failed: 6 });
  });
});

describe('corpoDoAlerta', () => {
  test('diz o placar e como reproduzir', () => {
    const c = corpoDoAlerta({ sha: 'abc1234', placar: { passed: 135, failed: 4 }, trecho: '' });
    assert.match(c, /abc1234/);
    assert.match(c, /135 passed \/ 4 failed/);
    // Reproduzir SEM rebuildar daria teste oco — o corpo tem de ensinar isso,
    // senão quem for investigar cai na mesma armadilha do driver não buildar.
    assert.match(c, /build --memory=2g frontend/);
    assert.match(c, /o driver não builda/i);
  });

  test('sem placar, explica que o driver não chegou a testar', () => {
    const c = corpoDoAlerta({ sha: 'abc1234', placar: null, trecho: '' });
    assert.match(c, /não chegou a produzir placar/);
    // Não pode AFIRMAR um placar desta execução. `/0 failed/` sozinho não
    // serve: a linha da baseline ("139 passed / 0 failed") casa com ele — foi
    // o que esta asserção pegou quando estava frouxa demais.
    assert.doesNotMatch(c, /^Placar:/m);
  });

  test('lembra do flake conhecido — falha isolada não é regressão', () => {
    const c = corpoDoAlerta({ sha: 'abc1234', placar: { passed: 138, failed: 1 }, trecho: '' });
    assert.match(c, /flake/i);
    assert.match(c, /139 passed/); // a baseline, para comparar
  });
});
