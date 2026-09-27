/**
 * Testes unitários — trava de papéis restritos em routes/hub-usuarios.js
 * (repasse-saldo-minimo F2, tasks.md 2.1 "controle negativo" + 2.4 "trava
 * nas rotas de escrita de vínculo"). Rodam com:
 *   node --test tests/hub-usuarios-trava-unit.test.js
 *
 * Mesma técnica de tests/hub-adiantamentos-rotas-unit.test.js: express real
 * + node:http + app.listen(0), accessToken JWT REAL verificado por
 * lib/hub-access-token.js (a cadeia de guarda roda de verdade —
 * requireModuloAtivo/requirePermission não são mockados), mockando só a
 * camada de dados via Module._load: `../lib/hub-rbac-cache`,
 * `../lib/hub-postgrest` (e `./hub-postgrest`, usado por
 * lib/hub-entidade-nome.js), `../lib/hub-auditoria`.
 *
 * Controle negativo (2.1): este arquivo foi escrito e RODADO ANTES da trava
 * existir (routes/hub-usuarios.js sem a checagem `papelEhRestrito`) — nesse
 * momento as asserções de 403 PAPEL_RESTRITO abaixo FALHAVAM (a rota
 * respondia 200/201, provando o furo: FR-006..FR-012a descritos em
 * contracts/hub-usuarios-trava.md eram violados). Evidência (saída de
 * `node --test` antes/depois) em
 * docs/plans/repasse-saldo-minimo/EVIDENCIA-F2-CONTROLE-NEGATIVO.md.
 *
 * A parte que exige PostgREST/banco real (RLS de UsuarioEntidade, REVOKE em
 * Papel/PapelPermissao/Permissao/Modulo — migration 0097) fica pendente de
 * ambiente `hub-test-*`: driver em infra/hub/testes/hub-rbac-integration.sh
 * (cenários F2.1-F2.6, tasks.md 2.5).
 *
 * Ref: docs/specs/repasse-saldo-minimo/contracts/hub-usuarios-trava.md,
 * spec.md FR-006..FR-012b, tasks.md FASE 2.
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-unit-hub-usuarios-trava';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');

// ──────────────────────────────────────────────────────────────────────────
// Catálogo fixo de papéis (dec-008) — 2 restritos, 2 não-restritos
// ──────────────────────────────────────────────────────────────────────────
const PAPEL_FIXTURES = {
  1: { id: 1, nome: 'operador' },
  2: { id: 2, nome: 'admin_plataforma' },
  3: { id: 3, nome: 'financeiro_aprovador' },
  4: { id: 4, nome: 'financeiro' },
};

// ──────────────────────────────────────────────────────────────────────────
// Estado mutável dos fakes (resetado em beforeEach)
// ──────────────────────────────────────────────────────────────────────────
let permissoesPorEntidade = new Set(['usuarios.gerenciar']);
let modulosAtivos = new Set(['usuarios']);
let ehAdminPlataforma = false;
let registrosAuditoria = [];
let chamadasPostgrest = [];
let vinculosFixture = [];
let proximoUsuarioId = 1000;
let proximoVinculoId = 2000;

function resetFixtures() {
  permissoesPorEntidade = new Set(['usuarios.gerenciar']);
  modulosAtivos = new Set(['usuarios']);
  ehAdminPlataforma = false;
  registrosAuditoria = [];
  chamadasPostgrest = [];
  proximoUsuarioId = 1000;
  proximoVinculoId = 2000;
  // usuario 50: vínculo ATIVO com papel restrito (admin_plataforma) na empresa 6
  // usuario 51: vínculo ATIVO com papel NÃO restrito (operador) na empresa 6
  // usuario 52: sem vínculo em empresa 6 (alvo "limpo" p/ testes de criação de vínculo)
  // usuario 53 (CROSS-TENANT, block-009/dec-075): vínculo COMUM (operador)
  // ATIVO na empresa 6 (a do chamador) + vínculo admin_plataforma ATIVO na
  // empresa 7 (OUTRA empresa, fora do escopo do chamador) — cenário exato
  // do furo achado em 2.5.7: a trava antiga só enxergava o vínculo do alvo
  // NA ENTIDADE ATIVA do chamador (empresa 6), nunca via o de admin_plataforma
  // em 7, e liberava a alteração.
  vinculosFixture = [
    { id: 900, usuario_id: 50, empresa_id: 6, papel_id: 2, ativo: true },
    { id: 901, usuario_id: 51, empresa_id: 6, papel_id: 1, ativo: true },
    { id: 902, usuario_id: 53, empresa_id: 6, papel_id: 1, ativo: true },
    { id: 903, usuario_id: 53, empresa_id: 7, papel_id: 2, ativo: true },
  ];
}

function projetarVinculo(v, selectSpec) {
  const linha = { id: v.id, empresa_id: v.empresa_id, ativo: v.ativo, papel_id: v.papel_id };
  if (selectSpec && selectSpec.includes('papel:Papel(nome)')) {
    linha.papel = { nome: PAPEL_FIXTURES[v.papel_id].nome };
  }
  return linha;
}

async function fakeHubPostgrestRequest(caminho, method = 'GET', body = null, claims = {}) {
  chamadasPostgrest.push({ caminho, method, body, claims });
  let m;

  m = caminho.match(/^Papel\?id=eq\.(\d+)&select=id,nome$/);
  if (m) {
    const p = PAPEL_FIXTURES[Number(m[1])];
    return p ? [p] : [];
  }

  if (caminho.startsWith('Usuario?email=eq.')) {
    return []; // nunca duplicado nestes testes
  }

  if (caminho === 'Usuario' && method === 'POST') {
    proximoUsuarioId += 1;
    return [{ id: proximoUsuarioId, nome: body.nome, email: body.email }];
  }

  m = caminho.match(/^Usuario\?id=eq\.(\d+)&select=id$/);
  if (m) {
    const id = Number(m[1]);
    return [50, 51, 52].includes(id) ? [{ id }] : [];
  }

  m = caminho.match(/^Usuario\?id=eq\.(\d+)$/);
  if (m && method === 'PATCH') {
    return [{ id: Number(m[1]), nome: 'Nome Teste', email: 'teste@teste.com', ativo: body.ativo !== undefined ? body.ativo : true }];
  }

  // UsuarioEntidade?id=eq.N&usuario_id=eq.M[&empresa_id=eq.K]&select=...
  m = caminho.match(/^UsuarioEntidade\?id=eq\.(\d+)&usuario_id=eq\.(\d+)(?:&empresa_id=eq\.(\d+))?&select=(.+)$/);
  if (m && method === 'GET') {
    const vinculoId = Number(m[1]);
    const usuarioId = Number(m[2]);
    const empresaId = m[3] !== undefined ? Number(m[3]) : null;
    const v = vinculosFixture.find(
      (x) => x.id === vinculoId && x.usuario_id === usuarioId && (empresaId === null || x.empresa_id === empresaId)
    );
    return v ? [projetarVinculo(v, m[4])] : [];
  }

  // UsuarioEntidade?usuario_id=eq.N[&empresa_id=eq.M]&select=...
  m = caminho.match(/^UsuarioEntidade\?usuario_id=eq\.(\d+)(?:&empresa_id=eq\.(\d+))?&select=(.+)$/);
  if (m) {
    const usuarioId = Number(m[1]);
    const empresaId = m[2] !== undefined ? Number(m[2]) : null;
    const linhas = vinculosFixture.filter(
      (v) => v.usuario_id === usuarioId && (empresaId === null || v.empresa_id === empresaId)
    );
    return linhas.map((v) => projetarVinculo(v, m[3]));
  }

  m = caminho.match(/^UsuarioEntidade\?id=eq\.(\d+)$/);
  if (m && method === 'PATCH') {
    const vinculoId = Number(m[1]);
    const v = vinculosFixture.find((x) => x.id === vinculoId);
    if (!v) return [];
    Object.assign(v, body);
    return [{ ...v }];
  }

  if (caminho === 'UsuarioEntidade' && method === 'POST') {
    proximoVinculoId += 1;
    const novo = { id: proximoVinculoId, usuario_id: body.usuario_id, empresa_id: body.empresa_id, papel_id: body.papel_id, ativo: true };
    vinculosFixture.push(novo);
    return [novo];
  }

  m = caminho.match(/^Empresa\?id=in\.\(([\d,]+)\)&select=id,nome_empresa$/);
  if (m) {
    return m[1].split(',').map((idStr) => ({ id: Number(idStr), nome_empresa: `Empresa ${idStr}` }));
  }

  throw new Error(`mock não suporta: ${caminho} [${method}]`);
}

// ──────────────────────────────────────────────────────────────────────────
// Module._load: mocka só a camada de dados (mesma técnica de
// hub-adiantamentos-rotas-unit.test.js) — lib/hub-access-token.js e as
// middlewares hub-require-permission/hub-require-modulo rodam DE VERDADE.
// ──────────────────────────────────────────────────────────────────────────
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../lib/hub-rbac-cache') {
    return {
      obterPermissoesEfetivas: async () => permissoesPorEntidade,
      obterPermissoesEfetivasPorEntidade: async () => permissoesPorEntidade,
      obterModulosAtivosPorEntidade: async () => modulosAtivos,
      usuarioEhAdminPlataforma: async () => ehAdminPlataforma,
      // Fake da leitura PRIVILEGIADA (block-009/dec-075): ignora empresa —
      // enxerga TODOS os vínculos ATIVOS do alvo, em qualquer empresa,
      // igual à implementação real (sub=alvo satisfaz a RLS
      // usuarioentidade_select_proprio, 0006_rls_policies.sql).
      alvoTemPapelRestritoAtivo: async (usuarioAlvoId) => {
        const id = Number(usuarioAlvoId);
        return vinculosFixture.some(
          (v) => v.usuario_id === id && v.ativo && PAPEL_FIXTURES[v.papel_id]
            && ['admin_plataforma', 'financeiro_aprovador'].includes(PAPEL_FIXTURES[v.papel_id].nome)
        );
      },
      invalidarUsuario: () => {},
    };
  }
  if (request === '../lib/hub-postgrest' || request === './hub-postgrest') {
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
  return originalLoad.apply(this, arguments);
};

const express = require('express');
const cookieParser = require('cookie-parser');
const { router } = require('../routes/hub-usuarios.js');

Module._load = originalLoad;

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1/usuarios', router);

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
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const contentType = res.headers['content-type'] || '';
          let parsed;
          if (contentType.includes('application/json')) {
            try { parsed = buf.length ? JSON.parse(buf.toString('utf8')) : null; } catch { parsed = buf.toString('utf8'); }
          } else {
            parsed = buf.toString('utf8');
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

let proximoSub = 8000;
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

// ──────────────────────────────────────────────────────────────────────────
// 2.1 + 2.4.1 — POST /usuarios
// ──────────────────────────────────────────────────────────────────────────
describe('POST /usuarios — trava de papel restrito no 1º vínculo', () => {
  beforeEach(resetFixtures);

  test('admin_entidade tentando criar usuário com papel admin_plataforma -> 403 PAPEL_RESTRITO, sem criar nada', async () => {
    const res = await request('POST', '/api/v1/usuarios', {
      cookie: tokenCookie(),
      body: { nome: 'Fulano', email: 'fulano@teste.com', senha: 'Abc123', vinculo: { entidadeId: 6, papelId: 2 } },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.erro, 'PAPEL_RESTRITO');
    assert.ok(!chamadasPostgrest.some((c) => c.caminho === 'Usuario' && c.method === 'POST'), 'não deve ter criado o Usuario');
    assert.equal(registrosAuditoria.length, 1);
    assert.equal(registrosAuditoria[0].acao, 'usuario_vinculo_negado');
    assert.equal(registrosAuditoria[0].detalhes.motivo, 'PAPEL_RESTRITO');
  });

  test('admin_entidade tentando criar usuário com papel financeiro_aprovador -> 403 PAPEL_RESTRITO', async () => {
    const res = await request('POST', '/api/v1/usuarios', {
      cookie: tokenCookie(),
      body: { nome: 'Fulano', email: 'fulano2@teste.com', senha: 'Abc123', vinculo: { entidadeId: 6, papelId: 3 } },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.erro, 'PAPEL_RESTRITO');
  });

  test('FR-011 sem regressão: admin_entidade cria usuário com papel operador (não restrito) -> 201', async () => {
    const res = await request('POST', '/api/v1/usuarios', {
      cookie: tokenCookie(),
      body: { nome: 'Fulano', email: 'fulano3@teste.com', senha: 'Abc123', vinculo: { entidadeId: 6, papelId: 1 } },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.usuario.vinculos[0].papelId, 1);
  });

  test('admin_plataforma consegue criar usuário com papel admin_plataforma -> 201', async () => {
    ehAdminPlataforma = true;
    const res = await request('POST', '/api/v1/usuarios', {
      cookie: tokenCookie(),
      body: { nome: 'Fulano', email: 'fulano4@teste.com', senha: 'Abc123', vinculo: { entidadeId: 6, papelId: 2 } },
    });
    assert.equal(res.status, 201);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 2.1 + 2.4.2 — POST /usuarios/:id/vinculos
// ──────────────────────────────────────────────────────────────────────────
describe('POST /usuarios/:id/vinculos — trava de papel restrito', () => {
  beforeEach(resetFixtures);

  test('admin_entidade tentando vincular usuário 52 com papel admin_plataforma -> 403 PAPEL_RESTRITO', async () => {
    const res = await request('POST', '/api/v1/usuarios/52/vinculos', {
      cookie: tokenCookie(),
      body: { entidadeId: 6, papelId: 2 },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.erro, 'PAPEL_RESTRITO');
    assert.ok(!chamadasPostgrest.some((c) => c.caminho === 'UsuarioEntidade' && c.method === 'POST'));
    assert.equal(registrosAuditoria.length, 1);
    assert.equal(registrosAuditoria[0].detalhes.usuarioAlvoId, 52);
  });

  test('sem regressão: admin_entidade vincula usuário 52 com papel operador -> 201', async () => {
    const res = await request('POST', '/api/v1/usuarios/52/vinculos', {
      cookie: tokenCookie(),
      body: { entidadeId: 6, papelId: 1 },
    });
    assert.equal(res.status, 201);
  });

  test('admin_plataforma consegue vincular usuário 52 com papel admin_plataforma -> 201', async () => {
    ehAdminPlataforma = true;
    const res = await request('POST', '/api/v1/usuarios/52/vinculos', {
      cookie: tokenCookie(),
      body: { entidadeId: 6, papelId: 2 },
    });
    assert.equal(res.status, 201);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 2.1 + 2.4.3 — PUT /usuarios/:id/vinculos/:vinculoId
// ──────────────────────────────────────────────────────────────────────────
describe('PUT /usuarios/:id/vinculos/:vinculoId — trava de papel restrito (atual OU novo)', () => {
  beforeEach(resetFixtures);

  test('admin_entidade tentando desativar vínculo 900 (papel atual admin_plataforma) -> 403', async () => {
    const res = await request('PUT', '/api/v1/usuarios/50/vinculos/900', {
      cookie: tokenCookie(),
      body: { ativo: false },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.erro, 'PAPEL_RESTRITO');
    const vinculo900 = vinculosFixture.find((v) => v.id === 900);
    assert.equal(vinculo900.ativo, true, 'vínculo restrito não pode ter sido alterado');
  });

  test('admin_entidade tentando promover vínculo 901 (não restrito) para admin_plataforma -> 403', async () => {
    const res = await request('PUT', '/api/v1/usuarios/51/vinculos/901', {
      cookie: tokenCookie(),
      body: { papelId: 2 },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.erro, 'PAPEL_RESTRITO');
    const vinculo901 = vinculosFixture.find((v) => v.id === 901);
    assert.equal(vinculo901.papel_id, 1, 'vínculo não deve ter sido alterado');
  });

  test('sem regressão: admin_entidade troca papel do vínculo 901 (operador -> financeiro, não restrito) -> 200', async () => {
    const res = await request('PUT', '/api/v1/usuarios/51/vinculos/901', {
      cookie: tokenCookie(),
      body: { papelId: 4 },
    });
    assert.equal(res.status, 200);
  });

  test('admin_plataforma consegue desativar vínculo 900 (papel restrito) -> 200', async () => {
    ehAdminPlataforma = true;
    const res = await request('PUT', '/api/v1/usuarios/50/vinculos/900', {
      cookie: tokenCookie(),
      body: { ativo: false },
    });
    assert.equal(res.status, 200);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 2.1 + 2.4.4 — PUT /usuarios/:id (senha/nome/ativo do alvo)
// ──────────────────────────────────────────────────────────────────────────
describe('PUT /usuarios/:id — trava quando o alvo tem vínculo ativo com papel restrito', () => {
  beforeEach(resetFixtures);

  test('admin_entidade tentando trocar a senha do usuário 50 (vínculo ativo admin_plataforma) -> 403', async () => {
    const res = await request('PUT', '/api/v1/usuarios/50', {
      cookie: tokenCookie(),
      body: { senha: 'NovaSenha123' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.erro, 'PAPEL_RESTRITO');
    assert.ok(!chamadasPostgrest.some((c) => c.caminho === 'Usuario?id=eq.50' && c.method === 'PATCH'));
  });

  test('admin_entidade tentando desativar (ativo:false) o usuário 50 -> 403', async () => {
    const res = await request('PUT', '/api/v1/usuarios/50', {
      cookie: tokenCookie(),
      body: { ativo: false },
    });
    assert.equal(res.status, 403);
  });

  test('sem regressão: admin_entidade troca nome do usuário 51 (vínculo não restrito) -> 200', async () => {
    const res = await request('PUT', '/api/v1/usuarios/51', {
      cookie: tokenCookie(),
      body: { nome: 'Novo Nome' },
    });
    assert.equal(res.status, 200);
  });

  test('admin_plataforma consegue trocar a senha do usuário 50 -> 200', async () => {
    ehAdminPlataforma = true;
    const res = await request('PUT', '/api/v1/usuarios/50', {
      cookie: tokenCookie(),
      body: { senha: 'NovaSenha123' },
    });
    assert.equal(res.status, 200);
  });

  // ────────────────────────────────────────────────────────────────────────
  // CROSS-TENANT (block-009/dec-075/dec-077) — usuário 53: vínculo COMUM
  // ativo na empresa 6 (a do chamador) + vínculo admin_plataforma ativo na
  // empresa 7 (fora do escopo do chamador). Furo achado em 2.5.7: a trava
  // antiga só olhava `vinculosVisiveis` (filtrada por empresa_id=eq.6, a
  // entidadeAtiva do chamador) e por isso nunca via o vínculo em 7.
  // ────────────────────────────────────────────────────────────────────────
  test('CROSS-TENANT: admin_entidade da empresa 6 tentando trocar a senha do usuário 53 (comum em 6, admin_plataforma em 7) -> 403', async () => {
    const res = await request('PUT', '/api/v1/usuarios/53', {
      cookie: tokenCookie({ entidadeAtiva: 6 }),
      body: { senha: 'NovaSenha123' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.erro, 'PAPEL_RESTRITO');
    assert.ok(!chamadasPostgrest.some((c) => c.caminho === 'Usuario?id=eq.53' && c.method === 'PATCH'));
  });

  test('CROSS-TENANT: admin_entidade da empresa 6 tentando trocar o nome do usuário 53 -> 403', async () => {
    const res = await request('PUT', '/api/v1/usuarios/53', {
      cookie: tokenCookie({ entidadeAtiva: 6 }),
      body: { nome: 'Nome Tomado' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.erro, 'PAPEL_RESTRITO');
  });

  test('CROSS-TENANT: admin_entidade da empresa 6 tentando desativar (ativo:false) o usuário 53 -> 403', async () => {
    const res = await request('PUT', '/api/v1/usuarios/53', {
      cookie: tokenCookie({ entidadeAtiva: 6 }),
      body: { ativo: false },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.erro, 'PAPEL_RESTRITO');
  });

  test('CROSS-TENANT: admin_plataforma consegue trocar a senha do usuário 53 mesmo com o vínculo restrito em outra empresa -> 200', async () => {
    ehAdminPlataforma = true;
    const res = await request('PUT', '/api/v1/usuarios/53', {
      cookie: tokenCookie({ entidadeAtiva: 6 }),
      body: { senha: 'NovaSenha123' },
    });
    assert.equal(res.status, 200);
  });
});
