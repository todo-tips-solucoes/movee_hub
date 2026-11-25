/**
 * POST /api/v1/importacoes — bloqueio de layout NO UPLOAD (antes de dedupe,
 * INSERT e armazenamento). Rodam com:
 *   node --test tests/hub-importacoes-layout-rota.test.js
 *
 * Mesma técnica de tests/hub-robo-entrego-unit.test.js (Module._load mocka
 * RBAC/auditoria/PostgREST/storage/processor; JWT real). Os stubs registram
 * chamadas para provar que um layout errado NÃO grava nada.
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-unit-importacoes-layout';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

let chamadasPostgrest = [];
let armazenados = [];
let processados = [];

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../lib/hub-rbac-cache') {
    const perms = new Set(['importacoes.criar']);
    return { obterPermissoesEfetivas: async () => perms, obterPermissoesEfetivasPorEntidade: async () => perms };
  }
  if (request === '../lib/hub-auditoria') return { registrarAuditoria: async () => {} };
  if (request === '../lib/hub-postgrest') {
    return {
      hubPostgrestRequest: async (path, method, body) => {
        chamadasPostgrest.push({ path, method, body });
        return method === 'POST' ? [{ id: 77 }] : [];
      },
    };
  }
  if (request === '../lib/hub-import-storage') {
    const real = originalLoad.apply(this, arguments);
    return { ...real, armazenarOriginal: async (...a) => { armazenados.push(a); } };
  }
  if (request === '../lib/hub-import-processor') {
    return { processarImportacao: (...a) => { processados.push(a); return Promise.resolve(); } };
  }
  return originalLoad.apply(this, arguments);
};

const express = require('express');
const cookieParser = require('cookie-parser');
const { router } = require('../routes/hub-importacoes.js');
const { HEADER_PERFORMANCE, HEADER_FATURAMENTO } = require('../lib/hub-import-normalizer');

Module._load = originalLoad;

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1/importacoes', router);

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => { chamadasPostgrest = []; armazenados = []; processados = []; });

async function enviar(tipo, csv, nome = 'arquivo.csv') {
  const token = jwt.sign({ sub: 1, entidade_ativa: 6 }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
  const form = new FormData();
  form.append('tipo', tipo);
  form.append('file', new Blob([csv], { type: 'text/csv' }), nome);
  const res = await fetch(`${baseUrl}/api/v1/importacoes`, { method: 'POST', body: form, headers: { Cookie: `hub_accessToken=${token}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const MODELO_ENVIO_MASSA = 'uuid;number;nome;valor;mensagem1;mensagem2;enviado;retorno_envio_msg_1;retorno_envio_msg_2;tribnac;cnpj_tomador;cnpj_prestador;gorjeta\n1;2;a;3;;;;;;;;;\n';

function provarNadaGravado() {
  assert.deepEqual(chamadasPostgrest, [], 'nenhum GET de dedupe nem INSERT');
  assert.equal(armazenados.length, 0, 'original não armazenado');
  assert.equal(processados.length, 0, 'processor não disparado');
}

describe('POST /importacoes — layout', () => {
  test('modelo de envio em massa -> 422 layout_invalido, nada gravado', async () => {
    const r = await enviar('performance', MODELO_ENVIO_MASSA);
    assert.equal(r.status, 422);
    assert.deepEqual(r.body, { error: 'INVALIDO', motivo: 'layout_invalido' });
    provarNadaGravado();
  });

  test('layout do outro tipo -> 422 layout_de_outro_tipo, nada gravado', async () => {
    const r = await enviar('faturamento', `${HEADER_PERFORMANCE.join(';')}\n1\n`);
    assert.equal(r.status, 422);
    assert.deepEqual(r.body, { error: 'INVALIDO', motivo: 'layout_de_outro_tipo' });
    provarNadaGravado();
  });

  test('layout correto segue o fluxo: dedupe, INSERT, armazenamento (201)', async () => {
    const r = await enviar('faturamento', `${HEADER_FATURAMENTO.join(';')}\n1\n`);
    assert.equal(r.status, 201);
    assert.deepEqual(chamadasPostgrest.map((c) => c.method), ['GET', 'POST']);
    assert.equal(armazenados.length, 1);
  });
});
