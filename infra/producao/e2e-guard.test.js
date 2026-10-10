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

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { placarDe, flakyDoRelatorio, corpoDoAlerta } = require('./e2e-guard');

describe('placarDe', () => {
  test('lê o placar verde do Playwright', () => {
    assert.deepEqual(placarDe('  139 passed (3.7m)\n'), { passed: 139, failed: 0, flaky: 0 });
  });

  test('lê passed e failed juntos', () => {
    assert.deepEqual(placarDe('  4 failed\n  135 passed (5.1m)\n'), { passed: 135, failed: 4, flaky: 0 });
  });

  test('log SEM placar devolve null — nunca "0 falhas"', () => {
    // O driver morre antes de testar em vários pontos reais: build do frontend,
    // seeds, ambiente fora, rito anti-starvation. Se isso virasse `failed: 0`,
    // o guard marcaria o commit como testado e a próxima execução nem tentaria.
    assert.equal(placarDe('=== rito anti-starvation: OK ===\nFAIL: build do backend\n'), null);
    assert.equal(placarDe(''), null);
  });

  test('só failed, sem passed, continua sendo falha', () => {
    assert.deepEqual(placarDe('  6 failed\n'), { passed: 0, failed: 6, flaky: 0 });
  });

  // --- flaky: o sinal que o gate não tinha (2026-10-10) ------------------
  test('lê flaky separado de failed — é a distinção que devolve sentido ao gate', () => {
    assert.deepEqual(placarDe('  2 flaky\n  140 passed (3.8m)\n'), {
      passed: 140, failed: 0, flaky: 2,
    });
  });

  test('flaky e failed convivem: um é ruído, o outro é regressão', () => {
    assert.deepEqual(placarDe('  1 failed\n  3 flaky\n  138 passed\n'), {
      passed: 138, failed: 1, flaky: 3,
    });
  });

  test('log com SÓ flaky ainda é placar — não pode virar null', () => {
    // Um relatório em que tudo passou na retentativa é resultado legítimo; se
    // devolvesse null, o guard trataria como "driver morreu" e repetiria a
    // suíte inteira sem motivo.
    assert.deepEqual(placarDe('  5 flaky\n'), { passed: 0, failed: 0, flaky: 5 });
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

  test('com retries ligados, o corpo diz que failed JÁ é regressão', () => {
    // Antes dos retries (2026-10-10) este corpo pedia para repetir antes de
    // acusar — com 2 retries por teste, quem chega aqui já caiu 3 vezes, e
    // repetir a leitura como "talvez flake" faria o leitor descartar uma
    // regressão de verdade.
    const c = corpoDoAlerta({ sha: 'abc1234', placar: { passed: 141, failed: 1, flaky: 0 }, trecho: '' });
    assert.match(c, /142 passed/); // a baseline nova, para comparar
    assert.match(c, /três vezes seguidas/);
    assert.match(c, /trate como regressão/);
    // E tem de apontar onde o flake aparece agora, senão o leitor procura no
    // lugar errado.
    assert.match(c, /E2E_GUARD_FLAKY_MAX/);
  });
});

describe('flakyDoRelatorio', () => {
  function comArquivo(conteudo) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-guard-'));
    const arquivo = path.join(dir, '.report.json');
    fs.writeFileSync(arquivo, conteudo);
    return arquivo;
  }

  const RELATORIO = (specs) => JSON.stringify({
    suites: [{ file: 'tests/e2e-hub-browser/x.spec.ts', specs, suites: [] }],
  });

  test('relatório ausente devolve null — NUNCA lista vazia', () => {
    // A asserção que importa: lista vazia significaria "zero flaky", e o guard
    // reportaria ambiente saudável justamente quando perdeu a medição.
    assert.equal(flakyDoRelatorio('/caminho/que/nao/existe/.report.json'), null);
  });

  test('JSON corrompido também devolve null, não lista vazia', () => {
    assert.equal(flakyDoRelatorio(comArquivo('{ isto não é json')), null);
  });

  test('lista os testes flaky com arquivo, linha e título', () => {
    const arquivo = comArquivo(RELATORIO([
      { line: 21, title: 'o primeiro Tab é o skip link', tests: [{ status: 'flaky' }] },
      { line: 44, title: 'segue verde', tests: [{ status: 'expected' }] },
    ]));
    assert.deepEqual(flakyDoRelatorio(arquivo), [
      'tests/e2e-hub-browser/x.spec.ts:21 › o primeiro Tab é o skip link',
    ]);
  });

  test('suíte toda verde devolve lista VAZIA — distinta de null', () => {
    // Vazio e null dizem coisas diferentes: "medi e não houve" contra "não
    // consegui medir". Confundir os dois é como o gate ficou cego.
    const arquivo = comArquivo(RELATORIO([
      { line: 10, title: 'ok', tests: [{ status: 'expected' }] },
    ]));
    assert.deepEqual(flakyDoRelatorio(arquivo), []);
  });

  test('alcança specs em suítes aninhadas', () => {
    const arquivo = comArquivo(JSON.stringify({
      suites: [{
        file: 'tests/e2e-hub-browser/y.spec.ts',
        specs: [],
        suites: [{
          file: 'tests/e2e-hub-browser/y.spec.ts',
          specs: [{ line: 7, title: 'fundo', tests: [{ status: 'flaky' }] }],
          suites: [],
        }],
      }],
    }));
    assert.deepEqual(flakyDoRelatorio(arquivo), ['tests/e2e-hub-browser/y.spec.ts:7 › fundo']);
  });
});
