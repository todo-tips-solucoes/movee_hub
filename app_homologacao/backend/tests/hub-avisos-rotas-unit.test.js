/**
 * Testes unitários — routes/hub-avisos.js (push-motorista, FASE 4 —
 * tasks.md 4.1.6/4.1.7/4.2.6/4.2.7/4.3.3). Rodam com:
 * node --test tests/hub-avisos-rotas-unit.test.js
 *
 * Mesma técnica de tests/hub-motoristas-entrego-enriquecimento-unit.test.js:
 * express real + node:http + app.listen(0), accessToken JWT REAL verificado
 * por lib/hub-access-token.js (nenhum mock da cadeia de guarda em si —
 * requireModuloAtivo/requirePermission rodam de verdade), mockando só a
 * camada de dados via Module._load: `../lib/hub-rbac-cache` (cobre
 * requireModuloAtivo + requirePermission + a reconferência por entidade —
 * os 3 importam o MESMO módulo), `./grupo` (mesmoGrupoQue), `../lib/hub-postgrest`,
 * `../lib/hub-auditoria`, `../lib/hub-entidade-nome` e `../lib/hub-push-vapid`.
 *
 * Ref: contracts/hub-avisos.md, data-model.md, tasks.md FASE 4.
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-unit-hub-avisos';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');

// ──────────────────────────────────────────────────────────────────────────
// Estado mutável dos fakes (resetado em beforeEach de cada describe)
// ──────────────────────────────────────────────────────────────────────────
let permissoesFlat = new Set(['avisos.consultar', 'avisos.enviar']);
let permissoesPorEntidade = new Set(['avisos.consultar', 'avisos.enviar']);
let modulosAtivos = new Set(['avisos']);
let grupoIds = [6, 7]; // grupo Movee: empresa-pai 6 + 1 filial fictícia
let registrosAuditoria = [];
let avisosListaFixture = [];
let avisosDetalheFixture = {}; // id -> row
let resumoFixture = []; // [{aviso_id, visados, pendentes, processando, aceitos, falhas, mortas}]
let alcanceComportamento = null; // null=ok | 'fora_escopo'
let alcanceRows = [];
let coberturaFixture = {};
let criarComportamento = null; // null=ok | 'SEM_INSCRICOES_ATIVAS' | 'DESTINATARIOS_FORA_DO_ESCOPO' | 'FORA_DO_GRUPO_MOVEE' | 'UNIQUE_VIOLATION_UMA_VEZ' | 'UNIQUE_VIOLATION_SEMPRE'
let criarResultado = { aviso_id: 1, visados: 3, reutilizado: false };
let chamadasCriarAviso = 0; // dec-097 — conta invocações de rpc/hub_aviso_criar por request
let motoristasFixture = [];
let vapidDisponivel = true;
let vapidChaveAtual = { chavePublica: 'CHAVE-PUBLICA-TESTE', keyId: 'keyid-ativo' };
let chamadasPostgrest = [];

function raiseComMensagem(msg) {
  const e = new Error(msg);
  e.status = 400;
  e.body = JSON.stringify({ message: msg });
  return e;
}

// dec-097 — corpo de erro real que o PostgREST devolve para a violação da
// UNIQUE (criado_por, chave_idempotencia) de "Aviso" (SQLSTATE 23505).
function raiseUniqueViolationChave() {
  const e = new Error('duplicate key value violates unique constraint "aviso_criado_por_chave_uniq"');
  e.status = 409;
  e.body = JSON.stringify({
    code: '23505',
    message: 'duplicate key value violates unique constraint "aviso_criado_por_chave_uniq"',
    details: 'Key (criado_por, chave_idempotencia)=(1, 11111111-1111-4111-8111-111111111111) already exists.',
  });
  return e;
}

async function fakeHubPostgrestRequest(endpoint, method, body, claims, opts) {
  chamadasPostgrest.push({ endpoint, method, body, claims, opts });
  const [caminho] = endpoint.split('?');

  if (caminho === 'Aviso' && method === 'GET' && opts && opts.count) {
    const from = (opts.range && opts.range.from) || 0;
    const to = (opts.range && opts.range.to) != null ? opts.range.to : avisosListaFixture.length - 1;
    return { data: avisosListaFixture.slice(from, to + 1), total: avisosListaFixture.length };
  }
  if (caminho === 'Aviso' && method === 'GET') {
    const m = endpoint.match(/id=eq\.(\d+)/);
    const id = m ? Number(m[1]) : null;
    const row = avisosDetalheFixture[id];
    return row ? [row] : [];
  }
  if (caminho === 'rpc/hub_aviso_resumo') {
    const ids = body.p_aviso_ids || [];
    return resumoFixture.filter((r) => ids.includes(r.aviso_id));
  }
  if (caminho === 'rpc/hub_aviso_alcance') {
    if (alcanceComportamento === 'fora_escopo') throw raiseComMensagem('DESTINATARIOS_FORA_DO_ESCOPO');
    return alcanceRows;
  }
  if (caminho === 'rpc/hub_push_cobertura') {
    return [coberturaFixture];
  }
  if (caminho === 'rpc/hub_aviso_criar') {
    chamadasCriarAviso += 1;
    if (criarComportamento === 'UNIQUE_VIOLATION_UMA_VEZ') {
      if (chamadasCriarAviso === 1) throw raiseUniqueViolationChave();
      return [criarResultado]; // 2ª tentativa: vencedor já commitou, caminho idempotente normal
    }
    if (criarComportamento === 'UNIQUE_VIOLATION_SEMPRE') throw raiseUniqueViolationChave();
    if (criarComportamento) throw raiseComMensagem(criarComportamento);
    return [criarResultado];
  }
  if (caminho === 'Entregador') {
    return motoristasFixture;
  }
  // hub-motoristas.js#GET / (chamada na suíte de isolamento de claim, task 4.1.7)
  if (caminho === 'hub_areas_por_entregador') {
    return [];
  }
  throw new Error(`mock não suporta: ${endpoint}`);
}

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../lib/hub-rbac-cache') {
    return {
      obterPermissoesEfetivas: async () => permissoesFlat,
      obterPermissoesEfetivasPorEntidade: async () => permissoesPorEntidade,
      obterModulosAtivosPorEntidade: async () => modulosAtivos,
    };
  }
  if (request === './grupo') {
    return {
      mesmoGrupoQue: async (idEmpresa, _idReferencia, cache) => {
        if (!cache.ids) cache.ids = new Set(grupoIds);
        return cache.ids.has(Number(idEmpresa));
      },
    };
  }
  if (request === '../lib/hub-postgrest') {
    return { hubPostgrestRequest: async (...args) => fakeHubPostgrestRequest(...args) };
  }
  if (request === '../lib/hub-auditoria') {
    return {
      registrarAuditoria: async (evento) => {
        registrosAuditoria.push(evento);
        return { ok: true };
      },
    };
  }
  if (request === '../lib/hub-entidade-nome') {
    return {
      buscarNomesEntidades: async (ids) => new Map((ids || []).map((id) => [id, `Empresa ${id}`])),
    };
  }
  if (request === '../lib/hub-push-vapid') {
    return {
      getKeyAtual: () => {
        if (!vapidDisponivel) throw new Error('PUSH_INDISPONIVEL');
        return vapidChaveAtual;
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

const express = require('express');
const cookieParser = require('cookie-parser');
const { router } = require('../routes/hub-avisos.js');
const { router: motoristasRouter } = require('../routes/hub-motoristas.js');

Module._load = originalLoad;

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1/avisos', router);
app.use('/api/v1/motoristas', motoristasRouter); // task 4.1.7 — checar isolamento de claim entre rotas

let server;
let baseUrl;

function request(method, path, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const headers = {};
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    if (cookie) headers.Cookie = cookie;
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let json;
          try {
            json = data ? JSON.parse(data) : null;
          } catch (_) {
            json = data;
          }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

let proximoSub = 5000;
/** `sub` novo a cada chamada — os rate limiters são chaveados por usuário;
 * testes independentes não podem competir pelo mesmo balde. */
function tokenCookie({ entidadeAtiva = 6, semEntidade = false } = {}) {
  const payload = semEntidade ? { sub: proximoSub++ } : { sub: proximoSub++, entidade_ativa: entidadeAtiva };
  const token = jwt.sign(payload, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
  return `hub_accessToken=${token}`;
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
});

function resetFixtures() {
  permissoesFlat = new Set(['avisos.consultar', 'avisos.enviar']);
  permissoesPorEntidade = new Set(['avisos.consultar', 'avisos.enviar']);
  modulosAtivos = new Set(['avisos']);
  grupoIds = [6, 7];
  registrosAuditoria = [];
  avisosListaFixture = [
    { id: 2, titulo: 'Aviso 2', status: 'na_fila', modo_destinatarios: 'toda_base', criado_em: '2026-09-02T00:00:00Z' },
    { id: 1, titulo: 'Aviso 1', status: 'concluido', modo_destinatarios: 'individual', criado_em: '2026-09-01T00:00:00Z' },
  ];
  avisosDetalheFixture = {
    1: {
      id: 1, titulo: 'Aviso 1', corpo: 'Corpo 1', status: 'concluido', modo_destinatarios: 'individual',
      destinatarios_ids: [10, 11], criado_em: '2026-09-01T00:00:00Z', iniciado_em: '2026-09-01T00:01:00Z', concluido_em: '2026-09-01T00:02:00Z',
    },
    2: {
      id: 2, titulo: 'Aviso 2', corpo: 'Corpo 2', status: 'na_fila', modo_destinatarios: 'empresa',
      destinatarios_ids: [6, 7], criado_em: '2026-09-02T00:00:00Z', iniciado_em: null, concluido_em: null,
    },
    3: {
      id: 3, titulo: 'Aviso 3', corpo: 'Corpo 3', status: 'na_fila', modo_destinatarios: 'toda_base',
      destinatarios_ids: [], criado_em: '2026-09-03T00:00:00Z', iniciado_em: null, concluido_em: null,
    },
  };
  resumoFixture = [
    { aviso_id: 1, visados: 5, pendentes: 0, processando: 0, aceitos: 4, falhas: 1, mortas: 0 },
    { aviso_id: 2, visados: 3, pendentes: 1, processando: 0, aceitos: 2, falhas: 0, mortas: 0 },
  ];
  alcanceComportamento = null;
  alcanceRows = [
    { cnpj_prestador: '11111111000191', inscricao_id: 1 },
    { cnpj_prestador: '11111111000191', inscricao_id: 2 }, // mesmo motorista, 2 inscrições (2 aparelhos)
    { cnpj_prestador: '22222222000191', inscricao_id: 3 },
  ];
  coberturaFixture = {
    ativos_android: 10, ativos_ios: 2, ativos_desktop_outros: 0,
    impedidos_bloqueadas: 1, impedidos_ios_sem_instalacao: 3, impedidos_sem_suporte: 0,
    nao_ativadas: 5,
  };
  criarComportamento = null;
  criarResultado = { aviso_id: 42, visados: 3, reutilizado: false };
  chamadasCriarAviso = 0;
  motoristasFixture = [{ id: 10, nome: 'João Motorista' }];
  vapidDisponivel = true;
  vapidChaveAtual = { chavePublica: 'CHAVE-PUBLICA-TESTE', keyId: 'keyid-ativo' };
  chamadasPostgrest = [];
}

const CHAVE_IDEMPOTENCIA_1 = '11111111-1111-4111-8111-111111111111';

describe('cadeia de guarda (task 4.1.2 — comum às 6 rotas de leitura, exercitada via GET /avisos)', () => {
  beforeEach(resetFixtures);

  test('sem cookie -> 401 NAO_AUTENTICADO', async () => {
    const r = await request('GET', '/api/v1/avisos');
    assert.equal(r.status, 401);
    assert.equal(r.body.erro, 'NAO_AUTENTICADO');
  });

  test('sem entidade_ativa no token -> 403 MODULO_DESABILITADO (requireModuloAtivo nega sem entidade p/ consultar ModuloEntidade)', async () => {
    const r = await request('GET', '/api/v1/avisos', { cookie: tokenCookie({ semEntidade: true }) });
    assert.equal(r.status, 403);
    assert.equal(r.body.erro, 'MODULO_DESABILITADO');
  });

  test('módulo avisos desabilitado -> 403 MODULO_DESABILITADO', async () => {
    modulosAtivos = new Set([]);
    const r = await request('GET', '/api/v1/avisos', { cookie: tokenCookie() });
    assert.equal(r.status, 403);
    assert.equal(r.body.erro, 'MODULO_DESABILITADO');
  });

  test('sem permissão avisos.consultar (união flat) -> 403 PERMISSAO_NEGADA', async () => {
    permissoesFlat = new Set([]);
    const r = await request('GET', '/api/v1/avisos', { cookie: tokenCookie() });
    assert.equal(r.status, 403);
    assert.equal(r.body.erro, 'PERMISSAO_NEGADA');
  });

  test('permissão flat presente mas ausente NA ENTIDADE ATIVA -> 403 PERMISSAO_NEGADA (reconferência)', async () => {
    permissoesPorEntidade = new Set([]);
    const r = await request('GET', '/api/v1/avisos', { cookie: tokenCookie() });
    assert.equal(r.status, 403);
    assert.equal(r.body.erro, 'PERMISSAO_NEGADA');
  });

  test('entidade ativa fora do grupo Movee -> 403 FORA_DO_GRUPO_MOVEE', async () => {
    const r = await request('GET', '/api/v1/avisos', { cookie: tokenCookie({ entidadeAtiva: 999 }) });
    assert.equal(r.status, 403);
    assert.equal(r.body.erro, 'FORA_DO_GRUPO_MOVEE');
  });
});

describe('GET /api/v1/avisos (task 4.1.1/4.1.3)', () => {
  beforeEach(resetFixtures);

  test('lista paginada com envelope {itens,total,page,pageSize} e contagens sem "processando"', async () => {
    const r = await request('GET', '/api/v1/avisos', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 2);
    assert.equal(r.body.page, 1);
    assert.equal(r.body.pageSize, 20);
    assert.equal(r.body.itens.length, 2);
    assert.deepEqual(Object.keys(r.body.itens[0].contagens).sort(), ['aceitos', 'falhas', 'mortas', 'pendentes', 'visados']);
    assert.equal(r.body.itens[0].modoDestinatarios, 'toda_base');
  });

  test('page/pageSize customizados repassados ao Range do PostgREST', async () => {
    const r = await request('GET', '/api/v1/avisos?page=2&pageSize=5', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.page, 2);
    assert.equal(r.body.pageSize, 5);
    const chamada = chamadasPostgrest.find((c) => c.endpoint.startsWith('Aviso?') && c.opts && c.opts.count);
    assert.deepEqual(chamada.opts.range, { from: 5, to: 9 });
  });

  test('pageSize acima de 100 é limitado a 100', async () => {
    const r = await request('GET', '/api/v1/avisos?pageSize=500', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.pageSize, 100);
  });
});

describe('GET /api/v1/avisos/:id (task 4.1.1)', () => {
  beforeEach(resetFixtures);

  test('modo empresa -> destinatarios.empresas com nomes', async () => {
    const r = await request('GET', '/api/v1/avisos/2', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.destinatarios, { empresas: [{ id: 6, nome: 'Empresa 6' }, { id: 7, nome: 'Empresa 7' }] });
    assert.deepEqual(Object.keys(r.body.contagens).sort(), ['aceitos', 'falhas', 'mortas', 'pendentes', 'processando', 'visados']);
  });

  test('modo individual -> destinatarios.qtdMotoristas', async () => {
    const r = await request('GET', '/api/v1/avisos/1', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.destinatarios, { qtdMotoristas: 2 });
  });

  test('modo toda_base -> destinatarios {}', async () => {
    const r = await request('GET', '/api/v1/avisos/3', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.destinatarios, {});
  });

  test('inexistente -> 404 AVISO_NAO_ENCONTRADO', async () => {
    const r = await request('GET', '/api/v1/avisos/999', { cookie: tokenCookie() });
    assert.equal(r.status, 404);
    assert.equal(r.body.erro, 'AVISO_NAO_ENCONTRADO');
  });

  test('id não-numérico -> 404 AVISO_NAO_ENCONTRADO (nunca 500)', async () => {
    const r = await request('GET', '/api/v1/avisos/abc', { cookie: tokenCookie() });
    assert.equal(r.status, 404);
  });
});

describe('GET /api/v1/avisos/alcance (task 4.1.1/4.1.4 — S8)', () => {
  beforeEach(resetFixtures);

  test('modo toda_base -> {motoristas,inscricoes} deduplicado por cnpj', async () => {
    const r = await request('GET', '/api/v1/avisos/alcance?modo=toda_base', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.motoristas, 2); // 2 cnpjs distintos
    assert.equal(r.body.inscricoes, 3); // 3 inscrições ao todo
  });

  test('modo inválido -> 400 DADOS_INVALIDOS', async () => {
    const r = await request('GET', '/api/v1/avisos/alcance?modo=invalido', { cookie: tokenCookie() });
    assert.equal(r.status, 400);
    assert.equal(r.body.erro, 'DADOS_INVALIDOS');
  });

  test('modo individual sem ids -> 400 DADOS_INVALIDOS', async () => {
    const r = await request('GET', '/api/v1/avisos/alcance?modo=individual', { cookie: tokenCookie() });
    assert.equal(r.status, 400);
    assert.equal(r.body.erro, 'DADOS_INVALIDOS');
  });

  test('sem chave VAPID disponível -> 503 PUSH_INDISPONIVEL', async () => {
    vapidDisponivel = false;
    const r = await request('GET', '/api/v1/avisos/alcance?modo=toda_base', { cookie: tokenCookie() });
    assert.equal(r.status, 503);
    assert.equal(r.body.erro, 'PUSH_INDISPONIVEL');
  });

  test('empresa fora do escopo -> 403 DESTINATARIOS_FORA_DO_ESCOPO', async () => {
    alcanceComportamento = 'fora_escopo';
    const r = await request('GET', '/api/v1/avisos/alcance?modo=empresa&ids=999', { cookie: tokenCookie() });
    assert.equal(r.status, 403);
    assert.equal(r.body.erro, 'DESTINATARIOS_FORA_DO_ESCOPO');
  });

  test('11ª requisição em 15 min -> 429 LIMITE_EXCEDIDO (FR-027)', async () => {
    const cookie = tokenCookie();
    let ultima;
    for (let i = 0; i < 11; i += 1) {
      ultima = await request('GET', '/api/v1/avisos/alcance?modo=toda_base', { cookie });
    }
    assert.equal(ultima.status, 429);
    assert.equal(ultima.body.erro, 'LIMITE_EXCEDIDO');
  });
});

describe('GET /api/v1/avisos/destinatarios/empresas e /motoristas (task 4.1.1)', () => {
  beforeEach(resetFixtures);

  test('destinatarios/empresas -> lista {id,nome} do escopo, ordenada', async () => {
    const r = await request('GET', '/api/v1/avisos/destinatarios/empresas', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.empresas, [{ id: 6, nome: 'Empresa 6' }, { id: 7, nome: 'Empresa 7' }]);
  });

  test('destinatarios/motoristas com busca abaixo de 3 chars -> lista vazia sem erro', async () => {
    const r = await request('GET', '/api/v1/avisos/destinatarios/motoristas?busca=jo', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.motoristas, []);
  });

  test('destinatarios/motoristas com busca válida -> lista do escopo com motorista_id vinculado', async () => {
    const r = await request('GET', '/api/v1/avisos/destinatarios/motoristas?busca=joa', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.motoristas, [{ id: 10, nome: 'João Motorista' }]);
  });
});

describe('GET /api/v1/avisos/cobertura (task 4.1.1)', () => {
  beforeEach(resetFixtures);

  test('shape ativos/impedidos/naoAtivadas com camelCase', async () => {
    const r = await request('GET', '/api/v1/avisos/cobertura', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      ativos: { android: 10, ios: 2, desktopOutros: 0 },
      impedidos: { iosSemInstalacao: 3, bloqueadas: 1, semSuporte: 0 },
      naoAtivadas: 5,
    });
  });
});

describe('isolamento de claim `escopo` entre hub-avisos e hub-motoristas (task 4.1.7 — mitigação S5)', () => {
  beforeEach(resetFixtures);

  test('chamada a hub-motoristas APÓS hub-avisos usa escopo=[entidadeAtiva], nunca o grupo inteiro', async () => {
    // hub-motoristas.js#GET / exige 'motoristas.listar' (flat + por entidade) —
    // aditivo às permissões de avisos já concedidas por resetFixtures.
    permissoesFlat.add('motoristas.listar');
    permissoesPorEntidade.add('motoristas.listar');

    const cookie = tokenCookie({ entidadeAtiva: 6 });

    const rAvisos = await request('GET', '/api/v1/avisos', { cookie });
    assert.equal(rAvisos.status, 200);
    const chamadaAvisos = chamadasPostgrest.find((c) => c.endpoint.startsWith('Aviso?') && c.opts && c.opts.count);
    assert.deepEqual([...chamadaAvisos.claims.escopo].sort(), [6, 7]); // idsDoGrupo(6) — grupo inteiro

    chamadasPostgrest = [];
    const rMotoristas = await request('GET', '/api/v1/motoristas', { cookie });
    assert.equal(rMotoristas.status, 200);
    const chamadaMotoristas = chamadasPostgrest.find((c) => c.endpoint.startsWith('Entregador?'));
    assert.deepEqual(chamadaMotoristas.claims.escopo, [6]); // claim de hub-motoristas.js — intocado
  });
});

describe('POST /api/v1/avisos (task 4.2)', () => {
  beforeEach(resetFixtures);

  function payloadValido(overrides) {
    return Object.assign({
      titulo: 'Título de teste',
      corpo: 'Corpo de teste da notificação.',
      modoDestinatarios: 'toda_base',
      destinatariosIds: [],
      chaveIdempotencia: CHAVE_IDEMPOTENCIA_1,
    }, overrides);
  }

  test('payload válido modo toda_base -> 201 {id,status,visados} + auditoria', async () => {
    const r = await request('POST', '/api/v1/avisos', { cookie: tokenCookie(), body: payloadValido() });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body, { id: 42, status: 'na_fila', visados: 3 });
    assert.equal(registrosAuditoria.length, 1);
    assert.equal(registrosAuditoria[0].acao, 'aviso_disparado');
    assert.equal(registrosAuditoria[0].recurso, 'Aviso');
    assert.equal(registrosAuditoria[0].recursoId, 42);
    assert.ok(registrosAuditoria[0].idEmpresa && registrosAuditoria[0].usuarioId);
  });

  test('duplo disparo com mesma chaveIdempotencia -> 200 mesmo id/visados, SEM segunda auditoria', async () => {
    criarResultado = { aviso_id: 7, visados: 9, reutilizado: true };
    const r = await request('POST', '/api/v1/avisos', { cookie: tokenCookie(), body: payloadValido() });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { id: 7, status: 'na_fila', visados: 9 });
    assert.equal(registrosAuditoria.length, 0); // reutilizado -> não é um novo disparo
  });

  test('dec-097: disparo duplo concorrente (unique_violation no perdedor) -> retry automático cai no caminho idempotente, 200, SEM 2ª auditoria', async () => {
    criarComportamento = 'UNIQUE_VIOLATION_UMA_VEZ';
    criarResultado = { aviso_id: 7, visados: 9, reutilizado: true };
    const r = await request('POST', '/api/v1/avisos', { cookie: tokenCookie(), body: payloadValido() });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { id: 7, status: 'na_fila', visados: 9 });
    assert.equal(registrosAuditoria.length, 0); // idempotente -> não é um novo disparo
    assert.equal(chamadasCriarAviso, 2); // 1ª colidiu, 2ª (retry) resolveu
  });

  test('dec-097: unique_violation persistente (2x) -> não repete indefinidamente, propaga 500', async () => {
    criarComportamento = 'UNIQUE_VIOLATION_SEMPRE';
    const r = await request('POST', '/api/v1/avisos', { cookie: tokenCookie(), body: payloadValido() });
    assert.equal(r.status, 500);
    assert.equal(chamadasCriarAviso, 2); // só 1 retry — nunca 3ª tentativa
  });

  test('título vazio -> 400 DADOS_INVALIDOS motivo titulo', async () => {
    const r = await request('POST', '/api/v1/avisos', { cookie: tokenCookie(), body: payloadValido({ titulo: '' }) });
    assert.equal(r.status, 400);
    assert.equal(r.body.erro, 'DADOS_INVALIDOS');
    assert.equal(r.body.motivo, 'titulo');
  });

  test('corpo acima de 180 chars -> 400 CONTEUDO_EXCEDE_LIMITE', async () => {
    const r = await request('POST', '/api/v1/avisos', { cookie: tokenCookie(), body: payloadValido({ corpo: 'x'.repeat(181) }) });
    assert.equal(r.status, 400);
    assert.equal(r.body.erro, 'CONTEUDO_EXCEDE_LIMITE');
  });

  test('modoDestinatarios inválido -> 400 DADOS_INVALIDOS motivo modo', async () => {
    const r = await request('POST', '/api/v1/avisos', { cookie: tokenCookie(), body: payloadValido({ modoDestinatarios: 'grupo-x' }) });
    assert.equal(r.status, 400);
    assert.equal(r.body.motivo, 'modo');
  });

  test('chaveIdempotencia que não é UUID -> 400 DADOS_INVALIDOS motivo chave', async () => {
    const r = await request('POST', '/api/v1/avisos', { cookie: tokenCookie(), body: payloadValido({ chaveIdempotencia: 'não-é-uuid' }) });
    assert.equal(r.status, 400);
    assert.equal(r.body.motivo, 'chave');
  });

  test('sem permissão avisos.enviar -> 403 PERMISSAO_NEGADA', async () => {
    permissoesFlat = new Set(['avisos.consultar']);
    const r = await request('POST', '/api/v1/avisos', { cookie: tokenCookie(), body: payloadValido() });
    assert.equal(r.status, 403);
    assert.equal(r.body.erro, 'PERMISSAO_NEGADA');
  });

  test('0 inscrições ativas -> 422 SEM_INSCRICOES_ATIVAS, nada gravado (sem auditoria)', async () => {
    criarComportamento = 'SEM_INSCRICOES_ATIVAS';
    const r = await request('POST', '/api/v1/avisos', { cookie: tokenCookie(), body: payloadValido() });
    assert.equal(r.status, 422);
    assert.equal(r.body.erro, 'SEM_INSCRICOES_ATIVAS');
    assert.equal(registrosAuditoria.length, 0);
  });

  test('destinatários fora do escopo (modo empresa) -> 403 DESTINATARIOS_FORA_DO_ESCOPO', async () => {
    criarComportamento = 'DESTINATARIOS_FORA_DO_ESCOPO';
    const r = await request('POST', '/api/v1/avisos', {
      cookie: tokenCookie(),
      body: payloadValido({ modoDestinatarios: 'empresa', destinatariosIds: [999] }),
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.erro, 'DESTINATARIOS_FORA_DO_ESCOPO');
  });

  test('sem chave VAPID disponível -> 503 PUSH_INDISPONIVEL, nada gravado', async () => {
    vapidDisponivel = false;
    const r = await request('POST', '/api/v1/avisos', { cookie: tokenCookie(), body: payloadValido() });
    assert.equal(r.status, 503);
    assert.equal(registrosAuditoria.length, 0);
  });

  test('11ª requisição em 15 min -> 429 LIMITE_EXCEDIDO (FR-027)', async () => {
    const cookie = tokenCookie();
    let ultima;
    for (let i = 0; i < 11; i += 1) {
      ultima = await request('POST', '/api/v1/avisos', { cookie, body: payloadValido({ chaveIdempotencia: `1111111${i}-1111-4111-8111-11111111111${i % 10}` }) });
    }
    assert.equal(ultima.status, 429);
    assert.equal(ultima.body.erro, 'LIMITE_EXCEDIDO');
  });

  test('modo empresa com 2 empresas do grupo Movee (empresa 6 + filial fictícia 7) -> aceito (task 4.2.7)', async () => {
    const r = await request('POST', '/api/v1/avisos', {
      cookie: tokenCookie(),
      body: payloadValido({ modoDestinatarios: 'empresa', destinatariosIds: [6, 7] }),
    });
    assert.equal(r.status, 201);
    const chamadaCriar = chamadasPostgrest.find((c) => c.endpoint === 'rpc/hub_aviso_criar');
    assert.deepEqual(chamadaCriar.body.p_ids, [6, 7]);
  });
});

describe('Log de recusas (task 4.3.1/4.3.3 — FR-031)', () => {
  beforeEach(resetFixtures);

  test('recusa FORA_DO_GRUPO_MOVEE gera exatamente 1 linha de log com o código e prefixo de 8 hex, sem dado sensível', async () => {
    const chamadasWarn = [];
    const originalWarn = console.warn;
    console.warn = (...args) => chamadasWarn.push(args.join(' '));
    try {
      const r = await request('GET', '/api/v1/avisos', { cookie: tokenCookie({ entidadeAtiva: 999 }) });
      assert.equal(r.status, 403);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(chamadasWarn.length, 1);
    assert.match(chamadasWarn[0], /FORA_DO_GRUPO_MOVEE/);
    assert.match(chamadasWarn[0], /req_hash=[0-9a-f]{8}\)/);
    assert.doesNotMatch(chamadasWarn[0], /avisos\?/); // nunca o path/query completo
  });
});
