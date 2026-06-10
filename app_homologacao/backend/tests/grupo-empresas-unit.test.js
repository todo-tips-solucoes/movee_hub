/**
 * Testes unitários — POST /grupo/empresas (cadastro-filiais)
 * Rodam com: node --test tests/grupo-empresas-unit.test.js
 * Sem dependências externas (usa node:test + node:assert nativos do Node 18+).
 *
 * Cobre (T-2.4):
 *   2.4.1 Happy path: 201 com shape { id, nome_empresa, email, id_grupo }, pass ausente
 *   2.4.2 E-mail duplicado → 400
 *   2.4.3 CNPJ duplicado → 409
 *   2.4.4 CNPJ formato inválido (< ou > 14 dígitos) → 400
 *   2.4.5 Senha fraca → 400
 *   2.4.6 Não-admin → 403
 *   2.4.7 id_grupo no body ignorado — response traz id_grupo do token
 *   2.4.8 Regressão: POST /grupo/filhos continua operacional após refactor
 *
 * Ref: docs/specs/cadastro-filiais/tasks.md §T-2.4
 *      docs/specs/cadastro-filiais/contracts/grupo-empresas-api.md
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// ──────────────────────────────────────────────────────────────────────────────
// Harness de mock para Express (req/res/next)
// ──────────────────────────────────────────────────────────────────────────────

function makeRes() {
  const res = {
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body)   { this._body = body; return this; },
  };
  return res;
}

function makeReq({ body = {}, user = {} } = {}) {
  return { body, user };
}

// ──────────────────────────────────────────────────────────────────────────────
// Dependências mock
// ──────────────────────────────────────────────────────────────────────────────

/** bcrypt mock: hash retorna "hashed:<plain>", compare não é usado aqui */
const bcryptMock = {
  hash: async (plain, _rounds) => `hashed:${plain}`,
};

/**
 * Cria um postgrestRequest mock controlável.
 * handlers: Map de "MÉTODO ENDPOINT_PREFIX" → retorno (ou função(body))
 */
function makePostgrestMock(handlers = {}) {
  return async (endpoint, method = 'GET', body = null) => {
    const key = `${method} ${endpoint}`;
    for (const [pattern, value] of Object.entries(handlers)) {
      if (key.startsWith(pattern) || endpoint.startsWith(pattern.replace(/^[A-Z]+ /, ''))) {
        if (typeof value === 'function') return value(endpoint, method, body);
        return value;
      }
    }
    // Default: retornar array vazio (sem match → sem registro)
    return [];
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Importar o módulo sob teste (com injeção de dependências mock)
// ──────────────────────────────────────────────────────────────────────────────

// Importamos o módulo diretamente; init() injeta as deps.
// Cada describe reinicializa com seu próprio mock de postgrestRequest.
const grupoModule = require('../routes/grupo');

// ──────────────────────────────────────────────────────────────────────────────
// Helpers para invocar o handler do POST /empresas diretamente
// (sem subir servidor HTTP)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Localiza e executa o handler da rota POST /empresas no router Express.
 * Percorre a stack do router para encontrar a rota que corresponde.
 */
async function callPostEmpresas(req, res) {
  const router = grupoModule.router;

  // Encontrar a layer do POST /empresas na stack do router
  const layer = router.stack.find(
    l => l.route && l.route.path === '/empresas' && l.route.methods.post
  );
  if (!layer) throw new Error('Rota POST /empresas não encontrada na stack do router');

  // Executar middlewares da rota em sequência
  const handlers = layer.route.stack.map(s => s.handle);

  // requireGrupoPai é o primeiro middleware — simular req.user.is_grupo_pai
  // O segundo handler é o handler principal.
  for (const handler of handlers) {
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    await handler(req, res, next);
    // Se res já tem status setado (retornou antes de next), parar
    if (res._status !== null && !nextCalled) break;
  }
}

/**
 * Usuário admin padrão para os testes.
 * id_grupo = 10 → resolveOrCreateGrupo retorna 10 diretamente (sem criar).
 */
const DEFAULT_ADMIN = {
  empresaId: 1,
  id_grupo: 10,
  nome_empresa: 'Empresa Pai Ltda',
  is_grupo_pai: true,
};

/** Body mínimo válido para POST /empresas */
function validBody(overrides = {}) {
  return {
    nome_empresa: 'Filial Norte',
    email: 'filial.norte@example.com',
    senha: 'Senha1segura',
    cnpj: '12345678000195',
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Suite: POST /grupo/empresas
// ──────────────────────────────────────────────────────────────────────────────

describe('POST /grupo/empresas', () => {

  // ── T-2.4.1: Happy path ────────────────────────────────────────────────────
  test('2.4.1 happy path: 201 com shape correta, pass ausente', async () => {
    const postgrest = makePostgrestMock({
      // Unicidade email: vazio = não duplicado
      'GET Empresa?email': [],
      // Grupo do token: resolve diretamente (id_grupo = 10 no token)
      'GET Grupo?id_empresa_pai': [],
      // Contagem filhos: nenhum ainda
      'GET Empresa?id_grupo': [],
      // INSERT Empresa: retorna novo registro
      'POST Empresa': [{ id: 99, nome_empresa: 'Filial Norte', email: 'filial.norte@example.com', id_grupo: 10 }],
    });

    grupoModule.init({ postgrestRequest: postgrest, bcrypt: bcryptMock });

    const req = makeReq({ body: validBody(), user: DEFAULT_ADMIN });
    const res = makeRes();
    await callPostEmpresas(req, res);

    assert.equal(res._status, 201);
    assert.ok(res._body.id, 'deve ter id');
    assert.equal(res._body.nome_empresa, 'Filial Norte');
    assert.equal(res._body.email, 'filial.norte@example.com');
    assert.equal(res._body.id_grupo, 10);
    assert.ok(!('pass' in res._body), 'pass nao deve estar no response (SC-005)');
  });

  // ── T-2.4.2: E-mail duplicado → 400 ───────────────────────────────────────
  test('2.4.2 email duplicado retorna 400', async () => {
    const postgrest = makePostgrestMock({
      'GET Empresa?email': [{ id: 5 }], // já existe
    });

    grupoModule.init({ postgrestRequest: postgrest, bcrypt: bcryptMock });

    const req = makeReq({ body: validBody(), user: DEFAULT_ADMIN });
    const res = makeRes();
    await callPostEmpresas(req, res);

    assert.equal(res._status, 400);
    assert.ok(/e-mail/i.test(res._body.error || ''));
  });

  // ── T-2.4.3: CNPJ duplicado → 409 ────────────────────────────────────────
  test('2.4.3 cnpj duplicado retorna 409', async () => {
    const postgrest = makePostgrestMock({
      'GET Empresa?email': [],
      'GET Empresa?id_grupo': [],
      // INSERT dispara erro de UNIQUE constraint em cnpj
      'POST Empresa': (_ep, _m, _b) => {
        const err = new Error('duplicate key value violates unique constraint "empresa_cnpj_key"');
        throw err;
      },
    });

    grupoModule.init({ postgrestRequest: postgrest, bcrypt: bcryptMock });

    const req = makeReq({ body: validBody(), user: DEFAULT_ADMIN });
    const res = makeRes();
    await callPostEmpresas(req, res);

    assert.equal(res._status, 409);
    assert.ok(/cnpj/i.test(res._body.error || ''));
  });

  // ── T-2.4.4: CNPJ formato inválido → 400 ──────────────────────────────────
  test('2.4.4a cnpj com 13 digitos retorna 400', async () => {
    grupoModule.init({ postgrestRequest: makePostgrestMock({}), bcrypt: bcryptMock });
    const req = makeReq({ body: validBody({ cnpj: '1234567800019' }), user: DEFAULT_ADMIN });
    const res = makeRes();
    await callPostEmpresas(req, res);
    assert.equal(res._status, 400);
    assert.ok(/cnpj/i.test(res._body.error || ''));
  });

  test('2.4.4b cnpj com 15 digitos retorna 400', async () => {
    grupoModule.init({ postgrestRequest: makePostgrestMock({}), bcrypt: bcryptMock });
    const req = makeReq({ body: validBody({ cnpj: '123456780001950' }), user: DEFAULT_ADMIN });
    const res = makeRes();
    await callPostEmpresas(req, res);
    assert.equal(res._status, 400);
  });

  test('2.4.4c cnpj com mascara (pontos/barras) aceito se resultar em 14 digitos', async () => {
    // CNPJ formatado "12.345.678/0001-95" → 14 dígitos → válido
    const postgrest = makePostgrestMock({
      'GET Empresa?email': [],
      'GET Empresa?id_grupo': [],
      'POST Empresa': [{ id: 100, nome_empresa: 'X', email: 'x@x.com', id_grupo: 10 }],
    });
    grupoModule.init({ postgrestRequest: postgrest, bcrypt: bcryptMock });
    const req = makeReq({ body: validBody({ cnpj: '12.345.678/0001-95' }), user: DEFAULT_ADMIN });
    const res = makeRes();
    await callPostEmpresas(req, res);
    assert.equal(res._status, 201);
  });

  // ── T-2.4.5: Senha fraca → 400 ────────────────────────────────────────────
  test('2.4.5a senha sem maiuscula retorna 400', async () => {
    grupoModule.init({ postgrestRequest: makePostgrestMock({}), bcrypt: bcryptMock });
    const req = makeReq({ body: validBody({ senha: 'senha1sem' }), user: DEFAULT_ADMIN });
    const res = makeRes();
    await callPostEmpresas(req, res);
    assert.equal(res._status, 400);
    assert.ok(/senha/i.test(res._body.error || ''));
  });

  test('2.4.5b senha sem digito retorna 400', async () => {
    grupoModule.init({ postgrestRequest: makePostgrestMock({}), bcrypt: bcryptMock });
    const req = makeReq({ body: validBody({ senha: 'SenhaSemd' }), user: DEFAULT_ADMIN });
    const res = makeRes();
    await callPostEmpresas(req, res);
    assert.equal(res._status, 400);
  });

  test('2.4.5c senha curta (< 6) retorna 400', async () => {
    grupoModule.init({ postgrestRequest: makePostgrestMock({}), bcrypt: bcryptMock });
    const req = makeReq({ body: validBody({ senha: 'A1b' }), user: DEFAULT_ADMIN });
    const res = makeRes();
    await callPostEmpresas(req, res);
    assert.equal(res._status, 400);
  });

  // ── T-2.4.6: Não-admin → 403 ─────────────────────────────────────────────
  test('2.4.6 nao-admin retorna 403', async () => {
    grupoModule.init({ postgrestRequest: makePostgrestMock({}), bcrypt: bcryptMock });
    const userFilho = { ...DEFAULT_ADMIN, is_grupo_pai: false };
    const req = makeReq({ body: validBody(), user: userFilho });
    const res = makeRes();
    await callPostEmpresas(req, res);
    assert.equal(res._status, 403);
  });

  test('2.4.6b sem token retorna 403', async () => {
    grupoModule.init({ postgrestRequest: makePostgrestMock({}), bcrypt: bcryptMock });
    const req = makeReq({ body: validBody(), user: null });
    const res = makeRes();
    // Precisamos simular req.user = null (requireGrupoPai checa req.user)
    req.user = null;
    await callPostEmpresas(req, res);
    assert.equal(res._status, 403);
  });

  // ── T-2.4.7: id_grupo do body ignorado ────────────────────────────────────
  test('2.4.7 id_grupo no body ignorado; response usa id_grupo do token', async () => {
    const postgrest = makePostgrestMock({
      'GET Empresa?email': [],
      'GET Empresa?id_grupo': [],
      'POST Empresa': [{ id: 77, nome_empresa: 'Filial Sul', email: 'sul@x.com', id_grupo: 10 }],
    });
    grupoModule.init({ postgrestRequest: postgrest, bcrypt: bcryptMock });

    // Body inclui id_grupo: 999 (deve ser ignorado)
    const req = makeReq({
      body: { ...validBody(), id_grupo: 999 },
      user: DEFAULT_ADMIN, // token diz id_grupo = 10
    });
    const res = makeRes();
    await callPostEmpresas(req, res);

    assert.equal(res._status, 201);
    assert.equal(res._body.id_grupo, 10, 'id_grupo deve ser do token (10), nao do body (999)');
  });

  // ── T-2.4.8: Regressão POST /grupo/filhos ─────────────────────────────────
  test('2.4.8 regressao: POST /grupo/filhos encontrado na stack do router', () => {
    const router = grupoModule.router;
    const layer = router.stack.find(
      l => l.route && l.route.path === '/filhos' && l.route.methods.post
    );
    assert.ok(layer, 'POST /grupo/filhos deve existir na stack do router apos refactor');
  });

  test('2.4.8b regressao: GET /grupo/filhos encontrado na stack do router', () => {
    const router = grupoModule.router;
    const layer = router.stack.find(
      l => l.route && l.route.path === '/filhos' && l.route.methods.get
    );
    assert.ok(layer, 'GET /grupo/filhos deve existir na stack do router apos refactor');
  });

  // ── Campos fiscais opcionais ───────────────────────────────────────────────
  test('campos fiscais opcionais incluidos no payload quando fornecidos', async () => {
    let payloadEnviado = null;
    const postgrest = async (endpoint, method, body) => {
      if (method === 'POST' && endpoint === 'Empresa') {
        payloadEnviado = body;
        return [{ id: 50, nome_empresa: 'Filial X', email: 'x@x.com', id_grupo: 10 }];
      }
      return [];
    };

    grupoModule.init({ postgrestRequest: postgrest, bcrypt: bcryptMock });

    const req = makeReq({
      body: {
        ...validBody(),
        endereco: 'Rua A, 123',
        numero: '123',
        cep: '01310-100',
        email_nota: 'nota@x.com',
        observacao: 'Obs teste',
      },
      user: DEFAULT_ADMIN,
    });
    const res = makeRes();
    await callPostEmpresas(req, res);

    assert.equal(res._status, 201);
    assert.ok(payloadEnviado, 'payload deve ter sido enviado ao postgrest');
    assert.equal(payloadEnviado.endereco, 'Rua A, 123');
    assert.equal(payloadEnviado.numero, '123');
    assert.equal(payloadEnviado.cep, '01310-100');
    assert.equal(payloadEnviado.email_nota, 'nota@x.com');
    assert.equal(payloadEnviado.observacao, 'Obs teste');
    assert.ok(!('pass' in res._body), 'pass nao deve vazar no response');
  });

  test('senha hasheada antes do INSERT (bcrypt.hash chamado)', async () => {
    let payloadEnviado = null;
    const postgrest = async (endpoint, method, body) => {
      if (method === 'POST' && endpoint === 'Empresa') {
        payloadEnviado = body;
        return [{ id: 51, nome_empresa: 'Y', email: 'y@y.com', id_grupo: 10 }];
      }
      return [];
    };

    grupoModule.init({ postgrestRequest: postgrest, bcrypt: bcryptMock });

    const req = makeReq({ body: validBody({ senha: 'Senha1ok' }), user: DEFAULT_ADMIN });
    const res = makeRes();
    await callPostEmpresas(req, res);

    assert.equal(res._status, 201);
    assert.equal(payloadEnviado.pass, 'hashed:Senha1ok', 'senha deve ser hasheada');
    assert.ok(!('senha' in payloadEnviado), 'campo senha nao deve estar no payload (apenas pass)');
  });

  // ── DDL não aplicado: 503 claro ───────────────────────────────────────────
  test('coluna cnpj ausente (DDL 004 nao aplicado) retorna 503 com mensagem clara', async () => {
    const postgrest = async (endpoint, method) => {
      if (method === 'POST' && endpoint === 'Empresa') {
        throw new Error('column "cnpj" of relation "Empresa" does not exist (42703)');
      }
      return [];
    };

    grupoModule.init({ postgrestRequest: postgrest, bcrypt: bcryptMock });

    const req = makeReq({ body: validBody(), user: DEFAULT_ADMIN });
    const res = makeRes();
    await callPostEmpresas(req, res);

    assert.equal(res._status, 503);
    assert.ok(/DDL 004/i.test(res._body.error || ''), 'mensagem deve mencionar DDL 004');
  });

  // ── Limite 100 filiais ────────────────────────────────────────────────────
  test('limite de 100 filiais retorna 422', async () => {
    // Simular 100 filhos já existentes (excluindo o pai)
    const filhos100 = Array.from({ length: 100 }, (_, i) => ({ id: i + 2 }));
    const postgrest = makePostgrestMock({
      'GET Empresa?email': [],
      'GET Empresa?id_grupo': filhos100,
    });

    grupoModule.init({ postgrestRequest: postgrest, bcrypt: bcryptMock });

    const req = makeReq({ body: validBody(), user: DEFAULT_ADMIN });
    const res = makeRes();
    await callPostEmpresas(req, res);

    assert.equal(res._status, 422);
    assert.ok(/limite/i.test(res._body.error || ''));
  });

});

// ──────────────────────────────────────────────────────────────────────────────
// Suite: helper resolveOrCreateGrupo (T-2.1)
// ──────────────────────────────────────────────────────────────────────────────

describe('resolveOrCreateGrupo', () => {
  const { resolveOrCreateGrupo } = grupoModule;

  test('retorna id_grupo do token quando presente', async () => {
    grupoModule.init({ postgrestRequest: makePostgrestMock({}), bcrypt: bcryptMock });
    const id = await resolveOrCreateGrupo({ empresaId: 1, id_grupo: 10, nome_empresa: 'X' });
    assert.equal(id, 10);
  });

  test('busca grupo existente quando id_grupo ausente no token', async () => {
    const postgrest = makePostgrestMock({
      'GET Grupo?id_empresa_pai': [{ id: 42 }],
    });
    grupoModule.init({ postgrestRequest: postgrest, bcrypt: bcryptMock });
    const id = await resolveOrCreateGrupo({ empresaId: 5, id_grupo: null, nome_empresa: 'Y' });
    assert.equal(id, 42);
  });

  test('cria grupo novo quando nao existe e id_grupo ausente', async () => {
    const postgrest = makePostgrestMock({
      'GET Grupo?id_empresa_pai': [],
      'POST Grupo': [{ id: 99 }],
    });
    grupoModule.init({ postgrestRequest: postgrest, bcrypt: bcryptMock });
    const id = await resolveOrCreateGrupo({ empresaId: 7, id_grupo: null, nome_empresa: 'Z' });
    assert.equal(id, 99);
  });

  test('lança erro para id_grupo invalido no token', async () => {
    grupoModule.init({ postgrestRequest: makePostgrestMock({}), bcrypt: bcryptMock });
    await assert.rejects(
      () => resolveOrCreateGrupo({ empresaId: 1, id_grupo: 'injeção; DROP', nome_empresa: 'X' }),
      /inválidos/
    );
  });
});
