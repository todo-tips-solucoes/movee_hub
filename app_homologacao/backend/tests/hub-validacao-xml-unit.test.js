/**
 * Testes unitários — routes/hub-validacao-xml.js (F4b nota-pendente-motorista).
 * node --test tests/hub-validacao-xml-unit.test.js
 *
 * Mesma técnica de hub-adiantamentos-rotas-unit.test.js: express real, JWT real,
 * cadeia de guarda de verdade; só a camada de dados é falsa. O fake do
 * PostgREST APLICA os filtros da query sobre uma tabela em memória (escopo,
 * regularizada_em, ordem, range) — assim, desfazer um filtro na rota quebra
 * teste de verdade, em vez de passar porque o fake devolveu o que se esperava.
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-unit-hub-validacao-xml';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');

let permissoes = new Set(['validacao_xml.validar']);
let modulosAtivos = new Set(['validacao_xml']);
let admin = false;
let tabela = [];
let chamadas = [];

function linha(id, idEmpresa, regularizadaEm, extra = {}) {
  return {
    id, id_empresa: idEmpresa, nome: `Motorista ${id}`, cnpj_prestador: `1000000000${String(id).padStart(4, '0')}`,
    valor: '100.00', dt_inicial: '2026-09-01', dt_final: '2026-09-07', regularizada_em: regularizadaEm,
    nota_ok: 'https://xml/x.xml', erro_validacao: null, ...extra,
  };
}

// Fake do PostgREST: interpreta só os operadores que a rota usa.
async function fakePostgrest(endpoint, method, body, claims, opts) {
  chamadas.push({ endpoint, claims, opts });
  const [caminho, query] = endpoint.split('?');
  assert.equal(caminho, 'EnvioMassa');
  const q = new URLSearchParams(query);
  let rows = tabela.slice();
  if (q.get('regularizada_em') === 'not.is.null') rows = rows.filter((r) => r.regularizada_em != null);
  const emp = (q.get('id_empresa') || '').match(/^in\.\((.*)\)$/);
  if (emp) {
    const ids = emp[1].split(',').map(Number);
    rows = rows.filter((r) => ids.includes(r.id_empresa));
  }
  if (q.get('order') === 'regularizada_em.desc') rows.sort((a, b) => String(b.regularizada_em).localeCompare(String(a.regularizada_em)));
  const total = rows.length;
  if (opts && opts.range) rows = rows.slice(opts.range.from, opts.range.to + 1);
  return { data: rows, total };
}

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === '../lib/hub-rbac-cache') {
    return {
      obterPermissoesEfetivas: async () => permissoes,
      obterPermissoesEfetivasPorEntidade: async () => permissoes,
      obterModulosAtivosPorEntidade: async () => modulosAtivos,
      usuarioEhAdminPlataforma: async () => admin,
    };
  }
  if (request === './grupo') {
    return {
      mesmoGrupoQue: async (_id, _ref, cache) => { cache.ids = new Set([6, 7]); return true; },
    };
  }
  if (request === '../lib/hub-postgrest') return { hubPostgrestRequest: (...a) => fakePostgrest(...a) };
  return originalLoad.apply(this, arguments);
};
const express = require('express');
const cookieParser = require('cookie-parser');
const { router } = require('../routes/hub-validacao-xml.js');
Module._load = originalLoad;

const app = express();
app.use(cookieParser());
app.use('/api/v1/validacao-xml', router);

let server;
let baseUrl;
let sub = 1;

function get(path, cookie) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET', headers: cookie ? { Cookie: cookie } : {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function cookie(entidadeAtiva = 9001) {
  const t = jwt.sign({ sub: sub++, entidade_ativa: entidadeAtiva }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
  return `hub_accessToken=${t}`;
}

const URL_R = '/api/v1/validacao-xml/regularizadas';

before(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => {
  permissoes = new Set(['validacao_xml.validar']);
  modulosAtivos = new Set(['validacao_xml']);
  admin = false;
  chamadas = [];
  tabela = [];
});

describe('GET /validacao-xml/regularizadas', () => {
  test('ESCOPO: operador da entidade A não vê item da entidade B', async () => {
    tabela = [
      linha(1, 9001, '2026-10-10T10:00:00Z'),
      linha(2, 9002, '2026-10-10T11:00:00Z'), // outro cliente
      linha(3, 9002, '2026-10-10T12:00:00Z'),
    ];
    const r = await get(URL_R, cookie(9001));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.itens.map((i) => i.id), [1]);
    assert.equal(r.body.total, 1);
    assert.match(chamadas[0].endpoint, /id_empresa=in\.\(9001\)/);
  });

  test('ESCOPO: grupo Movee (entidade 6) enxerga as filiais do grupo, e só elas', async () => {
    tabela = [linha(1, 6, '2026-10-10T10:00:00Z'), linha(2, 7, '2026-10-10T11:00:00Z'), linha(3, 9002, '2026-10-10T12:00:00Z')];
    const r = await get(URL_R, cookie(6));
    assert.deepEqual(r.body.itens.map((i) => i.id).sort(), [1, 2]);
  });

  test('admin da plataforma vê de todas as empresas', async () => {
    admin = true;
    tabela = [linha(1, 9001, '2026-10-10T10:00:00Z'), linha(2, 9002, '2026-10-10T11:00:00Z')];
    const r = await get(URL_R, cookie(9001));
    assert.equal(r.body.itens.length, 2);
    assert.equal(chamadas[0].claims.adminPlataforma, true);
  });

  test('só traz regularizada_em não nulo', async () => {
    tabela = [linha(1, 9001, null), linha(2, 9001, '2026-10-10T10:00:00Z')];
    const r = await get(URL_R, cookie());
    assert.deepEqual(r.body.itens.map((i) => i.id), [2]);
  });

  test('ordem decrescente por regularizada_em (mais recentes primeiro)', async () => {
    tabela = [
      linha(1, 9001, '2026-10-08T10:00:00Z'),
      linha(2, 9001, '2026-10-10T10:00:00Z'),
      linha(3, 9001, '2026-10-09T10:00:00Z'),
    ];
    const r = await get(URL_R, cookie());
    assert.deepEqual(r.body.itens.map((i) => i.id), [2, 3, 1]);
  });

  test('teto de 100 itens, com a contagem total', async () => {
    tabela = Array.from({ length: 130 }, (_, i) => linha(i + 1, 9001, `2026-10-01T00:${String(i % 60).padStart(2, '0')}:00Z`));
    const r = await get(URL_R, cookie());
    assert.equal(r.body.itens.length, 100);
    assert.equal(r.body.total, 130);
    assert.equal(r.body.limite, 100);
  });

  test('status: nota_ok vem preenchido nas duas; aprovada só sem erro_validacao', async () => {
    tabela = [
      linha(1, 9001, '2026-10-10T10:00:00Z'),
      linha(2, 9001, '2026-10-10T09:00:00Z', { erro_validacao: 'valor divergente' }),
      linha(3, 9001, '2026-10-10T08:00:00Z', { nota_ok: null }),
    ];
    const r = await get(URL_R, cookie());
    const porId = Object.fromEntries(r.body.itens.map((i) => [i.id, i.notaAprovada]));
    assert.deepEqual(porId, { 1: true, 2: false, 3: false });
  });

  test('DTO: campos esperados e sem vazar a URL do XML nem o id_empresa', async () => {
    tabela = [linha(1, 9001, '2026-10-10T10:00:00Z')];
    const [item] = (await get(URL_R, cookie())).body.itens;
    assert.deepEqual(Object.keys(item).sort(), [
      'cnpjPrestador', 'dtFinal', 'dtInicial', 'id', 'nome', 'notaAprovada', 'regularizadaEm', 'valor',
    ]);
  });

  test('sem permissão -> 403 PERMISSAO_NEGADA', async () => {
    permissoes = new Set();
    const r = await get(URL_R, cookie());
    assert.equal(r.status, 403);
    assert.equal(r.body.erro, 'PERMISSAO_NEGADA');
  });

  test('módulo inativo -> 403 MODULO_DESABILITADO', async () => {
    modulosAtivos = new Set();
    const r = await get(URL_R, cookie());
    assert.equal(r.status, 403);
    assert.equal(r.body.erro, 'MODULO_DESABILITADO');
  });

  test('sem sessão -> 401', async () => {
    const r = await get(URL_R);
    assert.equal(r.status, 401);
  });
});
