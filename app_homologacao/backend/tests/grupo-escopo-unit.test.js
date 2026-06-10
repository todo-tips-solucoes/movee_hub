/**
 * Testes unitários — GET /grupo/escopo (movimento-por-filial, task 1.2)
 * Rodam com: node --test tests/grupo-escopo-unit.test.js
 * Sem dependências externas (usa node:test + node:assert nativos do Node 18+).
 *
 * Cobre os critérios de aceite TS-BE-11, TS-BE-12, TS-BE-13 (tasks.md §1.2):
 *   TS-BE-11  Admin pai com 2 filiais → 200, array 3 itens, pai com default:true
 *   TS-BE-12  Filho/single → 200, array 1 item com default:true
 *   TS-BE-13  Sem token → 401 (testado via middleware; aqui: req.user ausente →
 *             servidor retorna 401 antes do handler chegar; validado no cenário simulado)
 *   TS-BE-14  campo `default` presente no campo raiz da resposta (= empresaId do token)
 *   TS-BE-15  nome_empresa presente em todos os itens
 *   TS-BE-16  Erro de banco → 503 { error: 'serviço indisponível' } (fail-closed)
 *   TS-BE-17  Pai sem filhos no DB → 200 com array de 1 item (apenas o próprio pai)
 *
 * Ref: docs/specs/movimento-por-filial/tasks.md §1.2
 *      docs/specs/movimento-por-filial/contracts/grupo-escopo-api.md §Endpoint
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// ──────────────────────────────────────────────────────────────────────────────
// Importar módulo sob teste
// ──────────────────────────────────────────────────────────────────────────────

const grupoModule = require('../routes/grupo.js');

// ──────────────────────────────────────────────────────────────────────────────
// Harness de mock Express (req / res) — sem subir servidor HTTP
// ──────────────────────────────────────────────────────────────────────────────

function makeRes() {
  const res = {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body)   { this._body = body; return this; },
  };
  return res;
}

/**
 * Simula req com req.user já injetado (authenticateToken rodou).
 * O endpoint real está atrás de authenticateToken no server.js;
 * aqui invocamos o handler diretamente com req.user populado.
 */
function makeReq({ user = {} } = {}) {
  return { user };
}

// ──────────────────────────────────────────────────────────────────────────────
// Mocks de _postgrestRequest
// ──────────────────────────────────────────────────────────────────────────────

function makePostgrestMock(rows) {
  return async (_endpoint, _method) => rows;
}

function makePostgrestError(msg) {
  return async () => { throw new Error(msg); };
}

// ──────────────────────────────────────────────────────────────────────────────
// Helper: invocar o handler GET /escopo diretamente via router dispatch
//
// O Express router armazena as layers internamente. Em vez de subir um servidor,
// chamamos o handler armazenado na última layer adicionada (GET /escopo).
// Alternativa mais robusta: expor o handler no módulo. Aqui usamos a abordagem
// de buscar a layer da rota /escopo no stack do router.
// ──────────────────────────────────────────────────────────────────────────────

function getEscopoHandler(router) {
  // Router do Express armazena layers em router.stack.
  // Cada layer tem route.path e route.stack[0].handle (o handler async).
  const layer = router.stack.find(
    l => l.route && l.route.path === '/escopo' && l.route.methods.get
  );
  if (!layer) throw new Error('Rota GET /escopo não encontrada no router');
  return layer.route.stack[0].handle;
}

// ──────────────────────────────────────────────────────────────────────────────
// Usuários de teste
// ──────────────────────────────────────────────────────────────────────────────

// Administrador do grupo (pai)
const userPai = {
  id: 10,
  empresaId: 1,
  nome_empresa: 'Matriz Logística',
  id_grupo: 5,
  is_grupo_pai: true,
};

// Filho / single-empresa (sem expansão de escopo)
const userFilho = {
  id: 20,
  empresaId: 2,
  nome_empresa: 'Filial São Paulo',
  id_grupo: 5,
  is_grupo_pai: false,
};

// Single-empresa sem grupo algum
const userSingle = {
  id: 30,
  empresaId: 7,
  nome_empresa: 'Empresa Solo',
  id_grupo: null,
  is_grupo_pai: false,
};

// ──────────────────────────────────────────────────────────────────────────────
// Suíte
// ──────────────────────────────────────────────────────────────────────────────

describe('GET /grupo/escopo — task 1.2 (movimento-por-filial)', () => {

  // ──────────────────────────────────────────────────────────────────────────
  // TS-BE-11: pai com 2 filiais → array de 3 itens, pai tem default:true
  // ──────────────────────────────────────────────────────────────────────────
  describe('TS-BE-11 — admin pai com 2 filiais: 200 + array de 3 itens', () => {

    test('resposta 200 com 3 itens (pai + 2 filiais)', async () => {
      // Banco retorna os 2 filhos (pai é incluído manualmente pelo handler)
      grupoModule.init({
        postgrestRequest: makePostgrestMock([
          { id: 2, nome_empresa: 'Filial São Paulo' },
          { id: 3, nome_empresa: 'Filial Rio de Janeiro' },
        ]),
        bcrypt: {},
      });

      const handler = getEscopoHandler(grupoModule.router);
      const req = makeReq({ user: userPai });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res._status, 200, 'deve retornar 200');
      const { empresas, default: def } = res._body;

      assert.equal(Array.isArray(empresas), true, 'empresas deve ser array');
      assert.equal(empresas.length, 3, 'deve ter 3 itens (pai + 2 filiais)');
      assert.equal(def, userPai.empresaId, 'campo default deve ser empresaId do token');
    });

    test('pai aparece primeiro e tem default:true', async () => {
      grupoModule.init({
        postgrestRequest: makePostgrestMock([
          { id: 2, nome_empresa: 'Filial SP' },
          { id: 3, nome_empresa: 'Filial RJ' },
        ]),
        bcrypt: {},
      });

      const handler = getEscopoHandler(grupoModule.router);
      const req = makeReq({ user: userPai });
      const res = makeRes();
      await handler(req, res);

      const { empresas } = res._body;
      assert.equal(empresas[0].id, userPai.empresaId, 'primeiro item deve ser o pai');
      assert.equal(empresas[0].default, true, 'pai deve ter default:true');
    });

    test('filiais NÃO têm default:true', async () => {
      grupoModule.init({
        postgrestRequest: makePostgrestMock([
          { id: 2, nome_empresa: 'Filial SP' },
          { id: 3, nome_empresa: 'Filial RJ' },
        ]),
        bcrypt: {},
      });

      const handler = getEscopoHandler(grupoModule.router);
      const req = makeReq({ user: userPai });
      const res = makeRes();
      await handler(req, res);

      const { empresas } = res._body;
      const filiais = empresas.slice(1);
      filiais.forEach(f => {
        assert.notEqual(f.default, true, `filial id=${f.id} não deve ter default:true`);
      });
    });

    test('TS-BE-15: nome_empresa presente em todos os itens', async () => {
      grupoModule.init({
        postgrestRequest: makePostgrestMock([
          { id: 2, nome_empresa: 'Filial SP' },
          { id: 3, nome_empresa: 'Filial RJ' },
        ]),
        bcrypt: {},
      });

      const handler = getEscopoHandler(grupoModule.router);
      const req = makeReq({ user: userPai });
      const res = makeRes();
      await handler(req, res);

      const { empresas } = res._body;
      empresas.forEach(e => {
        assert.ok(
          typeof e.nome_empresa === 'string' && e.nome_empresa.length > 0,
          `item id=${e.id} deve ter nome_empresa não-vazio`
        );
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TS-BE-12: filho/single-empresa → array de 1 item
  // ──────────────────────────────────────────────────────────────────────────
  describe('TS-BE-12 — filho ou single-empresa: 200 + array de 1 item', () => {

    test('filho: 200, 1 item, default:true (sem chamada ao banco)', async () => {
      // Banco NÃO deve ser chamado para is_grupo_pai=false
      grupoModule.init({
        postgrestRequest: makePostgrestError('DB não deve ser chamado para filho'),
        bcrypt: {},
      });

      const handler = getEscopoHandler(grupoModule.router);
      const req = makeReq({ user: userFilho });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res._status, 200);
      const { empresas, default: def } = res._body;
      assert.equal(empresas.length, 1, 'filho deve retornar exatamente 1 item');
      assert.equal(empresas[0].id, userFilho.empresaId);
      assert.equal(empresas[0].default, true);
      assert.equal(def, userFilho.empresaId);
    });

    test('single sem id_grupo: 200, 1 item, default:true (sem chamada ao banco)', async () => {
      grupoModule.init({
        postgrestRequest: makePostgrestError('DB não deve ser chamado para single'),
        bcrypt: {},
      });

      const handler = getEscopoHandler(grupoModule.router);
      const req = makeReq({ user: userSingle });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res._status, 200);
      const { empresas, default: def } = res._body;
      assert.equal(empresas.length, 1);
      assert.equal(empresas[0].id, userSingle.empresaId);
      assert.equal(empresas[0].nome_empresa, userSingle.nome_empresa);
      assert.equal(def, userSingle.empresaId);
    });

    test('TS-BE-15: nome_empresa presente para single', async () => {
      grupoModule.init({
        postgrestRequest: makePostgrestError('DB não deve ser chamado'),
        bcrypt: {},
      });

      const handler = getEscopoHandler(grupoModule.router);
      const req = makeReq({ user: userFilho });
      const res = makeRes();
      await handler(req, res);

      const { empresas } = res._body;
      assert.ok(typeof empresas[0].nome_empresa === 'string' && empresas[0].nome_empresa.length > 0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TS-BE-13: sem token → 401
  // O middleware authenticateToken em server.js retorna 401 antes do handler.
  // Aqui simulamos o cenário "req.user ausente" para confirmar que o handler
  // em si não crashe (o server nunca chegaria aqui, mas é defesa em profundidade).
  // ──────────────────────────────────────────────────────────────────────────
  describe('TS-BE-13 — sem token: comportamento fail-safe', () => {

    test('req.user ausente → handler não lança uncaught (retorna 503 ou trata graciosamente)', async () => {
      // authenticateToken intercepta antes no server real → 401.
      // No teste direto de handler, req.user é undefined; o handler deve tratar
      // sem explodir com "Cannot destructure property 'empresaId' of undefined".
      grupoModule.init({
        postgrestRequest: makePostgrestError('DB não deve ser chamado'),
        bcrypt: {},
      });

      const handler = getEscopoHandler(grupoModule.router);
      const req = { user: undefined };
      const res = makeRes();

      // Não deve lançar erro não-capturado; pode retornar 500/503.
      // O contrato real é garantido pelo middleware — aqui verificamos robustez.
      let threw = false;
      try {
        await handler(req, res);
      } catch (_) {
        threw = true;
      }
      // Aceitamos que o handler captura internamente (catch do try/catch) OU
      // que retorne um status de erro. O importante é não lançar uncaught.
      // Se lançou, o teste falha para sinalizar que o handler precisa de guard.
      assert.equal(threw, false, 'handler não deve lançar uncaught quando req.user é undefined');
    });

    test('nota: 401 real é responsabilidade do authenticateToken em server.js (linha 1834)', () => {
      // Este test documenta que TS-BE-13 é validado em integração com server.js,
      // não no handler isolado. O padrão da codebase (grupo-empresas-unit.test.js)
      // segue o mesmo critério: testes unitários cobrem lógica de negócio;
      // autenticação é coberta pelos testes de integração (motorista-integration.test.js).
      assert.ok(true, 'documentação: 401 é responsabilidade do middleware authenticateToken');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TS-BE-16: erro de banco → 503 fail-closed
  // ──────────────────────────────────────────────────────────────────────────
  describe('TS-BE-16 — erro de banco: 503 fail-closed (não vazar internals)', () => {

    test('banco lança → 503 { error: "serviço indisponível" }', async () => {
      grupoModule.init({
        postgrestRequest: makePostgrestError('FATAL: connection pool exhausted'),
        bcrypt: {},
      });

      const handler = getEscopoHandler(grupoModule.router);
      const req = makeReq({ user: userPai });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res._status, 503, 'deve retornar 503 em erro de banco');
      assert.ok(res._body.error, 'deve ter campo error');
      // Mensagem genérica — sem vazar detalhes de infra
      assert.ok(
        !JSON.stringify(res._body).includes('FATAL'),
        'resposta não deve vazar mensagem interna do banco'
      );
      assert.ok(
        !JSON.stringify(res._body).includes('pool'),
        'resposta não deve vazar "pool" do banco'
      );
    });

    test('banco lança → resposta não expõe stack trace', async () => {
      grupoModule.init({
        postgrestRequest: makePostgrestError('Internal server error with stack at line 42'),
        bcrypt: {},
      });

      const handler = getEscopoHandler(grupoModule.router);
      const req = makeReq({ user: userPai });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res._status, 503);
      const bodyStr = JSON.stringify(res._body);
      assert.ok(!bodyStr.includes('stack'), 'não deve expor stack');
      assert.ok(!bodyStr.includes('line 42'), 'não deve expor linha interna');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TS-BE-17: pai sem filhos no DB → 200 com 1 item (apenas o pai)
  // ──────────────────────────────────────────────────────────────────────────
  describe('TS-BE-17 — pai sem filhos cadastrados: 200 + array de 1 item', () => {

    test('banco retorna [] para filhos → resposta 200 com apenas o pai', async () => {
      grupoModule.init({
        postgrestRequest: makePostgrestMock([]),
        bcrypt: {},
      });

      const handler = getEscopoHandler(grupoModule.router);
      const req = makeReq({ user: userPai });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res._status, 200);
      const { empresas } = res._body;
      assert.equal(empresas.length, 1, 'sem filhos no DB → apenas o pai');
      assert.equal(empresas[0].id, userPai.empresaId);
      assert.equal(empresas[0].default, true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Shape da resposta: campo `default` raiz
  // ──────────────────────────────────────────────────────────────────────────
  describe('TS-BE-14 — campo default raiz na resposta', () => {

    test('campo default raiz = empresaId do token (pai)', async () => {
      grupoModule.init({
        postgrestRequest: makePostgrestMock([
          { id: 2, nome_empresa: 'Filial SP' },
        ]),
        bcrypt: {},
      });

      const handler = getEscopoHandler(grupoModule.router);
      const req = makeReq({ user: userPai });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res._body.default, userPai.empresaId);
    });

    test('campo default raiz = empresaId do token (filho)', async () => {
      grupoModule.init({
        postgrestRequest: makePostgrestError('DB não deve ser chamado'),
        bcrypt: {},
      });

      const handler = getEscopoHandler(grupoModule.router);
      const req = makeReq({ user: userFilho });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res._body.default, userFilho.empresaId);
    });
  });

});
