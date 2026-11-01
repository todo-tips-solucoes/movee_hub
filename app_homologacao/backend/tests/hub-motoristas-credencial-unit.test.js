/**
 * Unit — rotas REAIS de credencial do motorista (routes/hub-motoristas.js) com o PostgREST simulado em memória.
 *   node --test tests/hub-motoristas-credencial-unit.test.js
 *
 * Frente motorista-cadastro-hub (F2). Substitui o teste do antigo `espelharSenhaNoLegado` (que usava um mock que
 * NUNCA devolvia "0 linhas" — o próprio defeito). Aqui o handler que roda é o de produção; o que se simula é só o
 * PostgREST, e ele devolve 0 linhas onde o banco real devolveria.
 *
 * O que se prova:
 *   - o espelho por HTTP SAIU: nenhuma rota de credencial escreve em `Motorista` (quem sincroniza é o gatilho da 0123);
 *   - gate Movee nas 4 rotas: entidade fora do grupo -> 422 e ZERO escritas;
 *   - POST recusa `credencial_existente` quando a conta já tem senha, ou o legado (conta ainda inexistente) tem;
 *   - o VÍNCULO é gravado ANTES da senha; se o vínculo é recusado (índice único), a senha nunca é gravada.
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('module');

// ── PostgREST simulado ──────────────────────────────────────────────────────────────────────────────────
const DB = {};
let escritas = [];
let falharVinculoCom = null; // status HTTP que o PATCH de Entregador deve lançar (índice único)
let proximoId = 500;
let entidadeGrupoMovee = true;

function reset() {
  DB.Entregador = [{ id: 7, id_empresa: 6, nome: 'Fulano de Tal', motorista_id: null }];
  DB.ContaMotorista = [];
  DB.Motorista = []; // legado: "0 linhas" por padrão
  escritas = [];
  falharVinculoCom = null;
  proximoId = 500;
  entidadeGrupoMovee = true;
}

function filtrar(tabela, query) {
  let linhas = [...(DB[tabela] || [])];
  for (const [k, v] of new URLSearchParams(query || '')) {
    if (k === 'select') continue;
    const [op, ...resto] = v.split('.');
    const valor = resto.join('.');
    linhas = linhas.filter((r) => (op === 'neq' ? String(r[k]) !== valor : String(r[k]) === valor));
  }
  return linhas;
}

async function postgrestFalso(endpoint, metodo = 'GET', corpo = null) {
  const [tabela, query] = endpoint.split('?');
  if (metodo === 'GET') {
    if (tabela === 'EmpresaGrupoMovee') return entidadeGrupoMovee ? [{ id_empresa: 6 }] : [];
    return filtrar(tabela, query);
  }
  escritas.push({ tabela, metodo, corpo, query });
  if (tabela === 'Entregador' && falharVinculoCom) {
    const e = new Error('hub-postgrest: indice unico'); e.status = falharVinculoCom; throw e;
  }
  if (metodo === 'POST' && tabela === 'ContaMotorista') {
    const nova = { id: proximoId++, ...corpo };
    DB.ContaMotorista.push(nova);
    return [nova];
  }
  if (metodo === 'PATCH') {
    for (const r of filtrar(tabela, query)) Object.assign(r, corpo);
  }
  return null;
}

// ── carrega a rota REAL com as dependências de I/O trocadas ─────────────────────────────────────────────
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../lib/hub-postgrest') return { hubPostgrestRequest: postgrestFalso };
  if (request === '../lib/hub-access-token') {
    return {
      lerAccessTokenDoRequest: () => 'tok',
      decodificarAccessToken: () => ({ sub: 1, entidade_ativa: 6 }),
    };
  }
  if (request === '../lib/hub-rbac-cache') {
    const perms = async () => new Set(['motoristas.credencial']);
    return { obterPermissoesEfetivas: perms, obterPermissoesEfetivasPorEntidade: perms };
  }
  if (request === '../lib/hub-auditoria') return { registrarAuditoria: async () => {} };
  return originalLoad.apply(this, arguments);
};
const express = require('express');
const { router } = require('../routes/hub-motoristas');
Module._load = originalLoad;

const app = express();
app.use(express.json());
app.use('/motoristas', router);

let server;
let baseUrl;
before(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(reset);

function chamar(metodo, caminho, corpo) {
  return new Promise((resolve, reject) => {
    const url = new URL(caminho, baseUrl);
    const dados = corpo ? JSON.stringify(corpo) : undefined;
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname, method: metodo,
      headers: dados ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(dados) } : {},
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    req.on('error', reject);
    if (dados) req.write(dados);
    req.end();
  });
}

const CNPJ = '12345678000195';
const escritasEm = (tabela) => escritas.filter((e) => e.tabela === tabela);

describe('POST /motoristas/:id/credencial', () => {
  test('conta nova: cria SEM senha, VINCULA, e só então grava a senha (ordem exata)', async () => {
    const r = await chamar('POST', '/motoristas/7/credencial', { cnpjPrestador: CNPJ, senhaInicial: 'SenhaForte1' });
    assert.equal(r.status, 201);
    assert.deepEqual(
      escritas.map((e) => `${e.metodo} ${e.tabela}${e.corpo && 'senha' in e.corpo ? ' (senha)' : ''}`),
      ['POST ContaMotorista', 'PATCH Entregador', 'PATCH ContaMotorista (senha)'],
    );
    assert.equal('senha' in escritas[0].corpo, false, 'a conta nasce sem senha');
    assert.equal(escritas[1].corpo.motorista_id, 500);
    assert.match(escritas[2].corpo.senha, /^\$2[aby]\$12\$/, 'bcrypt custo 12');
  });

  test('NUNCA escreve em `Motorista` (o gatilho da 0123 sincroniza) — nem com o legado em "0 linhas"', async () => {
    // DB.Motorista está vazio: é exatamente o caso em que o antigo espelho "dava ok" sem gravar nada
    const r = await chamar('POST', '/motoristas/7/credencial', { cnpjPrestador: CNPJ, senhaInicial: 'SenhaForte1' });
    assert.equal(r.status, 201);
    assert.equal(escritasEm('Motorista').length, 0);
  });

  test('vínculo recusado pelo índice único (409): a senha NUNCA é gravada', async () => {
    falharVinculoCom = 409;
    const r = await chamar('POST', '/motoristas/7/credencial', { cnpjPrestador: CNPJ, senhaInicial: 'SenhaForte1' });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, { erro: 'credencial_existente' });
    assert.equal(escritas.filter((e) => e.corpo && 'senha' in e.corpo).length, 0, 'nenhuma escrita de senha');
  });

  test('conta existente SEM senha, sem vínculo: reaproveita, vincula e grava a senha', async () => {
    DB.ContaMotorista.push({ id: 90, cnpj_prestador: CNPJ, nome: 'Fulano', senha: null });
    const r = await chamar('POST', '/motoristas/7/credencial', { cnpjPrestador: CNPJ, senhaInicial: 'SenhaForte1' });
    assert.equal(r.status, 201);
    assert.deepEqual(escritas.map((e) => `${e.metodo} ${e.tabela}`), ['PATCH Entregador', 'PATCH ContaMotorista']);
  });

  test('conta existente COM senha -> 409 credencial_existente e ZERO escritas (não sobrescreve)', async () => {
    DB.ContaMotorista.push({ id: 90, cnpj_prestador: CNPJ, nome: 'Fulano', senha: '$2b$10$hashDoMotorista' });
    const r = await chamar('POST', '/motoristas/7/credencial', { cnpjPrestador: CNPJ, senhaInicial: 'SenhaForte1' });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, { erro: 'credencial_existente' });
    assert.equal(escritas.length, 0);
  });

  test('sem conta, mas o legado já tem senha (se cadastrou pelo app) -> 409 e ZERO escritas', async () => {
    DB.Motorista.push({ cnpj_prestador: CNPJ, senha: '$2b$10$hashDoApp' });
    const r = await chamar('POST', '/motoristas/7/credencial', { cnpjPrestador: CNPJ, senhaInicial: 'SenhaForte1' });
    assert.equal(r.status, 409);
    assert.equal(escritas.length, 0);
  });

  test('legado SEM senha (pré-cadastro do upload) não bloqueia', async () => {
    DB.Motorista.push({ cnpj_prestador: CNPJ, senha: null });
    const r = await chamar('POST', '/motoristas/7/credencial', { cnpjPrestador: CNPJ, senhaInicial: 'SenhaForte1' });
    assert.equal(r.status, 201);
  });

  test('conta já vinculada a outro Entregador da entidade -> 409 e ZERO escritas', async () => {
    DB.ContaMotorista.push({ id: 90, cnpj_prestador: CNPJ, nome: 'Fulano', senha: null });
    DB.Entregador.push({ id: 8, id_empresa: 6, nome: 'Outro', motorista_id: 90 });
    const r = await chamar('POST', '/motoristas/7/credencial', { cnpjPrestador: CNPJ, senhaInicial: 'SenhaForte1' });
    assert.equal(r.status, 409);
    assert.equal(escritas.length, 0);
  });

  test('CNPJ que não tem 14 dígitos -> 422 cnpj_invalido, sem tocar no banco', async () => {
    for (const cnpj of ['123', '1234567800019', '123456780001955']) {
      const r = await chamar('POST', '/motoristas/7/credencial', { cnpjPrestador: cnpj });
      assert.equal(r.status, 422);
      assert.equal(r.body.erro, 'cnpj_invalido');
    }
    assert.equal(escritas.length, 0);
  });

  test('entidade FORA do grupo Movee -> 422 entidade_fora_do_grupo e ZERO escritas', async () => {
    entidadeGrupoMovee = false;
    const r = await chamar('POST', '/motoristas/7/credencial', { cnpjPrestador: CNPJ });
    assert.equal(r.status, 422);
    assert.deepEqual(r.body, { erro: 'INVALIDO', motivo: 'entidade_fora_do_grupo' });
    assert.equal(escritas.length, 0);
  });
});

describe('demais rotas de credencial', () => {
  beforeEach(() => {
    DB.Entregador[0].motorista_id = 90;
    DB.ContaMotorista.push({ id: 90, cnpj_prestador: CNPJ, nome: 'Fulano', senha: '$2b$12$x', ativo: true });
  });

  test('reset-senha: grava só em ContaMotorista, sem `espelhoLegado` na resposta', async () => {
    const r = await chamar('POST', '/motoristas/7/credencial/reset-senha');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.match(r.body.tokenDefinicao, /^[0-9a-f]{64}$/);
    assert.equal('espelhoLegado' in r.body, false);
    assert.deepEqual(escritas.map((e) => `${e.metodo} ${e.tabela}`), ['PATCH ContaMotorista']);
    assert.equal(escritas[0].corpo.senha, null);
  });

  test('PATCH ativo: grava só em ContaMotorista (o G2 da 0123 leva ao legado)', async () => {
    const r = await chamar('PATCH', '/motoristas/7/credencial', { ativo: false });
    assert.equal(r.status, 200);
    assert.deepEqual(escritas.map((e) => `${e.metodo} ${e.tabela}`), ['PATCH ContaMotorista']);
  });

  for (const [rotulo, metodo, caminho, corpo] of [
    ['reset-senha', 'POST', '/motoristas/7/credencial/reset-senha', undefined],
    ['definir', 'POST', '/motoristas/7/credencial/reset-senha/definir', { token: 'a'.repeat(64), novaSenha: 'SenhaForte1' }],
    ['PATCH ativo', 'PATCH', '/motoristas/7/credencial', { ativo: false }],
  ]) {
    test(`${rotulo}: entidade fora do grupo Movee -> 422 e ZERO escritas`, async () => {
      entidadeGrupoMovee = false;
      const r = await chamar(metodo, caminho, corpo);
      assert.equal(r.status, 422);
      assert.equal(r.body.motivo, 'entidade_fora_do_grupo');
      assert.equal(escritas.length, 0);
    });
  }

  test('definir: grava só em ContaMotorista (sem segundo PATCH no legado)', async () => {
    const crypto = require('node:crypto');
    const token = 'b'.repeat(64);
    DB.ContaMotorista[0].token_reset_hash = crypto.createHash('sha256').update(token).digest('hex');
    DB.ContaMotorista[0].token_reset_expira = new Date(Date.now() + 60000).toISOString();
    const r = await chamar('POST', '/motoristas/7/credencial/reset-senha/definir', { token, novaSenha: 'SenhaForte1' });
    assert.equal(r.status, 200);
    assert.deepEqual(escritas.map((e) => `${e.metodo} ${e.tabela}`), ['PATCH ContaMotorista']);
    assert.equal(escritasEm('Motorista').length, 0);
  });
});
