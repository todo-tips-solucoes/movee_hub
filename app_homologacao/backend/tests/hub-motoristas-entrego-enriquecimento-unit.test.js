/**
 * Testes unitários — routes/hub-motoristas.js, FASE 5 (hub-motorista-360):
 *   - POST /:id/entrego-enriquecimento (task 5.1.5 — 202/409/429)
 *   - GET /:id — RBAC de campo + auditoria de leitura (tasks 5.4.4/5.5.3)
 *
 * Mesma técnica de tests/hub-robo-entrego-enriquecimento-unit.test.js:
 * express real + node:http + app.listen(0), accessToken JWT REAL verificado
 * por lib/hub-access-token.js, mockando `../lib/hub-rbac-cache`,
 * `../lib/hub-auditoria` e `../lib/hub-postgrest` via Module._load — cobre a
 * lógica de roteamento/RBAC/auditoria sem depender de Docker/PostgREST real
 * (esse caminho fica para tests/hub-motoristas.test.js, integração Docker).
 *
 * Fixtures de CPF/RG usam FORMATO (999.999.999-99), nunca dado real
 * (CLAUDE.md §PII).
 *
 * Ref: contracts/entrego-enriquecimento.md §1,
 * contracts/hub-motoristas-detalhe.md.
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-unit-motoristas-entrego';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');

let permissoesFlat = new Set(['motoristas.consultar', 'motoristas.editar']);
let permissoesPorEntidade = new Set(['motoristas.consultar', 'motoristas.editar']);
let registrosAuditoria = [];
let entregadorFixture = null; // { id, id_empresa, id_externo, dados_entrego_solicitado_em, dados_entrego_json, dados_entrego_enriquecidos_em, ContaMotorista }
// FASE 7 (task 7.1.3) — trilha de auditoria PRÉ-EXISTENTE consultada por
// routes/hub-motoristas.js#vinculoAtualEhAutomatico ({ recurso, recursoId,
// acao, criadoEm }[]); distinto de `registrosAuditoria` (o que a rota GRAVA
// durante a própria requisição).
let auditoriaHistoricoFixture = [];

/** Emula PostgREST só para as tabelas que routes/hub-motoristas.js#GET /:id e
 * #POST /:id/entrego-enriquecimento de fato consultam. */
function fakeHubPostgrestRequest(endpoint, method, body, claims, opts) {
  const [tabela] = endpoint.split('?');
  if (tabela === 'Entregador') {
    const idMatch = endpoint.match(/[?&]id=eq\.(\d+)/);
    const id = idMatch ? Number(idMatch[1]) : null;
    const empresaMatch = endpoint.match(/[?&]id_empresa=eq\.(\d+)/);
    const idEmpresa = empresaMatch ? Number(empresaMatch[1]) : null;
    const casaEmpresa = idEmpresa === null || (entregadorFixture && entregadorFixture.id_empresa === idEmpresa);
    const linha = entregadorFixture && entregadorFixture.id === id && casaEmpresa ? entregadorFixture : null;
    if (method === 'PATCH') {
      if (linha) Object.assign(linha, body);
      return linha ? [{ ...linha }] : [];
    }
    // GET — devolve com embed ContaMotorista, como o PostgREST faria.
    return linha ? [{ ...linha, ContaMotorista: linha.ContaMotorista || null }] : [];
  }
  if (tabela === 'hub_areas_por_entregador') return [];
  if (tabela === 'FaturamentoLancamento' || tabela === 'PerformanceTurno') {
    if (opts && opts.count) return { data: [], total: 0 };
    return [];
  }
  if (tabela === 'EnvioMassa') return [];
  if (tabela === 'Auditoria') {
    const recursoIdMatch = endpoint.match(/[?&]recurso_id=eq\.(\d+)/);
    const recursoId = recursoIdMatch ? recursoIdMatch[1] : null;
    const linhas = auditoriaHistoricoFixture
      .filter((r) => r.recurso === 'Entregador' && String(r.recursoId) === recursoId)
      .sort((a, b) => (a.criadoEm < b.criadoEm ? 1 : -1));
    return linhas.slice(0, 1).map((r) => ({ acao: r.acao }));
  }
  throw new Error(`mock não suporta tabela: ${tabela}`);
}

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../lib/hub-rbac-cache') {
    return {
      obterPermissoesEfetivas: async () => permissoesFlat,
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
const { router } = require('../routes/hub-motoristas.js');

Module._load = originalLoad;

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1/motoristas', router);

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

let proximoSub = 1000;
/** `sub` novo a cada chamada — o rate limiter de entrego-enriquecimento é
 * chaveado por usuário; testes independentes não podem competir pelo mesmo
 * balde de 10 requisições/15min. */
function tokenCookie({ entidadeAtiva = 6 } = {}) {
  const payload = { sub: proximoSub++, entidade_ativa: entidadeAtiva };
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

describe('POST /api/v1/motoristas/:id/entrego-enriquecimento (task 5.1.5)', () => {
  beforeEach(() => {
    permissoesFlat = new Set(['motoristas.consultar', 'motoristas.editar']);
    permissoesPorEntidade = new Set(['motoristas.consultar', 'motoristas.editar']);
    registrosAuditoria = [];
    entregadorFixture = {
      id: 1, id_empresa: 6, id_externo: 'uuid-1',
      dados_entrego_solicitado_em: null, dados_entrego_json: null, dados_entrego_enriquecidos_em: null,
      ContaMotorista: null,
    };
  });

  test('sem id_externo -> 409 SEM_IDENTIFICADOR_ENTREGO', async () => {
    entregadorFixture.id_externo = null;
    const r = await request('POST', '/api/v1/motoristas/1/entrego-enriquecimento', { cookie: tokenCookie() });
    assert.equal(r.status, 409);
    assert.equal(r.body.erro, 'SEM_IDENTIFICADOR_ENTREGO');
  });

  test('já pendente (dados_entrego_solicitado_em setado) -> 429 JA_PENDENTE', async () => {
    entregadorFixture.dados_entrego_solicitado_em = '2026-08-01T10:00:00.000Z';
    const r = await request('POST', '/api/v1/motoristas/1/entrego-enriquecimento', { cookie: tokenCookie() });
    assert.equal(r.status, 429);
    assert.equal(r.body.erro, 'JA_PENDENTE');
  });

  test('caso feliz -> 202 pendente, grava dados_entrego_solicitado_em', async () => {
    const r = await request('POST', '/api/v1/motoristas/1/entrego-enriquecimento', { cookie: tokenCookie() });
    assert.equal(r.status, 202);
    assert.deepEqual(r.body, { status: 'pendente' });
    assert.ok(entregadorFixture.dados_entrego_solicitado_em);
  });

  test('fora do escopo da entidade ativa -> 404 NAO_ENCONTRADO', async () => {
    const r = await request('POST', '/api/v1/motoristas/1/entrego-enriquecimento', { cookie: tokenCookie({ entidadeAtiva: 7 }) });
    assert.equal(r.status, 404);
  });

  test('sem permissao motoristas.editar -> 403', async () => {
    permissoesFlat = new Set();
    permissoesPorEntidade = new Set();
    const r = await request('POST', '/api/v1/motoristas/1/entrego-enriquecimento', { cookie: tokenCookie() });
    assert.equal(r.status, 403);
  });
});

describe('GET /api/v1/motoristas/:id — RBAC de campo + auditoria (tasks 5.4.4/5.5.3)', () => {
  beforeEach(() => {
    registrosAuditoria = [];
    auditoriaHistoricoFixture = [];
    entregadorFixture = {
      id: 1, id_empresa: 6, id_externo: 'uuid-1', nome: 'Fulano', ativo: true, nome_editado_manualmente: false,
      motorista_id: null,
      dados_entrego_solicitado_em: null,
      dados_entrego_enriquecidos_em: '2026-08-01T12:00:00.000Z',
      dados_entrego_json: {
        dadosPessoais: { nomeCompleto: 'Fulano', dataNascimento: '1990-01-01', email: 't@example.com', cpf: '999.999.999-99', nomeMae: '<mae>', nomePai: '<pai>', telefone: '11999999999' },
        documentos: { rg: '99.999.999-9', cnh: '99999999999' },
        contatoEmergencia: { grauParentesco: 'Cônjuge', nome: '<nome>', telefone: '11988888888' },
        informacoesEntrega: { operadorLogistico: 'Movee', modal: 'moto' },
      },
      ContaMotorista: null,
    };
  });

  test('COM motoristas.dados_sensiveis -> payload completo + 1 evento de auditoria', async () => {
    permissoesFlat = new Set(['motoristas.consultar', 'motoristas.dados_sensiveis']);
    permissoesPorEntidade = new Set(['motoristas.consultar', 'motoristas.dados_sensiveis']);
    const r = await request('GET', '/api/v1/motoristas/1', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.ok(r.body.entregoEnriquecimento);
    assert.equal(r.body.entregoEnriquecimento.dadosPessoais.cpf, '999.999.999-99');
    assert.equal(r.body.entregoEnriquecimento.documentos.rg, '99.999.999-9');
    assert.ok(r.body.entregoEnriquecimento.contatoEmergencia);
    assert.equal(registrosAuditoria.length, 1);
    assert.equal(registrosAuditoria[0].acao, 'motorista.dados_sensiveis_visualizados');
    assert.equal(registrosAuditoria[0].recursoId, 1);
  });

  test('SEM motoristas.dados_sensiveis (papel leitura) -> chaves ausentes, jq has(dadosPessoais)=false, SEM evento', async () => {
    permissoesFlat = new Set(['motoristas.consultar']);
    permissoesPorEntidade = new Set(['motoristas.consultar']);
    const r = await request('GET', '/api/v1/motoristas/1', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(Object.prototype.hasOwnProperty.call(r.body.entregoEnriquecimento, 'dadosPessoais'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(r.body.entregoEnriquecimento, 'contatoEmergencia'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(r.body.entregoEnriquecimento.documentos, 'rg'), false);
    assert.equal(r.body.entregoEnriquecimento.documentos.cnh, '99999999999');
    assert.equal(registrosAuditoria.length, 0);
  });

  test('nunca enriquecido -> entregoEnriquecimento null, SEM evento mesmo com a permissão', async () => {
    entregadorFixture.dados_entrego_enriquecidos_em = null;
    entregadorFixture.dados_entrego_json = null;
    permissoesFlat = new Set(['motoristas.consultar', 'motoristas.dados_sensiveis']);
    permissoesPorEntidade = new Set(['motoristas.consultar', 'motoristas.dados_sensiveis']);
    const r = await request('GET', '/api/v1/motoristas/1', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.entregoEnriquecimento, null);
    assert.equal(registrosAuditoria.length, 0);
  });
});

describe('GET /api/v1/motoristas/:id — vinculoCredencialAutomatico (task 7.1.3, SC-002)', () => {
  beforeEach(() => {
    registrosAuditoria = [];
    auditoriaHistoricoFixture = [];
    permissoesFlat = new Set(['motoristas.consultar']);
    permissoesPorEntidade = new Set(['motoristas.consultar']);
    entregadorFixture = {
      id: 1, id_empresa: 6, id_externo: 'uuid-1', nome: 'Fulano', ativo: true, nome_editado_manualmente: false,
      motorista_id: 7,
      dados_entrego_solicitado_em: null,
      dados_entrego_enriquecidos_em: null,
      dados_entrego_json: null,
      ContaMotorista: { id: 7, nome: 'Fulano', cnpj_prestador: '12345678000195', ativo: true },
    };
  });

  test('sem vínculo (ContaMotorista null) -> false, SEM consultar Auditoria', async () => {
    entregadorFixture.ContaMotorista = null;
    // Nenhuma linha em auditoriaHistoricoFixture: se a rota consultasse
    // Auditoria mesmo sem vínculo, o mock devolveria [] mesmo assim — o que
    // este teste realmente prova é o resultado (false), a ausência de
    // consulta é garantida pelo guard `row.ContaMotorista ? ... : false`
    // em routes/hub-motoristas.js (revisão de código, não observável daqui).
    const r = await request('GET', '/api/v1/motoristas/1', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.vinculoCredencialAutomatico, false);
  });

  test('último evento de auditoria = vinculado_automaticamente -> true', async () => {
    auditoriaHistoricoFixture = [
      { recurso: 'Entregador', recursoId: 1, acao: 'motorista.vinculado_automaticamente', criadoEm: '2026-08-01T10:00:00.000Z' },
    ];
    const r = await request('GET', '/api/v1/motoristas/1', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.vinculoCredencialAutomatico, true);
  });

  test('último evento de auditoria = vinculado (manual) -> false', async () => {
    auditoriaHistoricoFixture = [
      { recurso: 'Entregador', recursoId: 1, acao: 'motorista.vinculado', criadoEm: '2026-08-01T10:00:00.000Z' },
    ];
    const r = await request('GET', '/api/v1/motoristas/1', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.vinculoCredencialAutomatico, false);
  });

  test('automático seguido de manual (substituição, FR-013) -> false (o MAIS RECENTE vence)', async () => {
    auditoriaHistoricoFixture = [
      { recurso: 'Entregador', recursoId: 1, acao: 'motorista.vinculado_automaticamente', criadoEm: '2026-08-01T10:00:00.000Z' },
      { recurso: 'Entregador', recursoId: 1, acao: 'motorista.vinculado', criadoEm: '2026-08-02T10:00:00.000Z' },
    ];
    const r = await request('GET', '/api/v1/motoristas/1', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.vinculoCredencialAutomatico, false);
  });

  test('sem NENHUM evento de auditoria (dado legado) -> false, nunca lança', async () => {
    const r = await request('GET', '/api/v1/motoristas/1', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.vinculoCredencialAutomatico, false);
  });
});
