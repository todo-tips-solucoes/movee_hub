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

const {
  placarDe, flakyDoRelatorio, corpoConsolidado, precisaAlarme,
  migrarEstado, lerEstado, gravarEstadoDoDriver, FLAKY_MAX,
} = require('./e2e-guard');

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

const R = (nome, over = {}) => ({
  nome, caminho: `infra/hub/testes/${nome}.sh`, ok: true,
  placar: { passed: 10, failed: 0, flaky: 0 }, flaky: [], trecho: '', ...over,
});
const FALHOU = (nome, over = {}) => R(nome, {
  ok: false, placar: { passed: 9, failed: 1, flaky: 0 }, trecho: `log-de-${nome}`, ...over,
});

describe('corpoConsolidado', () => {
  test('diz o placar e como reproduzir', () => {
    const c = corpoConsolidado({ sha: 'abc1234', resultados: [FALHOU('hub-shell', { placar: { passed: 135, failed: 4, flaky: 0 } })], quarentena: [] });
    assert.match(c, /abc1234/);
    assert.match(c, /135 passed \/ 4 failed/);
    // Reproduzir SEM rebuildar daria teste oco — o corpo tem de ensinar isso.
    assert.match(c, /build --memory=2g frontend/);
    assert.match(c, /o driver não builda/i);
  });

  test('sem placar, explica que o driver não chegou a testar', () => {
    const c = corpoConsolidado({ sha: 'abc1234', resultados: [FALHOU('hub-shell', { placar: null })], quarentena: [] });
    assert.match(c, /não chegou a produzir placar/);
    assert.doesNotMatch(c, /^Placar:/m);
  });

  test('failed já é regressão (retries ligados) e aponta onde o flake aparece', () => {
    const c = corpoConsolidado({ sha: 'abc1234', resultados: [FALHOU('hub-shell')], quarentena: [] });
    assert.match(c, /142 passed/);
    assert.match(c, /três vezes seguidas/);
    assert.match(c, /trate como regressão/);
  });

  test('consolidado: cita os que falharam (com trecho) e NÃO cita os que passaram', () => {
    const c = corpoConsolidado({
      sha: 'abc1234', quarentena: [],
      resultados: [R('verde-um'), FALHOU('hub-avisos'), R('verde-dois'), FALHOU('hub-motorista-360')],
    });
    assert.match(c, /hub-avisos/);
    assert.match(c, /log-de-hub-avisos/);
    assert.match(c, /hub-motorista-360/);
    assert.match(c, /log-de-hub-motorista-360/);
    assert.doesNotMatch(c, /verde-um/);
    assert.doesNotMatch(c, /verde-dois/);
  });

  test('quarentena: driver em quarentena vai a seção própria, não a FALHARAM', () => {
    const resultados = [FALHOU('hub-avisos'), FALHOU('motorista-push')];
    const c = corpoConsolidado({ sha: 'abc1234', resultados, quarentena: ['motorista-push'] });
    const [falharam, quarentena] = c.split('== EM QUARENTENA');
    assert.match(falharam, /hub-avisos/);
    assert.doesNotMatch(falharam, /motorista-push/);
    assert.match(quarentena, /motorista-push/);
    assert.doesNotMatch(quarentena, /hub-avisos/);
  });

  test('FLAKY_MAX por driver: só quem passa do teto entra na seção de flaky', () => {
    const c = corpoConsolidado({
      sha: 'abc1234', quarentena: [], flakyMax: 3,
      resultados: [
        R('hub-shell', { placar: { passed: 140, failed: 0, flaky: 4 } }),
        R('hub-avisos', { placar: { passed: 10, failed: 0, flaky: 3 } }),
      ],
    });
    assert.match(c, /hub-shell: 4 flaky/);
    assert.doesNotMatch(c, /hub-avisos/);
  });
});

describe('precisaAlarme', () => {
  test('tudo verde: não alarma', () => {
    assert.equal(precisaAlarme([R('a'), R('b')], []), false);
  });
  test('falha fora da quarentena alarma; dentro dela não', () => {
    assert.equal(precisaAlarme([R('a'), FALHOU('b')], []), true);
    assert.equal(precisaAlarme([R('a'), FALHOU('b')], ['b']), false);
  });
  test('flaky acima do teto alarma por driver, no teto não', () => {
    const f = (n) => R('a', { placar: { passed: 5, failed: 0, flaky: n } });
    assert.equal(precisaAlarme([f(FLAKY_MAX)], [], FLAKY_MAX), false);
    assert.equal(precisaAlarme([f(FLAKY_MAX + 1)], [], FLAKY_MAX), true);
    assert.equal(precisaAlarme([f(FLAKY_MAX + 1)], ['a'], FLAKY_MAX), false);
  });
});

describe('estado por driver', () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-guard-st-')), 'estado.json');

  test('gravar um driver não afeta os outros', () => {
    const arq = tmp();
    gravarEstadoDoDriver('hub-shell', { sha: 'aaa', resultado: 'ok' }, arq);
    gravarEstadoDoDriver('hub-avisos', { sha: 'bbb', resultado: 'falhou' }, arq);
    gravarEstadoDoDriver('hub-avisos', { sha: 'ccc', resultado: 'ok' }, arq);
    const e = lerEstado(arq);
    assert.deepEqual(e['hub-shell'], { sha: 'aaa', resultado: 'ok' });
    assert.equal(e['hub-avisos'].sha, 'ccc');
  });

  test('migração: formato antigo (um driver só) vira o estado do hub-shell, sem perder dado', () => {
    const antigo = { sha: 'abc1234', resultado: 'ok', placar: { passed: 142, failed: 0, flaky: 1 }, flaky: ['x'], em: '2026-10-10T08:00:00Z' };
    assert.deepEqual(migrarEstado(antigo), { 'hub-shell': antigo });
    const arq = tmp();
    fs.writeFileSync(arq, JSON.stringify(antigo));
    assert.deepEqual(lerEstado(arq), { 'hub-shell': antigo });
    // gravar outro driver por cima do arquivo antigo preserva o hub-shell
    gravarEstadoDoDriver('hub-avisos', { sha: 'zzz' }, arq);
    assert.deepEqual(lerEstado(arq)['hub-shell'], antigo);
  });

  test('formato novo passa intacto; lixo e ausência viram {}', () => {
    const novo = { 'hub-shell': { sha: 'a' }, 'hub-avisos': { sha: 'b' } };
    assert.deepEqual(migrarEstado(novo), novo);
    assert.deepEqual(migrarEstado(null), {});
    assert.deepEqual(lerEstado('/nao/existe.json'), {});
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
