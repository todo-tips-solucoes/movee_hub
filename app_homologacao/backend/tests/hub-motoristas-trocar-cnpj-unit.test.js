/**
 * Troca de CNPJ do motorista (frente motorista-cadastro-hub F3).
 * Testa o router REAL (routes/hub-motoristas.js) e o código REAL de lib/motorista-cnpj.js
 * (incluindo o trecho de PATCH /update-envio-massa/:id) — só a camada de dados é falsa
 * (Module._load). A RPC em si (0124) é provada em banco, não aqui.
 *   node --test tests/hub-motoristas-trocar-cnpj-unit.test.js
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-unit-trocar-cnpj';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');

let permissoes = new Set(['motoristas.credencial']);
let chamadas = [];
let auditorias = [];
let elegivel = true;
let rpcResposta;           // objeto => sucesso; Error => lança
let vinculoLinhas;
let contaLinhas;

function erroRpc(status, corpo) {
  const e = new Error('hub-postgrest: ' + status);
  e.status = status;
  e.body = JSON.stringify(corpo);
  return e;
}

async function fakePostgrest(endpoint, method = 'GET', body = null) {
  chamadas.push({ endpoint, method, body });
  if (endpoint.startsWith('EmpresaGrupoMovee')) return elegivel ? [{ id_empresa: 6 }] : [];
  if (endpoint.startsWith('Entregador?')) return vinculoLinhas;
  if (endpoint.startsWith('ContaMotorista?')) return contaLinhas;
  if (endpoint.startsWith('rpc/hub_motorista_trocar_cnpj')) {
    if (rpcResposta instanceof Error) throw rpcResposta;
    return rpcResposta;
  }
  throw new Error(`mock não suporta: ${endpoint}`);
}

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../lib/hub-rbac-cache') {
    return {
      obterPermissoesEfetivas: async () => permissoes,
      obterPermissoesEfetivasPorEntidade: async () => permissoes,
    };
  }
  if (request === '../lib/hub-postgrest') return { hubPostgrestRequest: async (...a) => fakePostgrest(...a) };
  if (request === '../lib/hub-auditoria') return { registrarAuditoria: async (a) => { auditorias.push(a); return { ok: true }; } };
  return originalLoad.apply(this, arguments);
};

const express = require('express');
const cookieParser = require('cookie-parser');
const hubMotoristas = require('../routes/hub-motoristas.js');
const lib = require('../lib/motorista-cnpj.js');

Module._load = originalLoad;

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1/motoristas', hubMotoristas.router);

let server;
let baseUrl;

function patch(path, body, cookie) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const str = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(str) };
    if (cookie) headers.Cookie = cookie;
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'PATCH', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        let b = txt; try { b = JSON.parse(txt); } catch { /* texto */ }
        resolve({ status: res.statusCode, body: b });
      });
    });
    req.on('error', reject);
    req.write(str);
    req.end();
  });
}

const cookie = () => `hub_accessToken=${jwt.sign({ sub: 77, entidade_ativa: 6 }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' })}`;
const URL_TROCA = '/api/v1/motoristas/12/credencial/cnpj';
const ANTIGO = '30111111000131';
const NOVO = '69222222000109';
const RPC_OK = { inalterado: false, conta: 1, motorista: 1, movimentos: 7, motoristaPrecadastroCriado: false, contaBancariaPjDesatualizada: true };

before(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => {
  permissoes = new Set(['motoristas.credencial']);
  chamadas = [];
  auditorias = [];
  elegivel = true;
  rpcResposta = RPC_OK;
  vinculoLinhas = [{ id: 12, motorista_id: 345 }];
  contaLinhas = [{ cnpj_prestador: ANTIGO }];
});

describe('PATCH /motoristas/:id/credencial/cnpj (router real)', () => {
  test('sucesso: chama a RPC com a empresa da SESSÃO, responde mascarado e audita sem CNPJ cru', async () => {
    const r = await patch(URL_TROCA, { cnpjPrestador: '69.222.222/0001-09', idEmpresa: 4, id_empresa: 4, p_id_empresa: 4 }, cookie());
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      id: 345, cnpjPrestador: '69.***.***/0001-**', movimentosMigrados: 7, inalterado: false, contaBancariaPjDesatualizada: true,
    });
    const rpc = chamadas.find((c) => c.endpoint.startsWith('rpc/'));
    assert.deepEqual(rpc.body, { p_cnpj_antigo: ANTIGO, p_cnpj_novo: NOVO, p_id_empresa: 6, p_modo: 'estrito' });
    const ent = chamadas.find((c) => c.endpoint.startsWith('Entregador?'));
    assert.match(ent.endpoint, /id_empresa=eq\.6/);
    assert.equal(auditorias.length, 1);
    assert.equal(auditorias[0].acao, 'motorista.cnpj_alterado');
    assert.equal(auditorias[0].idEmpresa, 6);
    assert.equal(auditorias[0].detalhes.cnpjAnterior, '30.***.***/0001-**');
    assert.equal(auditorias[0].detalhes.movimentosMigrados, 7);
    const dump = JSON.stringify([r.body, auditorias]);
    assert.ok(!dump.includes(ANTIGO) && !dump.includes(NOVO), 'CNPJ cru vazou na resposta/auditoria');
  });

  test('conflito (CNPJ novo já tem conta ou Motorista): 409, sem auditoria', async () => {
    rpcResposta = erroRpc(409, { code: '23505', message: 'CNPJ_CONFLITO' });
    const r = await patch(URL_TROCA, { cnpjPrestador: NOVO }, cookie());
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, { erro: 'CONFLITO', motivo: 'cnpj_ja_cadastrado' });
    assert.equal(auditorias.length, 0);
  });

  test('colisão UNIQUE vinda de gatilho (23505 sem a mensagem) também é 409, fail-closed', async () => {
    rpcResposta = erroRpc(409, { code: '23505', message: 'duplicate key value violates unique constraint' });
    assert.equal((await patch(URL_TROCA, { cnpjPrestador: NOVO }, cookie())).status, 409);
  });

  test('CNPJ inválido no corpo: 422 sem tocar o banco', async () => {
    for (const corpo of [{}, { cnpjPrestador: '123' }, { cnpjPrestador: 69222222000109 }, { outro: NOVO }]) {
      const r = await patch(URL_TROCA, corpo, cookie());
      assert.equal(r.status, 422, JSON.stringify(corpo));
    }
    assert.equal(chamadas.length, 0);
  });

  test('sem motoristas.credencial: 403 e nenhuma chamada ao banco', async () => {
    permissoes = new Set(['motoristas.editar']);
    const r = await patch(URL_TROCA, { cnpjPrestador: NOVO }, cookie());
    assert.equal(r.status, 403);
    assert.equal(chamadas.length, 0);
  });

  test('entidade fora do grupo Movee: 422 e a RPC não é chamada', async () => {
    elegivel = false;
    const r = await patch(URL_TROCA, { cnpjPrestador: NOVO }, cookie());
    assert.equal(r.status, 422);
    assert.equal(r.body.motivo, 'entidade_fora_do_grupo');
    assert.ok(!chamadas.some((c) => c.endpoint.startsWith('rpc/')));
  });

  test('Entregador sem conta vinculada (ou de outra empresa): 404', async () => {
    vinculoLinhas = [{ id: 12, motorista_id: null }];
    assert.equal((await patch(URL_TROCA, { cnpjPrestador: NOVO }, cookie())).status, 404);
    vinculoLinhas = [];
    assert.equal((await patch(URL_TROCA, { cnpjPrestador: NOVO }, cookie())).status, 404);
    assert.ok(!chamadas.some((c) => c.endpoint.startsWith('rpc/')));
  });

  test('CNPJ igual ao atual: 200 inalterado, sem auditoria', async () => {
    rpcResposta = { inalterado: true, conta: 0, motorista: 0, movimentos: 0, contaBancariaPjDesatualizada: false };
    const r = await patch(URL_TROCA, { cnpjPrestador: ANTIGO }, cookie());
    assert.equal(r.status, 200);
    assert.equal(r.body.inalterado, true);
    assert.equal(auditorias.length, 0);
  });

  test('falha de infra na RPC: 500 genérico', async () => {
    rpcResposta = erroRpc(500, { message: 'boom' });
    const r = await patch(URL_TROCA, { cnpjPrestador: NOVO }, cookie());
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { erro: 'ERRO_SERVIDOR' });
  });
});

describe('lib/motorista-cnpj — trocarCnpjDoMovimento (trecho real do PATCH /update-envio-massa/:id)', () => {
  let reqs;
  let movimentos;
  let rpc;
  const movee = async () => true;
  const naoMovee = async () => false;
  const request = async (ep, m = 'GET', b = null) => {
    reqs.push({ ep, m, b });
    if (ep.startsWith('EnvioMassa?id=')) return movimentos;
    if (ep.startsWith('rpc/')) { if (rpc instanceof Error) throw rpc; return rpc; }
    return [];
  };
  const chamar = (extra = {}) => lib.trocarCnpjDoMovimento({ id: 5, idEmp: 6, cnpjRaw: NOVO, request, mesmoGrupoQue: movee, ...extra });
  beforeEach(() => { reqs = []; movimentos = [{ cnpj_prestador: ANTIGO }]; rpc = RPC_OK; });

  test('grupo Movee: UMA chamada à RPC, nenhum PATCH direto em EnvioMassa/Motorista', async () => {
    assert.deepEqual(await chamar(), { ok: true });
    const rpcs = reqs.filter((r) => r.ep.startsWith('rpc/'));
    assert.equal(rpcs.length, 1);
    assert.deepEqual(rpcs[0].b, { p_cnpj_antigo: ANTIGO, p_cnpj_novo: NOVO, p_id_empresa: 6, p_modo: 'envio_massa' });
    assert.ok(!reqs.some((r) => r.m === 'PATCH' || r.ep.startsWith('Motorista')));
  });

  test('conflito de CNPJ no envio em massa: segue 200 (a RPC migra só os movimentos, contasMigradas=false), sem PATCH direto', async () => {
    rpc = { ...RPC_OK, contasMigradas: false, conta: 0, motorista: 0 };
    assert.deepEqual(await chamar(), { ok: true });
    assert.ok(!reqs.some((x) => x.m === 'PATCH'));
  });

  test('colisão UNIQUE inesperada vinda de gatilho: 409 fail-closed e nenhuma escrita', async () => {
    rpc = erroRpc(409, { code: '23505', message: 'duplicate key value violates unique constraint' });
    const r = await chamar();
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'CNPJ já cadastrado para outro motorista.');
    assert.ok(!reqs.some((x) => x.m === 'PATCH'));
  });

  test('CNPJ inválido: 400 antes de qualquer consulta', async () => {
    const r = await chamar({ cnpjRaw: '12' });
    assert.equal(r.status, 400);
    assert.equal(reqs.length, 0);
  });

  test('movimento de outra empresa/inexistente: 404 sem RPC', async () => {
    movimentos = [];
    assert.equal((await chamar()).status, 404);
    assert.ok(!reqs.some((r) => r.ep.startsWith('rpc/')));
  });

  test('CNPJ igual ao do movimento: no-op, sem RPC (idempotência)', async () => {
    assert.deepEqual(await chamar({ cnpjRaw: '30.111.111/0001-31' }), { ok: true });
    assert.ok(!reqs.some((r) => r.ep.startsWith('rpc/')));
  });

  test('fora do grupo Movee: só os movimentos da empresa, sem RPC e sem tocar Motorista (FR-013)', async () => {
    assert.deepEqual(await chamar({ mesmoGrupoQue: naoMovee }), { ok: true });
    assert.ok(!reqs.some((r) => r.ep.startsWith('rpc/') || r.ep.startsWith('Motorista')));
    const p = reqs.find((r) => r.m === 'PATCH');
    assert.match(p.ep, /^EnvioMassa\?id_empresa=eq\.6&cnpj_prestador=eq\.30111111000131$/);
    assert.deepEqual(p.b, { cnpj_prestador: NOVO });
  });

  test('falha de infra na RPC: 500 "Nada foi alterado", sem vazar detalhe', async () => {
    rpc = erroRpc(500, { message: 'segredo interno' });
    const r = await chamar();
    assert.equal(r.status, 500);
    assert.ok(!JSON.stringify(r.body).includes('segredo'));
  });
});

describe('lib/motorista-cnpj — puros', () => {
  test('validarTrocaCnpjBody aceita máscara e normaliza; recusa não-string e tamanho errado', () => {
    assert.deepEqual(lib.validarTrocaCnpjBody({ cnpjPrestador: '69.222.222/0001-09' }), { ok: true, cnpjPrestador: NOVO });
    assert.equal(lib.validarTrocaCnpjBody(null).ok, false);
    assert.equal(lib.validarTrocaCnpjBody({ cnpjPrestador: '1234567890123' }).ok, false);
  });
});
