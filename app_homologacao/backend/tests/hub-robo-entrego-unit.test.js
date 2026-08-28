/**
 * Testes unitários — routes/hub-robo-entrego.js (robo-entrego, tasks.md
 * FASE 2, 2.1.4). Rodam com: node --test tests/hub-robo-entrego-unit.test.js
 *
 * Mesma técnica de tests/hub-motorista-app-login.test.js: express real +
 * node:http + app.listen(0), mockando só `../lib/hub-rbac-cache` (RBAC) e
 * `../lib/hub-auditoria` (escrita) via Module._load — accessToken é um JWT
 * REAL assinado com JWT_SECRET, verificado de verdade por
 * lib/hub-access-token.js (nenhum mock nesse módulo).
 *
 * Cobre (2.1.4):
 *   - acao fora da allowlist -> 422
 *   - acao válida sem entidade_ativa no token -> 400
 *   - detalhes passa por scrubDetalhes antes de gravar (delegado a
 *     registrarAuditoria — aqui confirmamos que o handler REPASSA
 *     detalhes/claims corretamente para registrarAuditoria, que já tem sua
 *     própria suíte de scrub em tests/hub-auditoria-unit.test.js)
 *   - acao válida + entidade_ativa + permissão -> 201 { ok: true }
 *   - sem permissão na entidade ativa -> 403
 *
 * Ref: contracts/hub-api.md §POST /api/v1/robo-entrego/eventos.
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-unit-robo-entrego';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');

// ──────────────────────────────────────────────────────────────────────────
// Mock de RBAC/auditoria via Module._load (mesma técnica de
// tests/hub-motorista-app-login.test.js) — sem PostgREST real.
// ──────────────────────────────────────────────────────────────────────────
let permissoesPorEntidade = new Set(['importacoes.criar']);
let registrosAuditoria = [];

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
      { hostname: url.hostname, port: url.port, path: url.pathname, method, headers },
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

describe('POST /api/v1/robo-entrego/eventos', () => {
  beforeEach(() => {
    permissoesPorEntidade = new Set(['importacoes.criar']);
    registrosAuditoria = [];
  });

  test('sem cookie -> 401 NAO_AUTENTICADO', async () => {
    const r = await request('POST', '/api/v1/robo-entrego/eventos', {
      body: { acao: 'robo_entrego.sucesso' },
    });
    assert.equal(r.status, 401);
  });

  test('acao fora da allowlist -> 422 INVALIDO', async () => {
    const r = await request('POST', '/api/v1/robo-entrego/eventos', {
      body: { acao: 'robo_entrego.qualquer_coisa' },
      cookie: tokenCookie(),
    });
    assert.equal(r.status, 422);
    assert.equal(r.body.erro, 'INVALIDO');
    assert.equal(registrosAuditoria.length, 0);
  });

  test('acao valida sem entidade_ativa no token -> 400 ENTIDADE_NAO_SELECIONADA', async () => {
    const r = await request('POST', '/api/v1/robo-entrego/eventos', {
      body: { acao: 'robo_entrego.sucesso' },
      // null (não undefined): default de desestruturação só dispara em
      // undefined — null sobrevive ao JSON do JWT como payload.entidade_ativa
      // = null, exercitando o mesmo branch falsy que a claim ausente.
      cookie: tokenCookie({ entidadeAtiva: null }),
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.erro, 'ENTIDADE_NAO_SELECIONADA');
  });

  test('sem permissao importacoes.criar na entidade ativa -> 403 PERMISSAO_NEGADA', async () => {
    permissoesPorEntidade = new Set();
    const r = await request('POST', '/api/v1/robo-entrego/eventos', {
      body: { acao: 'robo_entrego.falha_definitiva' },
      cookie: tokenCookie(),
    });
    assert.equal(r.status, 403);
  });

  test('acao valida + entidade_ativa + permissao -> 201 ok, delega para registrarAuditoria com claims corretos', async () => {
    const r = await request('POST', '/api/v1/robo-entrego/eventos', {
      body: { acao: 'robo_entrego.falha_definitiva', detalhes: { motivo: 'timeout' } },
      cookie: tokenCookie({ sub: 42, entidadeAtiva: 6 }),
    });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body, { ok: true });
    assert.equal(registrosAuditoria.length, 1);
    const evento = registrosAuditoria[0];
    assert.equal(evento.idEmpresa, 6);
    assert.equal(evento.usuarioId, 42);
    assert.equal(evento.acao, 'robo_entrego.falha_definitiva');
    assert.equal(evento.recurso, 'RoboEntrego');
    assert.deepEqual(evento.detalhes, { motivo: 'timeout' });
    assert.deepEqual(evento.claims, { usuarioId: 42, empresaAtiva: 6, escopo: [6] });
  });

  test('detalhes ausente -> registrarAuditoria recebe objeto vazio (nunca undefined)', async () => {
    const r = await request('POST', '/api/v1/robo-entrego/eventos', {
      body: { acao: 'robo_entrego.suspeita_antibot' },
      cookie: tokenCookie(),
    });
    assert.equal(r.status, 201);
    assert.deepEqual(registrosAuditoria[0].detalhes, {});
  });
});
