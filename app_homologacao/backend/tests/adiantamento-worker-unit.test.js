/**
 * Testes unitários — lib/adiantamento-worker.js (tasks.md FASE 3, 3.3.6/3.3.7).
 * Rodam com: node --test tests/adiantamento-worker-unit.test.js
 *
 * 100% com deps injetadas (mesmo padrão de lib/hub-push-worker.js) — NUNCA
 * chama o PostgREST real. Cobre:
 *   - 3.3.1/3.3.4: chamada a hub_adiantamento_processar com o claim/limite
 *     corretos e auditoria por linha do retorno;
 *   - 3.3.6 (edge #7/#23): produção zero -> INELEGIVEL audita
 *     `adiantamento.calculado`; produção ainda não chegada mantém
 *     AGUARDANDO_PRODUCAO, audita `adiantamento.aguardando_producao` e NÃO
 *     retenta dentro do mesmo tick (o próximo tick de 60s tenta de novo —
 *     isso não é um erro, CHK023);
 *   - CHK023: erro transitório de infra (5xx/rede) retenta com backoff e
 *     alerta se esgotar; erro de negócio (400) não é retentado;
 *   - 3.3.2/3.3.7: lote GERANDO há mais de 5min é cancelado pelo tick;
 *   - 3.3.3/FR-052: expurgo de arquivo de lotes antigos.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const worker = require('../lib/adiantamento-worker');
const {
  executarTick,
  processarPendentes,
  cancelarLotesOrfaos,
  expurgarArquivos,
  LIMITE_PROCESSAR,
  MINUTOS_ORFAOS,
  DIAS_EXPURGO,
  RETRY_BACKOFF_MS,
  TICK_INTERVALO_MS,
} = worker;

function criarDepsBase(overrides = {}) {
  const chamadas = [];
  const auditorias = [];
  const logs = { erro: [], info: [] };
  // `hubPostgrestRequest` é sempre envolvida por um gravador de chamadas —
  // mesmo quando o teste passa sua própria implementação (para simular
  // retorno/erro), `deps._chamadas` continua confiável.
  const hubPostgrestRequestBase = overrides.hubPostgrestRequest || (async () => []);
  const deps = {
    hubPostgrestRequest: async (...args) => {
      chamadas.push(args);
      return hubPostgrestRequestBase(...args);
    },
    registrarAuditoria: overrides.registrarAuditoria || (async (evento) => { auditorias.push(evento); }),
    esperar: overrides.esperar || (async () => {}),
    agendarIntervalo: overrides.agendarIntervalo || (() => 'handle-fake'),
    logErro: overrides.logErro || ((msg, err) => logs.erro.push([msg, err])),
    logInfo: overrides.logInfo || ((msg) => logs.info.push(msg)),
  };
  deps._chamadas = chamadas;
  deps._auditorias = auditorias;
  deps._logs = logs;
  return deps;
}

describe('lib/adiantamento-worker — processarPendentes (3.3.1/3.3.4)', () => {
  test('chama hub_adiantamento_processar com o limite e a claim do worker', async () => {
    const deps = criarDepsBase();
    await processarPendentes(deps);
    assert.equal(deps._chamadas.length, 1);
    const [endpoint, metodo, body, claims] = deps._chamadas[0];
    assert.equal(endpoint, 'rpc/hub_adiantamento_processar');
    assert.equal(metodo, 'POST');
    assert.deepEqual(body, { p_limite: LIMITE_PROCESSAR });
    assert.deepEqual(claims, { adiantamentoWorker: true });
  });

  test('edge #7: produção zero (SEM_PRODUCAO/INELEGIVEL) audita adiantamento.calculado', async () => {
    const deps = criarDepsBase({
      hubPostgrestRequest: async () => [
        { id: 301, id_empresa: 6, status_para: 'INELEGIVEL', resultado: { motivo: 'SEM_PRODUCAO' } },
      ],
    });
    await processarPendentes(deps);
    assert.equal(deps._auditorias.length, 1);
    assert.equal(deps._auditorias[0].acao, 'adiantamento.calculado');
    assert.equal(deps._auditorias[0].idEmpresa, 6);
    assert.equal(deps._auditorias[0].recursoId, 301);
    assert.equal(deps._auditorias[0].recurso, 'AdiantamentoSolicitacao');
    assert.deepEqual(deps._auditorias[0].claims, { adiantamentoWorker: true });
  });

  test('LIBERADA também audita adiantamento.calculado (só AGUARDANDO_PRODUCAO tem ação própria)', async () => {
    const deps = criarDepsBase({
      hubPostgrestRequest: async () => [
        { id: 309, id_empresa: 6, status_para: 'LIBERADA', resultado: { motivo: null, valorLiquido: 59.65 } },
      ],
    });
    await processarPendentes(deps);
    assert.equal(deps._auditorias[0].acao, 'adiantamento.calculado');
  });

  test('edge #23: produção ainda não chegada mantém AGUARDANDO_PRODUCAO, audita adiantamento.aguardando_producao e NÃO retenta no mesmo tick', async () => {
    const deps = criarDepsBase({
      hubPostgrestRequest: async () => [
        { id: 302, id_empresa: 6, status_para: 'AGUARDANDO_PRODUCAO', resultado: { motivo: 'PRODUCAO_INDISPONIVEL', tentativas: 3 } },
      ],
    });
    await processarPendentes(deps);
    assert.equal(deps._chamadas.length, 1, 'produção indisponível não é erro — CHK023: sem retry dentro do tick, só no próximo (60s)');
    assert.equal(deps._auditorias.length, 1);
    assert.equal(deps._auditorias[0].acao, 'adiantamento.aguardando_producao');
  });

  test('linha com resultado.erro (exceção isolada da RPC, ex.: NO_BANK_ACCOUNT) não vira auditoria — status não mudou, só loga', async () => {
    const deps = criarDepsBase({
      hubPostgrestRequest: async () => [
        { id: 303, id_empresa: 6, status_para: 'AGUARDANDO_CORTE', resultado: { erro: 'NO_BANK_ACCOUNT' } },
      ],
    });
    await processarPendentes(deps);
    assert.equal(deps._auditorias.length, 0);
    assert.equal(deps._logs.erro.length, 1);
  });

  test('lote vazio não audita nada', async () => {
    const deps = criarDepsBase({ hubPostgrestRequest: async () => [] });
    await processarPendentes(deps);
    assert.equal(deps._auditorias.length, 0);
  });

  test('falha ao registrar UMA auditoria é best-effort e não impede as demais linhas', async () => {
    let chamadaAuditoria = 0;
    const deps = criarDepsBase({
      hubPostgrestRequest: async () => [
        { id: 310, id_empresa: 6, status_para: 'INELEGIVEL', resultado: { motivo: 'SEM_PRODUCAO' } },
        { id: 311, id_empresa: 6, status_para: 'LIBERADA', resultado: { motivo: null, valorLiquido: 10 } },
      ],
      registrarAuditoria: async () => {
        chamadaAuditoria += 1;
        if (chamadaAuditoria === 1) throw new Error('postgrest fora do ar');
      },
    });
    await assert.doesNotReject(() => processarPendentes(deps));
    assert.equal(chamadaAuditoria, 2, 'a 2ª linha ainda deve ser processada mesmo com falha na 1ª');
  });
});

describe('lib/adiantamento-worker — retry de infra na chamada do tick (CHK023)', () => {
  test('erro 5xx (infra) retenta com backoff e conclui após recuperar', async () => {
    let chamada = 0;
    const esperas = [];
    const deps = criarDepsBase({
      hubPostgrestRequest: async () => {
        chamada += 1;
        if (chamada < 3) { const e = new Error('boom'); e.status = 502; throw e; }
        return [];
      },
      esperar: async (ms) => { esperas.push(ms); },
    });
    await processarPendentes(deps);
    assert.equal(chamada, 3);
    assert.deepEqual(esperas, RETRY_BACKOFF_MS);
  });

  test('erro 429 (rate limit) também é transitório e retenta', async () => {
    let chamada = 0;
    const deps = criarDepsBase({
      hubPostgrestRequest: async () => {
        chamada += 1;
        if (chamada < 2) { const e = new Error('boom'); e.status = 429; throw e; }
        return [];
      },
    });
    await processarPendentes(deps);
    assert.equal(chamada, 2);
  });

  test('erro transitório esgota as tentativas -> loga alerta e não derruba o tick (próximo tick tenta de novo)', async () => {
    const deps = criarDepsBase({
      hubPostgrestRequest: async () => { const e = new Error('boom'); e.status = 503; throw e; },
    });
    await assert.doesNotReject(() => processarPendentes(deps));
    assert.equal(deps._chamadas.length, 3, 'MAX_TENTATIVAS_PROCESSAR=3');
    assert.ok(deps._logs.erro.some(([msg]) => msg.includes('esgotada')));
  });

  test('erro de negócio (400, ex.: PERMISSAO_NEGADA) NÃO é retentado — propaga imediatamente, sem confundir com "produção indisponível"', async () => {
    let chamadas = 0;
    const deps = criarDepsBase({
      hubPostgrestRequest: async () => { chamadas += 1; const e = new Error('PERMISSAO_NEGADA'); e.status = 400; throw e; },
    });
    await assert.doesNotReject(() => processarPendentes(deps));
    assert.equal(chamadas, 1, 'erro de negócio não é transitório de infra — 1 tentativa só');
  });
});

describe('lib/adiantamento-worker — lote_orfaos (3.3.2/3.3.7)', () => {
  test('chama hub_adiantamento_lote_orfaos com p_minutos e a claim do worker', async () => {
    const deps = criarDepsBase({ hubPostgrestRequest: async () => [{ id: 501, id_empresa: 6 }] });
    await cancelarLotesOrfaos(deps);
    assert.equal(deps._chamadas.length, 1);
    const [endpoint, metodo, body, claims] = deps._chamadas[0];
    assert.equal(endpoint, 'rpc/hub_adiantamento_lote_orfaos');
    assert.equal(metodo, 'POST');
    assert.deepEqual(body, { p_minutos: MINUTOS_ORFAOS });
    assert.deepEqual(claims, { adiantamentoWorker: true });
    assert.equal(deps._logs.info.length, 1, 'lote cancelado deve gerar log informativo');
  });

  test('nenhum lote órfão -> sem log', async () => {
    const deps = criarDepsBase({ hubPostgrestRequest: async () => [] });
    await cancelarLotesOrfaos(deps);
    assert.equal(deps._logs.info.length, 0);
  });

  test('falha é best-effort: não propaga, só loga (próximo tick tenta de novo)', async () => {
    const deps = criarDepsBase({ hubPostgrestRequest: async () => { throw new Error('boom'); } });
    await assert.doesNotReject(() => cancelarLotesOrfaos(deps));
    assert.equal(deps._logs.erro.length, 1);
  });
});

describe('lib/adiantamento-worker — expurgo de arquivos (3.3.3/FR-052)', () => {
  test('chama hub_adiantamento_expurgo_arquivos com p_dias e a claim do worker', async () => {
    const deps = criarDepsBase({ hubPostgrestRequest: async () => [{ id: 601, id_empresa: 6 }] });
    await expurgarArquivos(deps);
    const [endpoint, metodo, body, claims] = deps._chamadas[0];
    assert.equal(endpoint, 'rpc/hub_adiantamento_expurgo_arquivos');
    assert.equal(metodo, 'POST');
    assert.deepEqual(body, { p_dias: DIAS_EXPURGO });
    assert.deepEqual(claims, { adiantamentoWorker: true });
    assert.equal(deps._logs.info.length, 1);
  });

  test('falha é best-effort: não propaga', async () => {
    const deps = criarDepsBase({ hubPostgrestRequest: async () => { throw new Error('boom'); } });
    await assert.doesNotReject(() => expurgarArquivos(deps));
  });
});

describe('lib/adiantamento-worker — executarTick / iniciarTick', () => {
  test('executarTick roda as três etapas na ordem: processar, órfãos, expurgo', async () => {
    const ordem = [];
    const deps = criarDepsBase({
      hubPostgrestRequest: async (endpoint) => { ordem.push(endpoint); return []; },
    });
    await executarTick(deps);
    assert.deepEqual(ordem, [
      'rpc/hub_adiantamento_processar',
      'rpc/hub_adiantamento_lote_orfaos',
      'rpc/hub_adiantamento_expurgo_arquivos',
    ]);
  });

  test('uma etapa falhar não impede as seguintes (best-effort em cada uma)', async () => {
    const ordem = [];
    const deps = criarDepsBase({
      hubPostgrestRequest: async (endpoint) => {
        ordem.push(endpoint);
        if (endpoint === 'rpc/hub_adiantamento_lote_orfaos') throw new Error('boom');
        return [];
      },
    });
    await assert.doesNotReject(() => executarTick(deps));
    assert.deepEqual(ordem, [
      'rpc/hub_adiantamento_processar',
      'rpc/hub_adiantamento_lote_orfaos',
      'rpc/hub_adiantamento_expurgo_arquivos',
    ]);
  });

  test('iniciarTick roda o boot imediatamente (fire-and-forget) e agenda o intervalo de 60s', async () => {
    let intervaloFn = null;
    let intervaloMs = null;
    const deps = criarDepsBase({
      agendarIntervalo: (fn, ms) => { intervaloFn = fn; intervaloMs = ms; return 'handle-teste'; },
    });
    const handle = worker.iniciarTick(deps);
    assert.equal(handle, 'handle-teste');
    assert.equal(intervaloMs, TICK_INTERVALO_MS);
    assert.equal(typeof intervaloFn, 'function');
    // dá um turno de microtask para a promise do boot (fire-and-forget) rodar.
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.ok(deps._chamadas.length >= 1, 'o boot deve rodar o tick imediatamente, sem esperar os 60s');
  });
});
