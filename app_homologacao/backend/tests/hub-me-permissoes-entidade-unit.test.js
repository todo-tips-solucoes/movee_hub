/**
 * GET /api/v1/me devolve `permissoesEntidadeAtiva` (motorista-cadastro-hub F1):
 * as permissões RESTRITAS à entidade ativa — o que o gate do servidor usa —, ao
 * lado da união `permissoes` (só navegação). Sem entidade ativa, lista vazia.
 *   node --test tests/hub-me-permissoes-entidade-unit.test.js
 *
 * Express real + accessToken JWT real; só a camada de dados é mockada
 * (Module._load), mesma técnica de hub-usuarios-trava-unit.test.js.
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-unit-hub-me-perm';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const Module = require('module');

const UNIAO = new Set(['motoristas.consultar', 'envio_massa.aprovar', 'envio_massa.criar']);
const POR_ENTIDADE = { 6: new Set(['envio_massa.consultar']), 7: new Set(['envio_massa.aprovar']) };
const chamadasPorEntidade = [];

async function fakePostgrest(caminho) {
  if (caminho.startsWith('Usuario?id=')) return [{ id: 1, email: 'a@a.com', nome: 'A', ativo: true }];
  if (caminho.startsWith('UsuarioEntidade?')) {
    return [6, 7].map((id) => ({ empresa_id: id, ativo: true, papel: { nome: 'financeiro' } }));
  }
  if (caminho.startsWith('Empresa?')) return [];
  if (caminho.startsWith('ModuloEntidade?')) return [];
  throw new Error(`mock não suporta: ${caminho}`);
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../lib/hub-rbac-cache') {
    return {
      obterPermissoesEfetivas: async () => UNIAO,
      obterPermissoesEfetivasPorEntidade: async (_u, empresa) => {
        chamadasPorEntidade.push(empresa);
        return POR_ENTIDADE[empresa] || new Set();
      },
      usuarioEhAdminPlataforma: async () => false,
    };
  }
  if (request === '../lib/hub-postgrest' || request === './hub-postgrest') {
    return { hubPostgrestRequest: fakePostgrest };
  }
  if (request === '../lib/hub-auditoria') return { registrarAuditoria: async () => {} };
  return originalLoad.apply(this, arguments);
};

const express = require('express');
const cookieParser = require('cookie-parser');
const { router } = require('../routes/hub-me');
const { COOKIE_ACCESS } = require('../lib/hub-access-token');

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1/me', router);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  Module._load = originalLoad;
  server.close();
});

function getMe(entidadeAtiva) {
  const claims = { sub: 1, email: 'a@a.com' };
  if (entidadeAtiva !== undefined) claims.entidade_ativa = entidadeAtiva;
  const token = jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: '15m' });
  return new Promise((resolve, reject) => {
    http.get(`${base}/api/v1/me`, { headers: { Cookie: `${COOKIE_ACCESS}=${token}` } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
    }).on('error', reject);
  });
}

test('devolve as permissões só da entidade ativa, separadas da união', async () => {
  const r = await getMe(7);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.permissoesEntidadeAtiva, ['envio_massa.aprovar']);
  assert.deepEqual(new Set(r.body.permissoes), UNIAO);
  assert.deepEqual(chamadasPorEntidade.at(-1), 7);
});

test('a outra entidade NÃO herda a permissão que só existe na primeira', async () => {
  const r = await getMe(6);
  assert.deepEqual(r.body.permissoesEntidadeAtiva, ['envio_massa.consultar']);
});

test('sem entidade ativa a lista é vazia e o cache por entidade nem é consultado', async () => {
  const antes = chamadasPorEntidade.length;
  const r = await getMe();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.permissoesEntidadeAtiva, []);
  assert.equal(chamadasPorEntidade.length, antes);
});
