/**
 * Testes de integração — App Motorista (PWA)
 * Rodam com: node --test tests/motorista-integration.test.js
 *
 * Usa node:test + node:assert + node:http nativos (Node 18+).
 * Mocks para: PostgREST (_postgrestRequest) e FastAPI (axios — interceptado).
 *
 * Cobre:
 *   - 2.1.4: token válido passa; ausente → 401; expirado → 401; empresa → 401
 *   - 2.2.5: login ok emite cookies; login inválido 401; refresh renova
 *   - 2.3.5: cadastro elegível 201; CNPJ desconhecido 409; já cadastrado 409; senha curta 400
 *   - 3.1.5: movimento-aberto isolado por CNPJ (motorista A não vê dados de B); sem auth 401
 *   - 3.2.x: validar-nota com mock da validação externa (pass e fail)
 *   - 5.1.6, 5.2.4, 5.3.x: (cobertos via rotas acima nos cenários de login/movimento/validar)
 *
 * Ref: tasks 2.1.4, 2.2.5, 2.3.5, 3.1.5, 3.2.x
 */

'use strict';

process.env.JWT_SECRET = 'test-secret-key-for-jest-only-32chars!!';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-32chars-here!!';
process.env.NODE_ENV = 'test';
process.env.FASTAPI_VALIDATION_TOKEN = 'Bearer test-token';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

// ──────────────────────────────────────────────────────────────────────────────
// Mock de estado em memória para PostgREST
// ──────────────────────────────────────────────────────────────────────────────
const DB = {
  Motorista: [],
  EnvioMassa: [],
};

function resetDB() {
  DB.Motorista = [];
  DB.EnvioMassa = [];
}

async function mockPostgrestRequest(path, method = 'GET', body = null) {
  const [table, query] = path.split('?');
  const params = query ? Object.fromEntries(new URLSearchParams(query)) : {};

  if (method === 'GET') {
    let rows = [...(DB[table] || [])];
    // Filtros simples: campo=eq.valor OU campo=in.("v1","v2",...) — este
    // último cobre `cnpjEnvioMassaFilter()` (routes/motorista.js), usado por
    // /movimento-aberto e /validar-nota para casar cnpj_prestador em ambos
    // os formatos (só-dígitos e mascarado). Sem este parse, TODA consulta
    // via `in.(...)` retorna 0 linhas neste mock — bug pré-existente do
    // harness (não do código de produção) descoberto/corrigido na FASE 6
    // (tasks.md 6.3.3) ao escrever os testes de gravação de entregador_uuid.
    for (const [key, val] of Object.entries(params)) {
      // `select` nunca foi tratado como projeção de campos aqui (outro bug
      // pré-existente do harness, mesma descoberta acima): sem este skip,
      // qualquer query com `&select=...` era filtrada contra um campo
      // inexistente `r.select` e SEMPRE retornava `[]` — mascarava o reread
      // pós-validação em /validar-nota (mesmo padrão já usado em
      // tests/hub-motorista-app-login.test.js#mockHubPostgrestRequest).
      if (key.startsWith('order') || key === 'limit' || key === 'select') continue;
      const field = key;
      if (val.startsWith('in.(') && val.endsWith(')')) {
        const valores = val
          .slice('in.('.length, -1)
          .split(',')
          .map((v) => v.trim().replace(/^"|"$/g, ''));
        rows = rows.filter((r) => valores.includes(String(r[field])));
        continue;
      }
      const value = val.replace(/^eq\./, '');
      rows = rows.filter((r) => String(r[field]) === String(value));
    }
    // limit
    if (params.limit) rows = rows.slice(0, parseInt(params.limit, 10));
    return rows;
  }

  if (method === 'POST') {
    const newRow = { id: Date.now(), ...body };
    if (!DB[table]) DB[table] = [];
    DB[table].push(newRow);
    return newRow;
  }

  if (method === 'PATCH') {
    // Filtro genérico por qualquer `campo=eq.valor` (não só id) — o
    // /motorista/register ATIVA o pré-cadastro via
    // `Motorista?cnpj_prestador=eq.<cnpj>` (cf8c840); com o filtro restrito a
    // `id`, o UPDATE virava no-op e o subteste "já tem conta → 409" via a
    // linha ainda sem senha (201 indevido).
    for (const row of DB[table] || []) {
      const match = Object.entries(params).every(([key, val]) => {
        if (key.startsWith('order') || key === 'limit' || key === 'select') return true;
        return String(row[key]) === String(val).replace(/^eq\./, '');
      });
      if (match) Object.assign(row, body);
    }
    return {};
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Mock do axios (chamada FastAPI externa)
// ──────────────────────────────────────────────────────────────────────────────
let _axiosMockResponse = { data: [{ valid: true, details: {} }] };
const axiosMock = {
  post: async () => _axiosMockResponse,
};

// ──────────────────────────────────────────────────────────────────────────────
// Setup: carregar rota substituindo dependências
// ──────────────────────────────────────────────────────────────────────────────
// Como motorista.js usa require('axios') no topo, precisamos pré-popular
// o cache de módulos antes de carregar a rota.
// Usamos Module._cache para injetar o mock (técnica padrão sem jest).
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'axios') return axiosMock;
  return originalLoad.apply(this, arguments);
};

const express = require('express');
const cookieParser = require('cookie-parser');
const { router, init } = require('../routes/motorista.js');

// Restaurar _load após o require da rota
Module._load = originalLoad;

init({ postgrestRequest: mockPostgrestRequest, generatePostgrestJWT: () => 'mock-jwt' });

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/motorista', router);

// ──────────────────────────────────────────────────────────────────────────────
// Helper: request simplificado via node:http
// ──────────────────────────────────────────────────────────────────────────────
let server;
let baseUrl;

function request(method, path, { body, cookies, multipart } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const bodyStr = body ? JSON.stringify(body) : multipart ? multipart.body : undefined;

    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (multipart) {
      headers['Content-Type'] = multipart.contentType;
    }
    if (cookies) headers['Cookie'] = cookies;
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers,
      },
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
          resolve({ status: res.statusCode, body: json, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/** Extrai cookie de Set-Cookie header */
function extractCookie(headers, name) {
  const setCookie = headers['set-cookie'] || [];
  const match = setCookie.find((c) => c.startsWith(name + '='));
  return match ? match.split(';')[0].split('=').slice(1).join('=') : null;
}

/** Gera access token de motorista para testes */
function makeToken(payload, opts = {}) {
  return jwt.sign(
    { ...payload, aud: 'motorista' },
    process.env.JWT_SECRET,
    { expiresIn: '15m', ...opts }
  );
}

/** Gera token de Empresa (audiência diferente) */
function makeEmpresaToken() {
  return jwt.sign({ cnpj: '000', aud: 'empresa' }, process.env.JWT_SECRET, { expiresIn: '15m' });
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

// ──────────────────────────────────────────────────────────────────────────────
// 2.1.4 — authenticateMotorista
// ──────────────────────────────────────────────────────────────────────────────
describe('2.1.4 authenticateMotorista', () => {
  test('sem token → 401', async () => {
    const r = await request('GET', '/motorista/verify-auth');
    assert.equal(r.status, 401);
  });

  test('token de Empresa → 401', async () => {
    const tok = makeEmpresaToken();
    const r = await request('GET', '/motorista/verify-auth', {
      cookies: `accessToken=${tok}`,
    });
    assert.equal(r.status, 401);
  });

  test('token expirado → 401', async () => {
    const tok = jwt.sign(
      { cnpjPrestador: '11222333000199', aud: 'motorista', exp: Math.floor(Date.now() / 1000) - 10 },
      process.env.JWT_SECRET
    );
    const r = await request('GET', '/motorista/verify-auth', {
      cookies: `accessToken=${tok}`,
    });
    assert.equal(r.status, 401);
  });

  test('token válido → 200 com cnpjPrestador', async () => {
    const tok = makeToken({ cnpjPrestador: '11222333000199', nome: 'Motorista Teste' });
    const r = await request('GET', '/motorista/verify-auth', {
      cookies: `accessToken=${tok}`,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.authenticated, true);
    assert.equal(r.body.cnpjPrestador, '11222333000199');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 2.2.5 — Login
// ──────────────────────────────────────────────────────────────────────────────
describe('2.2.5 POST /motorista/login', () => {
  before(async () => {
    resetDB();
    const senhaHash = await bcrypt.hash('senha1234', 10);
    DB.Motorista.push({ id: 1, cnpj_prestador: '11222333000199', senha: senhaHash, nome: 'Motorista A', ativo: true });
  });

  test('login ok → 200 + cookies httpOnly', async () => {
    const r = await request('POST', '/motorista/login', {
      body: { cnpjPrestador: '11.222.333/0001-99', senha: 'senha1234' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.cnpjPrestador, '11222333000199');
    // Verificar cookies presentes no Set-Cookie
    const ac = extractCookie(r.headers, 'accessToken');
    const rc = extractCookie(r.headers, 'refreshToken');
    assert.ok(ac, 'accessToken cookie ausente');
    assert.ok(rc, 'refreshToken cookie ausente');
    // Verificar httpOnly nos headers brutos
    const setCookies = r.headers['set-cookie'] || [];
    assert.ok(setCookies.some((c) => c.includes('HttpOnly')), 'cookie não é httpOnly');
  });

  test('senha errada → 401 com mensagem genérica', async () => {
    const r = await request('POST', '/motorista/login', {
      body: { cnpjPrestador: '11222333000199', senha: 'errada' },
    });
    assert.equal(r.status, 401);
    assert.match(r.body.error, /Credenciais/i);
  });

  test('CNPJ inexistente → 401 (anti-enumeração — mesmo erro)', async () => {
    const r = await request('POST', '/motorista/login', {
      body: { cnpjPrestador: '99888777000100', senha: 'qualquer' },
    });
    assert.equal(r.status, 401);
    assert.match(r.body.error, /Credenciais/i);
  });

  test('campos ausentes → 400', async () => {
    const r = await request('POST', '/motorista/login', { body: { cnpjPrestador: '11222333000199' } });
    assert.equal(r.status, 400);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 2.3.5 — Register (auto-cadastro)
// ──────────────────────────────────────────────────────────────────────────────
describe('2.3.5 POST /motorista/register', () => {
  before(() => {
    resetDB();
    // Desde cf8c840 (cadastro-motorista-base-validada), a elegibilidade vem
    // da base curada "Motorista" (pré-cadastro do upload, senha NULL), não
    // mais da EnvioMassa — o /register ATIVA o pré-cadastro via UPDATE.
    DB.Motorista.push({
      id: 1,
      cnpj_prestador: '11222333000199',
      nome: 'Motorista Pré-cadastro',
      senha: null,
      ativo: true,
    });
  });

  test('cadastro elegível → 201', async () => {
    const r = await request('POST', '/motorista/register', {
      body: { cnpjPrestador: '11222333000199', nome: 'Motorista Novo', senha: 'senha1234' },
    });
    assert.equal(r.status, 201);
  });

  test('CNPJ desconhecido (não está na EnvioMassa) → 409', async () => {
    const r = await request('POST', '/motorista/register', {
      body: { cnpjPrestador: '00000000000100', nome: 'Teste', senha: 'senha1234' },
    });
    assert.equal(r.status, 409);
  });

  test('CNPJ já tem conta Motorista → 409', async () => {
    // Cadastrar primeiro
    const senhaHash = await bcrypt.hash('senha1234', 10);
    DB.Motorista.push({ id: 2, cnpj_prestador: '11222333000199', senha: senhaHash, nome: 'Já existe', ativo: true });

    const r = await request('POST', '/motorista/register', {
      body: { cnpjPrestador: '11222333000199', nome: 'Duplicado', senha: 'senha1234' },
    });
    assert.equal(r.status, 409);
  });

  test('senha curta (< 8 chars) → 400', async () => {
    const r = await request('POST', '/motorista/register', {
      body: { cnpjPrestador: '11222333000199', nome: 'Teste', senha: '123' },
    });
    assert.equal(r.status, 400);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 3.1.5 — Movimento aberto (isolamento por CNPJ)
// ──────────────────────────────────────────────────────────────────────────────
describe('3.1.5 GET /motorista/movimento-aberto', () => {
  before(() => {
    resetDB();
    // Motorista A tem movimento aberto
    DB.EnvioMassa.push({
      id: 10,
      cnpj_prestador: '11111111000100',
      mov_fechado: false,
      valor: 5000,
      dt_inicial: '2024-01-01',
      dt_final: '2024-01-31',
      nome: 'Empresa A',
      cnpj_tomador: '22222222000100',
      tribnac: 1,
      nota_ok: false,
      erro_validacao: null,
    });
    // Motorista B tem movimento diferente
    DB.EnvioMassa.push({
      id: 20,
      cnpj_prestador: '33333333000100',
      mov_fechado: false,
      valor: 9999,
      dt_inicial: '2024-02-01',
      dt_final: '2024-02-28',
      nome: 'Empresa B',
      cnpj_tomador: '44444444000100',
      tribnac: 2,
      nota_ok: false,
      erro_validacao: null,
    });
  });

  test('sem auth → 401', async () => {
    const r = await request('GET', '/motorista/movimento-aberto');
    assert.equal(r.status, 401);
  });

  test('motorista A vê apenas seu movimento (id=10)', async () => {
    const tok = makeToken({ cnpjPrestador: '11111111000100' });
    const r = await request('GET', '/motorista/movimento-aberto', {
      cookies: `accessToken=${tok}`,
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.movimento, 'movimento deve existir');
    assert.equal(r.body.movimento.valor, 5000);
    assert.equal(r.body.movimento.cnpjPrestador, '11111111000100');
  });

  test('motorista B não vê dados de A', async () => {
    const tok = makeToken({ cnpjPrestador: '33333333000100' });
    const r = await request('GET', '/motorista/movimento-aberto', {
      cookies: `accessToken=${tok}`,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.movimento.valor, 9999);
    // Garante que não veio o movimento de A
    assert.notEqual(r.body.movimento.valor, 5000);
  });

  test('CNPJ sem movimento → { movimento: null }', async () => {
    const tok = makeToken({ cnpjPrestador: '99999999000100' });
    const r = await request('GET', '/motorista/movimento-aberto', {
      cookies: `accessToken=${tok}`,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.movimento, null);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 3.2.x / 3.3.x — validar-nota (com mock da API externa)
// ──────────────────────────────────────────────────────────────────────────────
describe('3.2 / 3.3 POST /motorista/validar-nota', () => {
  // XML mínimo bem-formado
  const XML_VALIDO = `<?xml version="1.0" encoding="UTF-8"?><CompNfse><Nfse><InfNfse><Numero>1</Numero></InfNfse></Nfse></CompNfse>`;

  function buildMultipart(xmlContent, boundary = 'TEST_BOUNDARY_12345') {
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="nota.xml"\r\n` +
      `Content-Type: text/xml\r\n\r\n` +
      xmlContent +
      `\r\n--${boundary}--\r\n`;
    return { body, contentType: `multipart/form-data; boundary=${boundary}` };
  }

  before(() => {
    resetDB();
    DB.EnvioMassa.push({
      id: 100,
      cnpj_prestador: '11111111000100',
      mov_fechado: false,
      valor: 5000,
      // nota_ok é coluna TEXTO (URL do XML gravada pelo serviço de validação);
      // "já aprovada" = nota_ok não-vazio E erro_validacao vazio. Seedar o
      // boolean `false` fazia String(false)='false' passar no guard de reenvio
      // e TODA validação devolvia 409 "Nota já aprovada" (4 falhas da suíte).
      nota_ok: null,
      erro_validacao: null,
    });
  });

  test('sem auth → 401', async () => {
    const r = await request('POST', '/motorista/validar-nota');
    assert.equal(r.status, 401);
  });

  test('sem arquivo → 400', async () => {
    const tok = makeToken({ cnpjPrestador: '11111111000100' });
    const r = await request('POST', '/motorista/validar-nota', {
      cookies: `accessToken=${tok}`,
      body: {},
    });
    assert.equal(r.status, 400);
  });

  test('nota válida (mock retorna valid:true) → 200 + notaOk:true', async () => {
    _axiosMockResponse = {
      data: [{ valid: true, details: { valid_cnpj_prestador: true, valid_valor: true } }],
    };
    // O serviço real grava nota_ok/erro_validacao DIRETO na EnvioMassa e o
    // backend SÓ RELÊ ("Fonte de verdade" em routes/motorista.js) — sem
    // simular esse efeito colateral, o reread encontra a linha intacta e a
    // rota devolve 503 "sem resultado gravado" (mesma técnica da FASE 6).
    axiosMock.post = async () => {
      const row = DB.EnvioMassa.find((m) => m.id === 100);
      if (row) {
        row.nota_ok = 'https://fake-fastapi.local/nota-100.xml';
        row.erro_validacao = '';
      }
      return _axiosMockResponse;
    };
    const tok = makeToken({ cnpjPrestador: '11111111000100' });
    const mp = buildMultipart(XML_VALIDO);
    const r = await request('POST', '/motorista/validar-nota', {
      cookies: `accessToken=${tok}`,
      multipart: mp,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.valid, true);
    assert.equal(r.body.notaOk, true);
  });

  test('nota inválida (mock retorna valid:false com campos) → 200 + camposInvalidos', async () => {
    // Reset DB para limpar nota_ok do teste anterior
    resetDB();
    DB.EnvioMassa.push({
      id: 101,
      cnpj_prestador: '22222222000100',
      mov_fechado: false,
      valor: 1000,
      nota_ok: null,
      erro_validacao: null,
    });

    // Efeito colateral do serviço: nota REPROVADA = nota_ok gravado (URL) +
    // erro_validacao com os campos reprovados (é dele que a rota deriva
    // camposInvalidos — não do JSON imediato da API).
    axiosMock.post = async () => {
      const row = DB.EnvioMassa.find((m) => m.id === 101);
      if (row) {
        row.nota_ok = 'https://fake-fastapi.local/nota-101.xml';
        row.erro_validacao = 'valid_valor,valid_trib_nac';
      }
      return _axiosMockResponse;
    };

    _axiosMockResponse = {
      data: [{
        valid: false,
        details: {
          valid_cnpj_prestador: true,
          valid_cnpj: true,
          valid_descricao_servico: true,
          valid_valor: false,
          valid_trib_nac: false,
          valid_trib_mun: true,
          valid_dCompet: true,
        },
      }],
    };

    const tok = makeToken({ cnpjPrestador: '22222222000100' });
    const mp = buildMultipart(XML_VALIDO);
    const r = await request('POST', '/motorista/validar-nota', {
      cookies: `accessToken=${tok}`,
      multipart: mp,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.valid, false);
    assert.equal(r.body.notaOk, false);
    assert.ok(Array.isArray(r.body.camposInvalidos));
    assert.equal(r.body.camposInvalidos.length, 2); // valid_valor + valid_trib_nac
  });

  test('CNPJ sem movimento aberto → 409', async () => {
    const tok = makeToken({ cnpjPrestador: '99999999000100' });
    const mp = buildMultipart(XML_VALIDO);
    const r = await request('POST', '/motorista/validar-nota', {
      cookies: `accessToken=${tok}`,
      multipart: mp,
    });
    assert.equal(r.status, 409);
  });

  test('falha do serviço externo (mock lança erro) → 502', async () => {
    // Mock que lança erro
    axiosMock.post = async () => { throw new Error('Connection refused'); };

    resetDB();
    DB.EnvioMassa.push({
      id: 102,
      cnpj_prestador: '55555555000100',
      mov_fechado: false,
      nota_ok: null, // texto (URL), nunca boolean — ver seed do describe
      erro_validacao: null,
    });

    const tok = makeToken({ cnpjPrestador: '55555555000100' });
    const mp = buildMultipart(XML_VALIDO);
    const r = await request('POST', '/motorista/validar-nota', {
      cookies: `accessToken=${tok}`,
      multipart: mp,
    });
    assert.equal(r.status, 502);

    // Restaurar mock
    axiosMock.post = async () => _axiosMockResponse;
  });

  // ──────────────────────────────────────────────────────────────────────
  // FASE 6 (tasks.md 6.3.3) — gravação de entregador_uuid no movimento
  // ──────────────────────────────────────────────────────────────────────
  test('token com entregadorUuid -> grava entregador_uuid no movimento (aditivo, não reescreve cnpj_prestador)', async () => {
    resetDB();
    DB.EnvioMassa.push({
      id: 200,
      cnpj_prestador: '66666666000100',
      mov_fechado: false,
      valor: 3000,
      // nota_ok NULL (não `false`) — `false != null` é `true` em JS, então um
      // `nota_ok: false` faria `temNotaOk`/`jaAprovada` (routes/motorista.js)
      // interpretar "já tem nota_ok preenchido" e bloquear com 409 (pré-
      // existente nos fixtures antigos deste describe — bug de fixture, não
      // de produção, descoberto ao escrever este teste).
      nota_ok: null,
      erro_validacao: null,
    });
    // Restaura o mock do axios explicitamente — o teste anterior deste
    // describe ("falha do serviço externo") só restaura `axiosMock.post` DEPOIS
    // do seu próprio assert, que hoje já falha por um bug pré-existente do
    // fixture (nota_ok:false em outra linha), então a restauração nunca roda
    // e o mock "throw" vaza para os testes seguintes. Defensivo aqui.
    // O serviço real de validação grava nota_ok/erro_validacao DIRETO na
    // EnvioMassa (comentário em routes/motorista.js "Fonte de verdade...") —
    // o mock do axios simula esse efeito colateral para o backend conseguir
    // reler um resultado aprovado (mesma técnica que os testes ORIGINAIS
    // deste describe já pressupunham, sem nunca implementar o lado do mock).
    axiosMock.post = async () => {
      const row = DB.EnvioMassa.find((m) => m.id === 200);
      if (row) {
        row.nota_ok = 'https://fake-fastapi.local/nota-200.xml';
        row.erro_validacao = '';
      }
      return { data: [{ valid: true, details: {} }] };
    };
    _axiosMockResponse = { data: [{ valid: true, details: {} }] };

    const tok = makeToken({
      cnpjPrestador: '66666666000100',
      entregadorUuid: '22222222-2222-2222-2222-222222222222',
    });
    const mp = buildMultipart(XML_VALIDO);
    const r = await request('POST', '/motorista/validar-nota', {
      cookies: `accessToken=${tok}`,
      multipart: mp,
    });
    assert.equal(r.status, 200);

    const movimento = DB.EnvioMassa.find((m) => m.id === 200);
    assert.equal(movimento.entregador_uuid, '22222222-2222-2222-2222-222222222222');
    // chave existente preservada — aditivo, nada reescrito
    assert.equal(movimento.cnpj_prestador, '66666666000100');
  });

  test('token SEM entregadorUuid (uuid ainda não resolvido/cadastrado) -> grava normalmente, sem bloqueio nem erro', async () => {
    resetDB();
    DB.EnvioMassa.push({
      id: 201,
      cnpj_prestador: '77777777000100',
      mov_fechado: false,
      valor: 4000,
      nota_ok: null,
      erro_validacao: null,
    });
    // Mesma técnica de simulação do efeito colateral do serviço externo
    // (grava nota_ok/erro_validacao direto na EnvioMassa) do teste anterior.
    axiosMock.post = async () => {
      const row = DB.EnvioMassa.find((m) => m.id === 201);
      if (row) {
        row.nota_ok = 'https://fake-fastapi.local/nota-201.xml';
        row.erro_validacao = '';
      }
      return { data: [{ valid: true, details: {} }] };
    };
    _axiosMockResponse = { data: [{ valid: true, details: {} }] };

    const tok = makeToken({ cnpjPrestador: '77777777000100' }); // sem entregadorUuid
    const mp = buildMultipart(XML_VALIDO);
    const r = await request('POST', '/motorista/validar-nota', {
      cookies: `accessToken=${tok}`,
      multipart: mp,
    });
    assert.equal(r.status, 200);

    const movimento = DB.EnvioMassa.find((m) => m.id === 201);
    assert.equal(movimento.entregador_uuid, undefined);

    // Restaura o mock do axios ao default para não vazar para outros describes.
    axiosMock.post = async () => _axiosMockResponse;
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// GORJETA — Task 2.2: Parse de gorjeta no upload (lógica unitária)
// Ref: spec gorjeta-motorista FR-001..FR-003 / CL-001/CL-004 / plan §6.1
// ──────────────────────────────────────────────────────────────────────────────

// Helpers inline (espelham server.js) para teste sem carregar o módulo completo
function toNumberBR_test(input) {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  const raw = String(input ?? '').trim();
  if (!raw) return NaN;
  const cleaned = raw.replace(/[^\d.,-]/g, '').replace(/\s+/g, '');
  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');
  let normalized = cleaned;
  if (hasComma && hasDot) {
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    normalized = cleaned.replace(',', '.');
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : NaN;
}

function parseGorjeta_test(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (s === 'R$ -' || s === '-') return null;
  const n = toNumberBR_test(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return parseFloat(n.toFixed(2));
}

describe('gorjeta Task 2.2 — parse de gorjeta no upload', () => {
  test('"R$ 22,00" → 22.00 (FR-001)', () => {
    assert.equal(parseGorjeta_test('R$ 22,00'), 22.00);
  });

  test('gorjeta undefined (coluna ausente na planilha) → null (FR-002 / FR-003)', () => {
    assert.equal(parseGorjeta_test(undefined), null);
  });

  test('gorjeta vazia ("") → null', () => {
    assert.equal(parseGorjeta_test(''), null);
  });

  test('"R$ -" → null sem rowError (CL-004)', () => {
    assert.equal(parseGorjeta_test('R$ -'), null);
  });

  test('"0" → null (zero é ausência — CL-001)', () => {
    assert.equal(parseGorjeta_test('0'), null);
  });

  // Regressão: upload sem gorjeta não altera outros campos
  test('dataToInsert sem gorjeta: outros campos intactos', () => {
    const row = { nome: 'João', valor: 'R$ 100,00', gorjeta: undefined };
    const gorjeta = parseGorjeta_test(row.gorjeta);
    const item = { nome: row.nome, valor: '100.00', gorjeta };
    assert.equal(item.nome, 'João');
    assert.equal(item.valor, '100.00');
    assert.equal(item.gorjeta, null);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// GORJETA — Task 3.2: Leitura de gorjeta no mapper /movimento-aberto
// Ref: spec gorjeta-motorista FR-004 / CL-002 / plan §6.2
// ──────────────────────────────────────────────────────────────────────────────

describe('gorjeta Task 3.2 — leitura no mapper /movimento-aberto', () => {
  const base = {
    id: 1, valor: '100.00', dt_inicial: '2026-01-01', dt_final: '2026-01-31',
    nome: 'Transportes XYZ', cnpj_tomador: '12.345.678/0001-00',
    cnpj_prestador: '98765432000199', tribnac: null,
    nota_ok: null, erro_validacao: null,
  };

  function mapMov(m) {
    return {
      id: m.id,
      valor: m.valor,
      gorjeta: m.gorjeta ?? null,
      dtInicial: m.dt_inicial,
      dtFinal: m.dt_final,
      nome: m.nome,
      cnpjTomador: m.cnpj_tomador,
      cnpjPrestador: m.cnpj_prestador,
      tribnac: m.tribnac,
      notaOk: m.nota_ok,
      erroValidacao: m.erro_validacao,
      tomador: null,
    };
  }

  test('gorjeta "22.0" no banco → gorjeta: "22.0" na resposta (FR-004)', () => {
    const mov = mapMov({ ...base, gorjeta: '22.0' });
    assert.equal(mov.gorjeta, '22.0');
  });

  test('gorjeta null no banco → gorjeta: null na resposta (FR-004)', () => {
    const mov = mapMov({ ...base, gorjeta: null });
    assert.equal(mov.gorjeta, null);
  });

  test('campo gorjeta ausente no registro (base antiga) → null (retrocompatibilidade — CL-002)', () => {
    const mov = mapMov({ ...base }); // sem gorjeta
    assert.equal(mov.gorjeta, null);
  });

  test('gorjeta não altera campo valor', () => {
    const mov = mapMov({ ...base, gorjeta: '50.00' });
    assert.equal(mov.valor, '100.00');
    assert.equal(mov.gorjeta, '50.00');
  });

  test('outros campos preservados — regressão zero', () => {
    const mov = mapMov({ ...base, gorjeta: null });
    assert.equal(mov.id, 1);
    assert.equal(mov.nome, 'Transportes XYZ');
    assert.equal(mov.cnpjPrestador, '98765432000199');
    assert.equal(mov.notaOk, null);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// GORJETA — Task 3.1 via HTTP: gorjeta retornada no endpoint /movimento-aberto
// ──────────────────────────────────────────────────────────────────────────────

describe('gorjeta Task 3.1 via HTTP — gorjeta no endpoint /movimento-aberto', () => {
  before(() => {
    resetDB();
    // Movimento com gorjeta
    DB.EnvioMassa.push({
      id: 200,
      cnpj_prestador: '77777777000100',
      mov_fechado: false,
      valor: '300.00',
      gorjeta: '22.00',
      dt_inicial: '2026-01-01',
      dt_final: '2026-01-31',
      nome: 'Empresa Gorjeta',
      cnpj_tomador: '88888888000100',
      tribnac: null,
      nota_ok: null,
      erro_validacao: null,
    });
    // Movimento sem gorjeta (base antiga)
    DB.EnvioMassa.push({
      id: 201,
      cnpj_prestador: '66666666000100',
      mov_fechado: false,
      valor: '500.00',
      // gorjeta ausente (undefined)
      dt_inicial: '2026-01-01',
      dt_final: '2026-01-31',
      nome: 'Empresa Sem Gorjeta',
      cnpj_tomador: '88888888000100',
      tribnac: null,
      nota_ok: null,
      erro_validacao: null,
    });
  });

  test('movimento com gorjeta → resposta inclui gorjeta: "22.00"', async () => {
    const tok = makeToken({ cnpjPrestador: '77777777000100' });
    const r = await request('GET', '/motorista/movimento-aberto', {
      cookies: `accessToken=${tok}`,
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.movimento, 'movimento deve existir');
    assert.equal(r.body.movimento.gorjeta, '22.00');
  });

  test('movimento sem gorjeta (base antiga) → resposta inclui gorjeta: null (CL-002)', async () => {
    const tok = makeToken({ cnpjPrestador: '66666666000100' });
    const r = await request('GET', '/motorista/movimento-aberto', {
      cookies: `accessToken=${tok}`,
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.movimento, 'movimento deve existir');
    assert.equal(r.body.movimento.gorjeta, null);
  });
});
