/**
 * Testes unitários — lib/hub-push-worker.js (tasks.md FASE 5, 5.1.5/5.4.2).
 * Rodam com: node --test tests/hub-push-worker-unit.test.js
 *
 * 100% com deps injetadas (mesmo padrão de lib/hub-import-processor.js) —
 * NUNCA chama o PostgREST real nem o serviço de push real. `enviarPush`/
 * `gerarDetalhesRequisicao` são substituídos por dublês em memória; a chave
 * VAPID de teste é gerada em memória (mesmo algoritmo de gen-vapid.sh),
 * nunca lida de /var/lib/hub_secrets.
 *
 * Cobre as transições de `AvisoEntrega` (data-model.md §State Transitions):
 * `pendente→processando→aceito`, `→morta` (404/410), `→falha/rejeitada`
 * (erro local e 4xx sem retry), `→falha/transitoria_esgotada` (3 tentativas),
 * `→falha/envio_bloqueado` (allowlist). As transições `→falha/interrompida`,
 * `→falha/inscricao_indisponivel` e `→falha/chave_substituida` acontecem
 * INTEIRAMENTE dentro de `hub_push_reivindicar` (SQL, migration 0061) — o
 * worker só consome o que a função devolve; os testes aqui confirmam que o
 * worker delega (chama reivindicar com os parâmetros certos e processa
 * exatamente as linhas devolvidas, sem lógica própria que duplique/reverta
 * essas transições).
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const worker = require('../lib/hub-push-worker');
const {
  processarAviso,
  processarEntrega,
  retomarAvisosPendentes,
  registrarChaveVapid,
  executarExpurgo,
  iniciarExpurgoPeriodico,
  classificarErroEnvio,
  executarComPool,
  _resetParaTeste,
  LOTE_LIMITE,
  LEASE_SEGUNDOS,
  EXPURGO_INTERVALO_MS,
} = worker;

function gerarChaveTeste(overrides) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const privJwk = privateKey.export({ format: 'jwk' });
  const x = Buffer.from(pubJwk.x, 'base64url');
  const y = Buffer.from(pubJwk.y, 'base64url');
  const chavePublica = Buffer.concat([Buffer.from([0x04]), x, y]).toString('base64url');
  const chavePrivada = Buffer.from(privJwk.d, 'base64url').toString('base64url');
  const keyId = crypto.createHash('sha256').update(chavePublica).digest('hex').slice(0, 16);
  return Object.assign(
    { chavePublica, chavePrivada, keyId, geradoPor: 'teste', geradoEm: new Date().toISOString(), subject: 'mailto:teste@example.com' },
    overrides,
  );
}

function criarDepsBase(overrides) {
  const chamadas = [];
  const deps = {
    hubPostgrestRequest: async (...args) => { chamadas.push(args); return []; },
    registrarAuditoria: async () => {},
    carregarArquivoChave: () => ({ ok: true, chave: gerarChaveTeste() }),
    carregarAllowlist: () => ['fcm.googleapis.com'],
    hostPermitido: (hostname, allowlist) => allowlist.some((h) => hostname === h || hostname.endsWith(`.${h}`)),
    enviarPush: async () => ({ statusCode: 201 }),
    gerarDetalhesRequisicao: () => ({}),
    endpointHash: (e) => crypto.createHash('sha256').update(String(e)).digest('hex'),
    logErro: () => {},
    logInfo: () => {},
    gerarLeaseToken: () => 'lease-teste-fixo',
    esperar: async () => {},
    agendarIntervalo: () => 'handle-fake',
  };
  Object.assign(deps, overrides);
  deps._chamadas = chamadas;
  return deps;
}

beforeEach(() => { _resetParaTeste(); });
afterEach(() => { _resetParaTeste(); });

describe('classificarErroEnvio (tasks 5.1.2)', () => {
  test('404 -> morta, sem retry', () => {
    assert.deepEqual(classificarErroEnvio({ statusCode: 404 }), { status: 'morta', motivo: null, retry: false });
  });
  test('410 -> morta, sem retry', () => {
    assert.deepEqual(classificarErroEnvio({ statusCode: 410 }), { status: 'morta', motivo: null, retry: false });
  });
  test('400 -> falha/rejeitada, sem retry', () => {
    assert.deepEqual(classificarErroEnvio({ statusCode: 400 }), { status: 'falha', motivo: 'rejeitada', retry: false });
  });
  test('403 -> falha/rejeitada, sem retry', () => {
    assert.deepEqual(classificarErroEnvio({ statusCode: 403 }), { status: 'falha', motivo: 'rejeitada', retry: false });
  });
  test('429 -> falha/rejeitada (4xx), sem retry', () => {
    assert.deepEqual(classificarErroEnvio({ statusCode: 429 }), { status: 'falha', motivo: 'rejeitada', retry: false });
  });
  test('500 -> falha transitória, retry=true', () => {
    assert.deepEqual(classificarErroEnvio({ statusCode: 500 }), { status: 'falha', motivo: null, retry: true });
  });
  test('503 -> falha transitória, retry=true', () => {
    assert.deepEqual(classificarErroEnvio({ statusCode: 503 }), { status: 'falha', motivo: null, retry: true });
  });
  test('erro de rede sem statusCode -> falha transitória, retry=true', () => {
    assert.deepEqual(classificarErroEnvio(new Error('ECONNREFUSED')), { status: 'falha', motivo: null, retry: true });
  });
});

describe('processarEntrega — ciclo pendente->processando->{aceito|morta|falha} (5.1.1-5.1.3)', () => {
  const linha = { entrega_id: 1, endpoint: 'https://fcm.googleapis.com/x/y', p256dh: 'p', auth: 'a' };

  test('2xx -> registrarResultado com status=aceito, tentativas=1', async () => {
    const registros = [];
    const deps = criarDepsBase({
      hubPostgrestRequest: async (endpoint, method, body) => {
        if (endpoint === 'rpc/hub_push_registrar_resultado') registros.push(body);
        return [];
      },
      enviarPush: async () => ({ statusCode: 201 }),
    });
    await processarEntrega(linha, { leaseToken: 'lt', chave: gerarChaveTeste(), payload: { avisoId: 1, titulo: 't', corpo: 'c' } }, deps);
    assert.equal(registros.length, 1);
    assert.equal(registros[0].p_status, 'aceito');
    assert.equal(registros[0].p_tentativas, 1);
    assert.equal(registros[0].p_motivo, null);
  });

  test('erro local (gerarDetalhesRequisicao lança) -> falha/rejeitada, tentativas=0, enviarPush NUNCA chamado', async () => {
    const registros = [];
    let enviarPushChamado = false;
    const deps = criarDepsBase({
      hubPostgrestRequest: async (endpoint, method, body) => { if (endpoint === 'rpc/hub_push_registrar_resultado') registros.push(body); return []; },
      gerarDetalhesRequisicao: () => { throw new Error('endpoint malformado'); },
      enviarPush: async () => { enviarPushChamado = true; return { statusCode: 201 }; },
    });
    await processarEntrega(linha, { leaseToken: 'lt', chave: gerarChaveTeste(), payload: {} }, deps);
    assert.equal(enviarPushChamado, false);
    assert.equal(registros[0].p_status, 'falha');
    assert.equal(registros[0].p_motivo, 'rejeitada');
    assert.equal(registros[0].p_tentativas, 0);
  });

  test('404 -> registrarResultado com status=morta', async () => {
    const registros = [];
    const deps = criarDepsBase({
      hubPostgrestRequest: async (endpoint, method, body) => { if (endpoint === 'rpc/hub_push_registrar_resultado') registros.push(body); return []; },
      enviarPush: async () => { const e = new Error('gone'); e.statusCode = 404; throw e; },
    });
    await processarEntrega(linha, { leaseToken: 'lt', chave: gerarChaveTeste(), payload: {} }, deps);
    assert.equal(registros[0].p_status, 'morta');
    assert.equal(registros[0].p_tentativas, 1);
  });

  test('410 -> registrarResultado com status=morta', async () => {
    const registros = [];
    const deps = criarDepsBase({
      hubPostgrestRequest: async (endpoint, method, body) => { if (endpoint === 'rpc/hub_push_registrar_resultado') registros.push(body); return []; },
      enviarPush: async () => { const e = new Error('gone'); e.statusCode = 410; throw e; },
    });
    await processarEntrega(linha, { leaseToken: 'lt', chave: gerarChaveTeste(), payload: {} }, deps);
    assert.equal(registros[0].p_status, 'morta');
  });

  test('400 (4xx que não é 404/410) -> falha/rejeitada, sem retry, 1 tentativa', async () => {
    const registros = [];
    let chamadasEnvio = 0;
    const deps = criarDepsBase({
      hubPostgrestRequest: async (endpoint, method, body) => { if (endpoint === 'rpc/hub_push_registrar_resultado') registros.push(body); return []; },
      enviarPush: async () => { chamadasEnvio += 1; const e = new Error('bad'); e.statusCode = 400; throw e; },
    });
    await processarEntrega(linha, { leaseToken: 'lt', chave: gerarChaveTeste(), payload: {} }, deps);
    assert.equal(chamadasEnvio, 1, '4xx não retenta');
    assert.equal(registros[0].p_status, 'falha');
    assert.equal(registros[0].p_motivo, 'rejeitada');
  });

  test('falha transitória 3x -> falha/transitoria_esgotada, 3 tentativas, esperar chamado 2x com backoff crescente', async () => {
    const registros = [];
    const esperas = [];
    let chamadasEnvio = 0;
    const deps = criarDepsBase({
      hubPostgrestRequest: async (endpoint, method, body) => { if (endpoint === 'rpc/hub_push_registrar_resultado') registros.push(body); return []; },
      enviarPush: async () => { chamadasEnvio += 1; const e = new Error('5xx'); e.statusCode = 502; throw e; },
      esperar: async (ms) => { esperas.push(ms); },
    });
    await processarEntrega(linha, { leaseToken: 'lt', chave: gerarChaveTeste(), payload: {} }, deps);
    assert.equal(chamadasEnvio, 3);
    assert.equal(registros[0].p_status, 'falha');
    assert.equal(registros[0].p_motivo, 'transitoria_esgotada');
    assert.equal(registros[0].p_tentativas, 3);
    assert.equal(esperas.length, 2);
    assert.ok(esperas[1] >= esperas[0], 'espera crescente (tasks 5.1.3)');
  });

  test('falha transitória 2x, sucesso na 3ª -> aceito, tentativas=3', async () => {
    const registros = [];
    let chamadasEnvio = 0;
    const deps = criarDepsBase({
      hubPostgrestRequest: async (endpoint, method, body) => { if (endpoint === 'rpc/hub_push_registrar_resultado') registros.push(body); return []; },
      enviarPush: async () => {
        chamadasEnvio += 1;
        if (chamadasEnvio < 3) { const e = new Error('timeout'); throw e; }
        return { statusCode: 201 };
      },
    });
    await processarEntrega(linha, { leaseToken: 'lt', chave: gerarChaveTeste(), payload: {} }, deps);
    assert.equal(chamadasEnvio, 3);
    assert.equal(registros[0].p_status, 'aceito');
    assert.equal(registros[0].p_tentativas, 3);
  });

  test('endpoint fora da allowlist -> falha/envio_bloqueado, enviarPush NUNCA chamado (S6, hub-push-endpoint.js)', async () => {
    const registros = [];
    let chamadasEnvio = 0;
    const deps = criarDepsBase({
      hubPostgrestRequest: async (endpoint, method, body) => { if (endpoint === 'rpc/hub_push_registrar_resultado') registros.push(body); return []; },
      carregarAllowlist: () => ['fcm.googleapis.com'],
      enviarPush: async () => { chamadasEnvio += 1; return { statusCode: 201 }; },
    });
    const linhaHostileHost = { entrega_id: 2, endpoint: 'https://evil.example.com/x', p256dh: 'p', auth: 'a' };
    await processarEntrega(linhaHostileHost, { leaseToken: 'lt', chave: gerarChaveTeste(), payload: {} }, deps);
    assert.equal(chamadasEnvio, 0);
    assert.equal(registros[0].p_status, 'falha');
    assert.equal(registros[0].p_motivo, 'envio_bloqueado');
  });

  test('endpoint com URL inválida -> falha/envio_bloqueado (tratado como host não permitido)', async () => {
    const registros = [];
    const deps = criarDepsBase({
      hubPostgrestRequest: async (endpoint, method, body) => { if (endpoint === 'rpc/hub_push_registrar_resultado') registros.push(body); return []; },
    });
    const linhaUrlInvalida = { entrega_id: 3, endpoint: 'não-é-uma-url', p256dh: 'p', auth: 'a' };
    await processarEntrega(linhaUrlInvalida, { leaseToken: 'lt', chave: gerarChaveTeste(), payload: {} }, deps);
    assert.equal(registros[0].p_motivo, 'envio_bloqueado');
  });

  test('registrarResultado falha (RPC indisponível) -> best-effort, não lança', async () => {
    const deps = criarDepsBase({
      hubPostgrestRequest: async (endpoint) => {
        if (endpoint === 'rpc/hub_push_registrar_resultado') throw new Error('PostgREST fora do ar');
        return [];
      },
      enviarPush: async () => ({ statusCode: 201 }),
    });
    await assert.doesNotReject(() => processarEntrega(linha, { leaseToken: 'lt', chave: gerarChaveTeste(), payload: {} }, deps));
  });
});

describe('executarComPool (5.1.4 — concorrência limitada)', () => {
  test('respeita o limite máximo de execuções simultâneas', async () => {
    let emVoo = 0;
    let picoEmVoo = 0;
    const itens = Array.from({ length: 20 }, (_, i) => i);
    await executarComPool(itens, 3, async () => {
      emVoo += 1;
      picoEmVoo = Math.max(picoEmVoo, emVoo);
      await new Promise((r) => setTimeout(r, 1));
      emVoo -= 1;
    });
    assert.ok(picoEmVoo <= 3, `pico observado: ${picoEmVoo}`);
  });

  test('processa todos os itens mesmo com fila maior que o limite', async () => {
    const processados = [];
    const itens = Array.from({ length: 17 }, (_, i) => i);
    await executarComPool(itens, 5, async (item) => { processados.push(item); });
    assert.equal(processados.length, 17);
    assert.deepEqual(processados.slice().sort((a, b) => a - b), itens);
  });
});

describe('processarAviso — 1 aviso por vez por processo (5.1.4/5.2 concorrência entre instâncias)', () => {
  test('reivindicar é chamado com lote 50, lease 120s e o key_id da chave ativa', async () => {
    const chamadasReivindicar = [];
    const deps = criarDepsBase({
      carregarArquivoChave: () => ({ ok: true, chave: gerarChaveTeste({ keyId: 'aaaaaaaaaaaaaaaa' }) }),
      hubPostgrestRequest: async (endpoint, method, body) => {
        if (endpoint === 'rpc/hub_push_reivindicar') { chamadasReivindicar.push(body); return []; }
        if (endpoint.startsWith('Aviso?id=eq.')) return [{ id: 42, titulo: 't', corpo: 'c' }];
        return [];
      },
    });
    await processarAviso(42, deps);
    assert.equal(chamadasReivindicar.length, 1);
    assert.equal(chamadasReivindicar[0].p_limite, LOTE_LIMITE);
    assert.equal(chamadasReivindicar[0].p_lease_segundos, LEASE_SEGUNDOS);
    assert.equal(chamadasReivindicar[0].p_key_id, 'aaaaaaaaaaaaaaaa');
    assert.equal(chamadasReivindicar[0].p_aviso_id, 42);
  });

  test('sem chave VAPID disponível -> não chama reivindicar, apenas loga', async () => {
    let reivindicarChamado = false;
    let logChamado = false;
    const deps = criarDepsBase({
      carregarArquivoChave: () => ({ ok: false, erro: 'arquivo_ausente' }),
      hubPostgrestRequest: async (endpoint) => { if (endpoint === 'rpc/hub_push_reivindicar') reivindicarChamado = true; return []; },
      logErro: () => { logChamado = true; },
    });
    await processarAviso(1, deps);
    assert.equal(reivindicarChamado, false);
    assert.equal(logChamado, true);
  });

  test('reivindicar retorna vazio -> não processa nada, não lança', async () => {
    const deps = criarDepsBase({
      hubPostgrestRequest: async (endpoint) => {
        if (endpoint.startsWith('Aviso?id=eq.')) return [{ id: 5, titulo: 't', corpo: 'c' }];
        return [];
      },
    });
    await assert.doesNotReject(() => processarAviso(5, deps));
  });

  test('reivindicar lança erro -> best-effort, loga e para (não propaga)', async () => {
    let logChamado = false;
    const deps = criarDepsBase({
      hubPostgrestRequest: async (endpoint) => {
        if (endpoint.startsWith('Aviso?id=eq.')) return [{ id: 6, titulo: 't', corpo: 'c' }];
        if (endpoint === 'rpc/hub_push_reivindicar') throw new Error('fora do ar');
        return [];
      },
      logErro: () => { logChamado = true; },
    });
    await assert.doesNotReject(() => processarAviso(6, deps));
    assert.equal(logChamado, true);
  });

  test('duas chamadas concorrentes processam avisos em SEQUÊNCIA (nunca 2 loops de reivindicação ativos)', async () => {
    let emProcessamento = 0;
    let picoEmProcessamento = 0;
    const ordemProcessada = [];
    const deps = criarDepsBase({
      hubPostgrestRequest: async (endpoint, method, body) => {
        if (endpoint.startsWith('Aviso?id=eq.')) {
          const id = Number(endpoint.match(/id=eq\.(\d+)/)[1]);
          return [{ id, titulo: 't', corpo: 'c' }];
        }
        if (endpoint === 'rpc/hub_push_reivindicar') {
          emProcessamento += 1;
          picoEmProcessamento = Math.max(picoEmProcessamento, emProcessamento);
          await new Promise((r) => setTimeout(r, 5));
          ordemProcessada.push(body.p_aviso_id);
          emProcessamento -= 1;
          return [];
        }
        return [];
      },
    });
    await Promise.all([processarAviso(101, deps), processarAviso(102, deps)]);
    assert.equal(picoEmProcessamento, 1, '1 aviso por vez por processo (research.md Decision 4)');
    assert.deepEqual(ordemProcessada.sort(), [101, 102]);
  });
});

describe('retomarAvisosPendentes (5.2.1 — retomada no boot, FR-018)', () => {
  test('consulta Aviso com status in.(na_fila,em_andamento) e claim hub_push_worker', async () => {
    const chamadas = [];
    const deps = criarDepsBase({
      hubPostgrestRequest: async (...args) => {
        chamadas.push(args);
        if (args[0].startsWith('Aviso?status=in.')) return [{ id: 7 }, { id: 8 }];
        return [];
      },
    });
    const r = await retomarAvisosPendentes(deps);
    assert.equal(r.totalRetomados, 2);
    const [endpoint, metodo, corpo, claims] = chamadas[0];
    assert.equal(endpoint, 'Aviso?status=in.(na_fila,em_andamento)&select=id');
    assert.equal(metodo, 'GET');
    assert.equal(corpo, null);
    assert.deepEqual(claims, { hubPushWorker: true });
  });

  test('falha na consulta -> best-effort, retorna totalRetomados=0 com erro, não lança', async () => {
    const deps = criarDepsBase({
      hubPostgrestRequest: async () => { throw new Error('PostgREST indisponível'); },
    });
    const r = await retomarAvisosPendentes(deps);
    assert.equal(r.totalRetomados, 0);
    assert.ok(r.erro);
  });

  test('sem avisos pendentes -> totalRetomados=0, sem erro', async () => {
    const deps = criarDepsBase({
      hubPostgrestRequest: async (endpoint) => (endpoint.startsWith('Aviso?status=in.') ? [] : []),
    });
    const r = await retomarAvisosPendentes(deps);
    assert.equal(r.totalRetomados, 0);
    assert.equal('erro' in r, false);
  });
});

describe('registrarChaveVapid (5.2.2 — token de worker só aqui; research.md Decision 3)', () => {
  test('primeira chave (sem PushChaveVapid anterior) -> push_chave_registrada', async () => {
    const auditorias = [];
    const inserts = [];
    const deps = criarDepsBase({
      hubPostgrestRequest: async (endpoint, method, body) => {
        if (endpoint.startsWith('PushChaveVapid?select=key_id')) return [];
        if (endpoint === 'PushChaveVapid' && method === 'POST') { inserts.push(body); return [body]; }
        return [];
      },
      registrarAuditoria: async (evento) => { auditorias.push(evento); },
    });
    const chave = gerarChaveTeste({ keyId: 'bbbbbbbbbbbbbbbb' });
    await registrarChaveVapid(chave, deps);
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].key_id, 'bbbbbbbbbbbbbbbb');
    assert.equal(auditorias.length, 1);
    assert.equal(auditorias[0].acao, 'push_chave_registrada');
    assert.equal(auditorias[0].detalhes.anteriorKeyId, null);
    // dec-123: sem esta claim o INSERT (evento global, id_empresa NULL)
    // cai fora de todo ramo de auditoria_insert_por_escopo (0009) e é
    // negado por RLS — migration 0063 abre o ramo que exige este claim.
    assert.equal(auditorias[0].claims.hubPushWorker, true);
  });

  test('chave diferente da ativa anterior -> push_chave_substituida com anteriorKeyId', async () => {
    const auditorias = [];
    const deps = criarDepsBase({
      hubPostgrestRequest: async (endpoint, method) => {
        if (endpoint.startsWith('PushChaveVapid?select=key_id')) return [{ key_id: 'chave-antiga' }];
        if (endpoint === 'PushChaveVapid' && method === 'POST') return [{}];
        return [];
      },
      registrarAuditoria: async (evento) => { auditorias.push(evento); },
    });
    const chave = gerarChaveTeste({ keyId: 'chave-nova' });
    await registrarChaveVapid(chave, deps);
    assert.equal(auditorias[0].acao, 'push_chave_substituida');
    assert.equal(auditorias[0].detalhes.anteriorKeyId, 'chave-antiga');
  });

  test('mesma chave da ativação anterior (idempotente) -> NÃO reinsere nem audita de novo', async () => {
    const auditorias = [];
    const inserts = [];
    const deps = criarDepsBase({
      hubPostgrestRequest: async (endpoint, method, body) => {
        if (endpoint.startsWith('PushChaveVapid?select=key_id')) return [{ key_id: 'mesma-chave' }];
        if (endpoint === 'PushChaveVapid' && method === 'POST') { inserts.push(body); return [body]; }
        return [];
      },
      registrarAuditoria: async (evento) => { auditorias.push(evento); },
    });
    const chave = gerarChaveTeste({ keyId: 'mesma-chave' });
    await registrarChaveVapid(chave, deps);
    assert.equal(inserts.length, 0);
    assert.equal(auditorias.length, 0);
  });
});

describe('executarExpurgo / iniciarExpurgoPeriodico (5.3.1 — expurgo automático de 90 dias, FR-030)', () => {
  test('sucesso com remoções -> retorna contagens, loga informativo', async () => {
    let logado = false;
    const deps = criarDepsBase({
      hubPostgrestRequest: async (endpoint) => (endpoint === 'rpc/hub_push_expurgo' ? [{ avisos_removidos: 1, entregas_removidas: 4 }] : []),
      logInfo: () => { logado = true; },
    });
    const r = await executarExpurgo(deps);
    assert.equal(r.avisos_removidos, 1);
    assert.equal(r.entregas_removidas, 4);
    assert.equal(logado, true);
  });

  test('RPC falha -> best-effort, retorna zeros + erro, não lança', async () => {
    const deps = criarDepsBase({
      hubPostgrestRequest: async () => { throw new Error('indisponível'); },
    });
    const r = await executarExpurgo(deps);
    assert.equal(r.avisos_removidos, 0);
    assert.ok(r.erro);
  });

  test('iniciarExpurgoPeriodico chama expurgo imediatamente e agenda a cada 24h', async () => {
    let chamadasExpurgo = 0;
    let intervaloMs = null;
    const deps = criarDepsBase({
      hubPostgrestRequest: async (endpoint) => { if (endpoint === 'rpc/hub_push_expurgo') chamadasExpurgo += 1; return []; },
      agendarIntervalo: (fn, ms) => { intervaloMs = ms; return 'handle'; },
    });
    iniciarExpurgoPeriodico(deps);
    await new Promise((r) => setTimeout(r, 5)); // deixa a chamada imediata (fire-and-forget) resolver
    assert.equal(chamadasExpurgo, 1, 'chamado 1x no boot');
    assert.equal(intervaloMs, EXPURGO_INTERVALO_MS);
    assert.equal(EXPURGO_INTERVALO_MS, 24 * 60 * 60 * 1000);
  });
});

describe('Logs sem dado sensível (5.4.1/5.4.2, FR-031) — 5 cenários capturados', () => {
  const ENDPOINT_REAL = 'https://fcm.googleapis.com/fcm/send/SEGREDO-DE-INSCRICAO-QUE-NUNCA-PODE-VAZAR';
  const P256DH_REAL = 'p256dh-super-secreto-nao-pode-vazar';
  const AUTH_REAL = 'auth-super-secreto-nao-pode-vazar';

  function capturarConsole(fn) {
    const linhas = [];
    const origErr = console.error;
    const origLog = console.log;
    console.error = (...args) => { linhas.push(args.map(String).join(' ')); };
    console.log = (...args) => { linhas.push(args.map(String).join(' ')); };
    try {
      fn();
    } finally {
      console.error = origErr;
      console.log = origLog;
    }
    return linhas.join('\n');
  }

  function semDadoSensivel(texto) {
    assert.ok(!texto.includes(ENDPOINT_REAL), 'endpoint completo vazou no log');
    assert.ok(!texto.includes(P256DH_REAL), 'p256dh vazou no log');
    assert.ok(!texto.includes(AUTH_REAL), 'auth vazou no log');
  }

  test('cenário 1 (inscrição): logErro de falha ao registrar recebe só o hash (nunca endpoint/p256dh/auth como argumento)', () => {
    const { endpointHash, logErro } = require('../lib/hub-push-log');
    const hash = endpointHash(ENDPOINT_REAL);
    // Contrato real (routes/motorista-push.js): o call-site só passa `err`
    // (erro real do PostgREST, sem subscription) e `hash` — nunca o
    // endpoint/p256dh/auth brutos. A garantia é estrutural (call-site nunca
    // recebe os campos sensíveis), não uma redação de texto livre dentro de
    // `err.message`.
    const texto = capturarConsole(() => logErro('falha ao registrar inscricao', new Error('duplicate key value violates unique constraint "PushInscricao_endpoint_hash_key"'), hash));
    semDadoSensivel(texto);
    assert.ok(texto.includes(hash.slice(0, 8)), 'deve conter só o prefixo de 8 hex');
    assert.ok(!texto.includes(hash), 'nunca o hash completo — só os 8 primeiros hex (FR-031)');
  });

  test('cenário 2 (revogação): logErro de falha ao revogar não vaza endpoint', () => {
    const { endpointHash, logErro } = require('../lib/hub-push-log');
    const hash = endpointHash(ENDPOINT_REAL);
    const texto = capturarConsole(() => logErro('falha ao revogar inscricao', new Error('qualquer'), hash));
    semDadoSensivel(texto);
  });

  test('cenário 3 (envio aceito): processarEntrega com sucesso não vaza endpoint/p256dh/auth', async () => {
    const deps = criarDepsBase({
      hubPostgrestRequest: async () => [],
      enviarPush: async () => ({ statusCode: 201 }),
    });
    const linhaReal = { entrega_id: 1, endpoint: ENDPOINT_REAL, p256dh: P256DH_REAL, auth: AUTH_REAL };
    const texto = capturarConsole(() => {});
    let capturado = '';
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a) => { capturado += a.map(String).join(' '); };
    console.error = (...a) => { capturado += a.map(String).join(' '); };
    try {
      await processarEntrega(linhaReal, { leaseToken: 'lt', chave: gerarChaveTeste(), payload: {} }, Object.assign(deps, {
        logInfo: (...a) => { capturado += a.map(String).join(' '); },
        logErro: (...a) => { capturado += a.map(String).join(' '); },
      }));
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    semDadoSensivel(texto + capturado);
  });

  test('cenário 4 (envio falho): processarEntrega com erro transitório esgotado não vaza endpoint/p256dh/auth no log', async () => {
    let capturado = '';
    const deps = criarDepsBase({
      hubPostgrestRequest: async () => [],
      enviarPush: async () => { const e = new Error('5xx'); e.statusCode = 500; throw e; },
      esperar: async () => {},
      logErro: (contexto, err, hash) => { capturado += `${contexto} ${hash} ${err && err.message}`; },
    });
    const linhaReal = { entrega_id: 2, endpoint: ENDPOINT_REAL, p256dh: P256DH_REAL, auth: AUTH_REAL };
    await processarEntrega(linhaReal, { leaseToken: 'lt', chave: gerarChaveTeste(), payload: {} }, deps);
    semDadoSensivel(capturado);
  });

  test('cenário 5 (rotação de chave): registrarChaveVapid nunca loga a chave privada, mesmo em falha', async () => {
    const chave = gerarChaveTeste();
    let capturado = '';
    const deps = criarDepsBase({
      hubPostgrestRequest: async () => { throw new Error('PostgREST fora do ar'); },
      logErro: (contexto, err) => { capturado += `${contexto} ${err && err.message}`; },
    });
    await registrarChaveVapid(chave, deps);
    assert.ok(!capturado.includes(chave.chavePrivada), 'chave privada NUNCA pode aparecer em log');
  });
});
