/**
 * Testes unitários — routes/hub-robo-entrego.js, fila de enriquecimento
 * EntreGô (hub-motorista-360 FASE 5, tasks.md 5.2.5).
 * Rodam com: node --test tests/hub-robo-entrego-enriquecimento-unit.test.js
 *
 * Mesma técnica de tests/hub-robo-entrego-unit.test.js (express real +
 * node:http + app.listen(0), accessToken JWT REAL verificado por
 * lib/hub-access-token.js): mocka `../lib/hub-rbac-cache`,
 * `../lib/hub-auditoria` E, adicionalmente, `../lib/hub-postgrest`
 * (`hubPostgrestRequest`) com uma tabela `Entregador` em memória que também
 * emula RLS por escopo (claims.escopo) — cobre o cenário 5.2.5 ("RLS confina
 * o resultado a id_empresa do token de serviço; 404 para :id fora do
 * escopo") sem precisar de Docker/PostgREST real.
 *
 * Fixtures de CPF/RG usam FORMATO (999.999.999-99), nunca dado real
 * (CLAUDE.md §PII).
 *
 * Ref: contracts/entrego-enriquecimento.md §2.
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-unit-robo-entrego-enriquecimento';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');

let permissoesPorEntidade = new Set(['motoristas.enriquecimento.consultar', 'motoristas.enriquecimento.atualizar']);
let registrosAuditoria = [];
let entregadores = [];

/** Emula PostgREST: só entende os filtros que routes/hub-robo-entrego.js de
 * fato gera (id=eq., dados_entrego_solicitado_em=not.is.null,
 * dados_entrego_enriquecidos_em=lt.<iso>, limit=N) + RLS por
 * `claims.escopo` (ANY(escopo) — mesma semântica de hub_jwt_escopo_ids()). */
function fakeHubPostgrestRequest(endpoint, method, body, claims) {
  const [tabela, qs] = endpoint.split('?');
  assert.equal(tabela, 'Entregador', `mock só suporta a tabela Entregador (recebeu ${tabela})`);
  const params = new URLSearchParams(qs || '');
  const escopo = (claims && claims.escopo) || [];

  let linhas = entregadores.filter((e) => escopo.includes(e.id_empresa));

  if (params.has('id')) {
    const id = Number(params.get('id').replace('eq.', ''));
    linhas = linhas.filter((e) => e.id === id);
  }
  if (params.has('dados_entrego_solicitado_em')) {
    linhas = linhas.filter((e) => e.dados_entrego_solicitado_em != null);
  }
  if (params.has('dados_entrego_enriquecidos_em')) {
    const cutoff = params.get('dados_entrego_enriquecidos_em').replace('lt.', '');
    linhas = linhas.filter((e) => e.dados_entrego_enriquecidos_em != null && e.dados_entrego_enriquecidos_em < cutoff);
  }

  if (method === 'GET') {
    const limite = params.get('limit');
    if (limite) linhas = linhas.slice(0, Number(limite));
    return linhas.map((e) => ({ id: e.id, id_externo: e.id_externo }));
  }
  if (method === 'PATCH') {
    linhas.forEach((e) => Object.assign(e, body));
    return linhas.map((e) => ({ ...e }));
  }
  throw new Error(`mock não suporta method: ${method}`);
}

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../lib/hub-rbac-cache') {
    return {
      obterPermissoesEfetivas: async () => permissoesPorEntidade,
      obterPermissoesEfetivasPorEntidade: async () => permissoesPorEntidade,
    };
  }
  if (request === '../lib/hub-auditoria') {
    return {
      registrarAuditoria: async (evento) => {
        registrosAuditoria.push(evento);
      },
    };
  }
  if (request === '../lib/hub-postgrest') {
    return { hubPostgrestRequest: async (...args) => fakeHubPostgrestRequest(...args) };
  }
  return originalLoad.apply(this, arguments);
};

const express = require('express');
const cookieParser = require('cookie-parser');
const { router } = require('../routes/hub-robo-entrego.js');

Module._load = originalLoad;

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1/robo-entrego', router);

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
            json = JSON.parse(data);
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

function tokenCookie({ sub = 1, entidadeAtiva = 6 } = {}) {
  const payload = { sub, entidade_ativa: entidadeAtiva };
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

describe('GET /api/v1/robo-entrego/motoristas-para-enriquecer', () => {
  beforeEach(() => {
    permissoesPorEntidade = new Set(['motoristas.enriquecimento.consultar', 'motoristas.enriquecimento.atualizar']);
    registrosAuditoria = [];
    entregadores = [
      { id: 1, id_empresa: 6, id_externo: 'uuid-1', dados_entrego_json: null, dados_entrego_enriquecidos_em: null, dados_entrego_solicitado_em: '2026-08-01T10:00:00.000Z' },
      { id: 2, id_empresa: 6, id_externo: 'uuid-2', dados_entrego_json: null, dados_entrego_enriquecidos_em: null, dados_entrego_solicitado_em: null },
      // outro tenant (id_empresa=7) — nunca deve aparecer no resultado do token escopado a 6.
      { id: 3, id_empresa: 7, id_externo: 'uuid-3', dados_entrego_json: null, dados_entrego_enriquecidos_em: null, dados_entrego_solicitado_em: '2026-08-01T10:00:00.000Z' },
      // enriquecido há mais de 6 meses -> elegível ao modo semestral.
      { id: 4, id_empresa: 6, id_externo: 'uuid-4', dados_entrego_json: {}, dados_entrego_enriquecidos_em: '2020-01-01T00:00:00.000Z', dados_entrego_solicitado_em: null },
      // enriquecido recentemente -> NÃO elegível ao modo semestral.
      { id: 5, id_empresa: 6, id_externo: 'uuid-5', dados_entrego_json: {}, dados_entrego_enriquecidos_em: new Date().toISOString(), dados_entrego_solicitado_em: null },
    ];
  });

  test('sem cookie -> 401 NAO_AUTENTICADO', async () => {
    const r = await request('GET', '/api/v1/robo-entrego/motoristas-para-enriquecer?modo=sob-demanda');
    assert.equal(r.status, 401);
  });

  test('modo inválido -> 422 INVALIDO', async () => {
    const r = await request('GET', '/api/v1/robo-entrego/motoristas-para-enriquecer?modo=turbo', { cookie: tokenCookie() });
    assert.equal(r.status, 422);
    assert.equal(r.body.erro, 'INVALIDO');
  });

  test('sem permissao motoristas.enriquecimento.consultar -> 403 PERMISSAO_NEGADA', async () => {
    permissoesPorEntidade = new Set();
    const r = await request('GET', '/api/v1/robo-entrego/motoristas-para-enriquecer?modo=sob-demanda', { cookie: tokenCookie() });
    assert.equal(r.status, 403);
  });

  test('modo=sob-demanda -> só os com dados_entrego_solicitado_em setado, escopados a id_empresa=6 (RLS)', async () => {
    const r = await request('GET', '/api/v1/robo-entrego/motoristas-para-enriquecer?modo=sob-demanda', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items, [{ id: 1, idExterno: 'uuid-1' }]);
  });

  test('modo=semestral -> só os enriquecidos há mais de 6 meses', async () => {
    const r = await request('GET', '/api/v1/robo-entrego/motoristas-para-enriquecer?modo=semestral', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items, [{ id: 4, idExterno: 'uuid-4' }]);
  });
});

describe('PATCH /api/v1/robo-entrego/motoristas/:id/entrego-enriquecimento', () => {
  beforeEach(() => {
    permissoesPorEntidade = new Set(['motoristas.enriquecimento.consultar', 'motoristas.enriquecimento.atualizar']);
    registrosAuditoria = [];
    entregadores = [
      { id: 10, id_empresa: 6, id_externo: 'uuid-10', dados_entrego_json: null, dados_entrego_enriquecidos_em: null, dados_entrego_solicitado_em: '2026-08-01T10:00:00.000Z' },
      { id: 11, id_empresa: 6, id_externo: 'uuid-11', dados_entrego_json: { dadosPessoais: { cpf: '111.111.111-11' } }, dados_entrego_enriquecidos_em: '2026-01-01T00:00:00.000Z', dados_entrego_solicitado_em: '2026-08-01T10:00:00.000Z' },
      { id: 20, id_empresa: 7, id_externo: 'uuid-20', dados_entrego_json: null, dados_entrego_enriquecidos_em: null, dados_entrego_solicitado_em: '2026-08-01T10:00:00.000Z' },
    ];
  });

  test('sucesso=true grava dados_entrego_json + enriquecidos_em, limpa solicitado_em, audita motorista.entrego_enriquecido', async () => {
    const r = await request('PATCH', '/api/v1/robo-entrego/motoristas/10/entrego-enriquecimento', {
      body: { sucesso: true, dados: { dadosPessoais: { cpf: '999.999.999-99' } }, modo: 'sob-demanda' },
      cookie: tokenCookie(),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    const linha = entregadores.find((e) => e.id === 10);
    assert.deepEqual(linha.dados_entrego_json, { dadosPessoais: { cpf: '999.999.999-99' } });
    assert.equal(linha.dados_entrego_solicitado_em, null);
    assert.ok(linha.dados_entrego_enriquecidos_em);
    assert.equal(registrosAuditoria.length, 1);
    assert.equal(registrosAuditoria[0].acao, 'motorista.entrego_enriquecido');
    // detalhes NUNCA inclui o payload sensível (contract §2).
    assert.equal(registrosAuditoria[0].detalhes.dados, undefined);
  });

  test('sucesso=false NÃO descarta dados_entrego_json de uma busca anterior bem-sucedida (FR-007)', async () => {
    const r = await request('PATCH', '/api/v1/robo-entrego/motoristas/11/entrego-enriquecimento', {
      body: { sucesso: false, motivoFalha: 'antibot' },
      cookie: tokenCookie(),
    });
    assert.equal(r.status, 200);
    const linha = entregadores.find((e) => e.id === 11);
    assert.deepEqual(linha.dados_entrego_json, { dadosPessoais: { cpf: '111.111.111-11' } });
    assert.equal(linha.dados_entrego_enriquecidos_em, '2026-01-01T00:00:00.000Z');
    assert.equal(linha.dados_entrego_solicitado_em, null);
    assert.equal(registrosAuditoria[0].acao, 'motorista.entrego_enriquecimento_falhou');
    assert.equal(registrosAuditoria[0].detalhes.motivoFalha, 'antibot');
  });

  test(':id fora do escopo do token de serviço (RLS, outro tenant) -> 404, nunca 200/204 silencioso', async () => {
    const r = await request('PATCH', '/api/v1/robo-entrego/motoristas/20/entrego-enriquecimento', {
      body: { sucesso: true, dados: {} },
      cookie: tokenCookie({ entidadeAtiva: 6 }),
    });
    assert.equal(r.status, 404);
    assert.equal(registrosAuditoria.length, 0);
  });

  test(':id inexistente -> 404', async () => {
    const r = await request('PATCH', '/api/v1/robo-entrego/motoristas/999/entrego-enriquecimento', {
      body: { sucesso: true },
      cookie: tokenCookie(),
    });
    assert.equal(r.status, 404);
  });

  test('sucesso ausente/não-boolean -> 422 INVALIDO', async () => {
    const r = await request('PATCH', '/api/v1/robo-entrego/motoristas/10/entrego-enriquecimento', {
      body: {},
      cookie: tokenCookie(),
    });
    assert.equal(r.status, 422);
  });

  test('sem permissao motoristas.enriquecimento.atualizar -> 403', async () => {
    permissoesPorEntidade = new Set();
    const r = await request('PATCH', '/api/v1/robo-entrego/motoristas/10/entrego-enriquecimento', {
      body: { sucesso: true },
      cookie: tokenCookie(),
    });
    assert.equal(r.status, 403);
  });
});
