/**
 * Testes do postgrest-guard. Rodam com: node --test infra/producao/postgrest-guard.test.js
 *
 * As duas falhas silenciosas de um alarme: não avisar quando devia, e avisar
 * tanto que ninguém lê. As linhas de log abaixo são cópias reais do incidente
 * de 2026-11-20 e da queda crônica do LISTEN (que NÃO pode disparar).
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { analisarLog, situacaoDe, deveAvisar, corpoDoAlerta } = require('./postgrest-guard');

const H = 3600 * 1000;
const AGORA = new Date('2026-11-20T16:00:00Z').getTime();

const PGRST003 = '20/Nov/2026:14:38:41 +0000: {"code":"PGRST003","details":null,"hint":null,"message":"Timed out acquiring connection from connection pool."}';
const PGRST002 = '20/Nov/2026:16:14:33 +0000: {"code":"PGRST002","details":null,"hint":null,"message":"Could not query the database for the schema cache. Retrying."}';
const LISTEN_CAI = [
  '20/Nov/2026:13:09:54 +0000: Failed listening for database notifications on the "pgrst" channel. server closed the connection unexpectedly',
  '20/Nov/2026:13:09:54 +0000: Retrying listening for database notifications in 1 seconds...',
  '20/Nov/2026:13:09:55 +0000: Listening for database notifications on the "pgrst" channel',
  '20/Nov/2026:13:09:55 +0000: Connection Pool initialized with a maximum size of 10 connections',
  '20/Nov/2026:13:09:55 +0000: Schema cache loaded in 0.6 milliseconds',
].join('\n');
const ACESSO_503 = '10.0.5.7 - authenticated [20/Nov/2026:16:14:31 +0000] "POST /rpc/hub_adiantamento_processar HTTP/1.1" 503 119 "" "node"';

describe('analisarLog', () => {
  test('conta PGRST000–003 por código e guarda 1ª/última', () => {
    const a = analisarLog([PGRST003, ACESSO_503, PGRST002, PGRST003].join('\n'));
    assert.equal(a.total, 3);
    assert.deepEqual(a.porCodigo, { PGRST003: 2, PGRST002: 1 });
    assert.equal(a.primeira, PGRST003);
    assert.equal(a.ultima, PGRST003);
  });

  test('a queda crônica do LISTEN (a cada ~2h) não conta como erro', () => {
    assert.equal(analisarLog(LISTEN_CAI).total, 0);
  });

  test('a linha de acesso 503 não é contada em dobro', () => {
    assert.equal(analisarLog(ACESSO_503).total, 0);
  });

  test('erros de outras famílias (PGRST1xx/2xx, de requisição) não contam', () => {
    assert.equal(analisarLog('{"code":"PGRST116","message":"JSON object requested"}\n{"code":"PGRST204"}').total, 0);
  });
});

describe('situacaoDe', () => {
  const muitos = analisarLog(Array(5).fill(PGRST003).join('\n'));
  test('sem container rodando é ausente', () => assert.equal(situacaoDe('', muitos, 5), 'ausente'));
  test('no limiar é fora', () => assert.equal(situacaoDe('abc', muitos, 5), 'fora'));
  test('abaixo do limiar (blip de reconexão) é ok', () => {
    assert.equal(situacaoDe('abc', analisarLog([PGRST002, PGRST002].join('\n')), 5), 'ok');
  });
});

describe('deveAvisar', () => {
  const ok = { situacao: 'ok', avisadoEm: null };
  const foraHa = (h) => ({ situacao: 'fora', avisadoEm: new Date(AGORA - h * H).toISOString() });

  test('ok continuando ok: silêncio', () => assert.equal(deveAvisar('ok', ok, AGORA, 1), false));
  test('entrou em falha: avisa', () => assert.equal(deveAvisar('fora', ok, AGORA, 1), true));
  test('segue fora, avisado há 10 min: suprime', () => assert.equal(deveAvisar('fora', foraHa(1 / 6), AGORA, 1), false));
  test('segue fora há mais que o reaviso: reavisa', () => assert.equal(deveAvisar('fora', foraHa(1.1), AGORA, 1), true));
  test('trocou de falha (fora → ausente): avisa', () => assert.equal(deveAvisar('ausente', foraHa(0.1), AGORA, 1), true));
  test('normalizou: avisa que voltou', () => assert.equal(deveAvisar('ok', foraHa(0.5), AGORA, 1), true));
  test('estado sem carimbo: avisa', () => assert.equal(deveAvisar('fora', { situacao: 'fora', avisadoEm: null }, AGORA, 1), true));
});

describe('corpoDoAlerta', () => {
  test('falha traz a contagem, o diagnóstico e o comando de correção', () => {
    const c = corpoDoAlerta('fora', analisarLog([PGRST003, PGRST002].join('\n')), { situacao: 'ok' });
    assert.match(c, /PGRST003=1/);
    assert.match(c, /docker service update --force pgadmin_postgrest/);
    assert.match(c, /autorização/);
  });

  test('normalização diz desde quando estava fora', () => {
    const c = corpoDoAlerta('ok', analisarLog(''), { situacao: 'fora', desde: '2026-11-20T14:40:00.000Z' });
    assert.match(c, /voltou a responder/);
    assert.match(c, /2026-11-20T14:40/);
  });
});
