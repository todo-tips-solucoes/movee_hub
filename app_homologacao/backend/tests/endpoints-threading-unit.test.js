/**
 * Testes unitários — threading empresa_id nos endpoints (movimento-por-filial, task 1.6)
 * Rodam com: node --test tests/endpoints-threading-unit.test.js
 * Sem dependências externas (usa node:test + node:assert nativos do Node 18+).
 *
 * Cobre TS-BE-1..10 + CHK009-API:
 *   TS-BE-1   GET /envio-massa sem empresa_id → resolveEmpresaAlvo retorna user.empresaId
 *   TS-BE-2   GET /envio-massa?empresa_id=<filial> → id_empresa usado na query é o da filial
 *   TS-BE-3   GET /envio-massa?empresa_id=<fora> → 403
 *   TS-BE-4   GET /envio-massa?empresa_id=abc → 403 "empresa_id inválido"
 *   TS-BE-5   Filho não expande escopo: filho tenta outra empresa do grupo → 403
 *   TS-BE-6   POST /upload empresa_id válido → id_empresa correto na gravação
 *   TS-BE-7   POST /upload empresa_id fora do escopo → 403, nada gravado
 *   TS-BE-8   POST /close-movimento empresa_id X → fecha apenas X (filtro id_empresa)
 *   TS-BE-9   DELETE /envio-massa/:id?empresa_id=X → não deleta registro de Y (filtro)
 *   TS-BE-10  PATCH /update-envio-massa/:id empresa_id divergente → 404 (0 linhas)
 *   CHK009    POST /close-movimento com 0 registros abertos → 200 { fechados: 0 }
 *
 * Estratégia: todos os handlers testados dependem de resolveEmpresaAlvo (grupo.js),
 * que aceita injeção de postgrestRequest via init(). Os handlers de server.js são
 * reproduzidos inline (handler-under-test), replicando o mesmo padrão de threading
 * sem subir o servidor HTTP — idêntico ao padrão de grupo-escopo-unit.test.js.
 *
 * Ref: docs/specs/movimento-por-filial/tasks.md §1.6
 *      docs/specs/movimento-por-filial/quickstart.md TS-BE-1..13
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// ──────────────────────────────────────────────────────────────────────────────
// Importar módulo com resolveEmpresaAlvo (injetável via init)
// ──────────────────────────────────────────────────────────────────────────────

const grupoModule = require('../routes/grupo.js');
const { resolveEmpresaAlvo } = grupoModule;

// ──────────────────────────────────────────────────────────────────────────────
// Mocks de postgrestRequest
// ──────────────────────────────────────────────────────────────────────────────

/** Retorna rows fixas; captura endpoint+method+body chamados. */
function makePostgrestSpy(rows = []) {
  const calls = [];
  const fn = async (endpoint, method = 'GET', body = null) => {
    calls.push({ endpoint, method, body });
    return rows;
  };
  fn.calls = calls;
  return fn;
}

/** Sempre lança — simula banco indisponível. */
function makePostgrestError(msg) {
  return async () => { throw new Error(msg); };
}

// ──────────────────────────────────────────────────────────────────────────────
// Mock de req/res Express
// ──────────────────────────────────────────────────────────────────────────────

function makeRes() {
  const res = {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body)   { this._body  = body;  return this; },
  };
  return res;
}

// ──────────────────────────────────────────────────────────────────────────────
// Usuários de teste
// ──────────────────────────────────────────────────────────────────────────────

// Admin pai: escopo = [1, 2, 3] (1 = matriz, 2 e 3 = filiais)
const userPai = {
  id: 10,
  empresaId: 1,
  id_grupo: 5,
  is_grupo_pai: true,
};

// Filho: escopo = [2] apenas (não expande para outras do grupo)
const userFilho = {
  id: 20,
  empresaId: 2,
  id_grupo: 5,
  is_grupo_pai: false,
};

// Filiais retornadas pelo banco para userPai (ids 2 e 3)
const filiaisDoGrupo = [{ id: 2 }, { id: 3 }];

// ──────────────────────────────────────────────────────────────────────────────
// Handler inline: GET /envio-massa (replica server.js linhas 277-296)
// Recebe { user, query } e retorna { status, body }.
// ──────────────────────────────────────────────────────────────────────────────

async function handlerGetEnvioMassa({ user, query = {} }, postgrestSpy) {
  grupoModule.init({ postgrestRequest: postgrestSpy, bcrypt: {} });
  const req = { user, query };
  const res = makeRes();

  let idEmp;
  try {
    idEmp = await resolveEmpresaAlvo(req.user, req.query.empresa_id, 'GET /envio-massa');
  } catch (authErr) {
    const status = authErr.status || 403;
    res.status(status).json({ error: authErr.message });
    return res;
  }
  try {
    // Simula a query que o handler real faria
    await postgrestSpy(`EnvioMassa?id_empresa=eq.${idEmp}&mov_fechado=eq.false`);
    res.json({ _idEmpUsed: idEmp });
  } catch (err) {
    res.status(400).json({ error: 'Erro ao buscar dados' });
  }
  return res;
}

// ──────────────────────────────────────────────────────────────────────────────
// Handler inline: POST /upload (replica padrão movimento-por-filial em server.js)
// Testa apenas a camada de resolveEmpresaAlvo + controle de fluxo 403/ok.
// ──────────────────────────────────────────────────────────────────────────────

async function handlerPostUpload({ user, body = {} }, postgrestSpy) {
  grupoModule.init({ postgrestRequest: postgrestSpy, bcrypt: {} });
  const req = { user, body };
  const res = makeRes();

  let idEmp;
  try {
    idEmp = await resolveEmpresaAlvo(req.user, req.body.empresa_id, 'POST /upload');
  } catch (err) {
    res.status(err.status || 403).json({ error: err.error || 'empresa fora do escopo' });
    return res;
  }
  // Simula gravação com id_empresa resolvido
  await postgrestSpy('EnvioMassa', 'POST', { id_empresa: idEmp });
  res.json({ success: true, id_empresa_gravado: idEmp });
  return res;
}

// ──────────────────────────────────────────────────────────────────────────────
// Handler inline: POST /close-movimento (replica server.js com fix CHK009)
// ──────────────────────────────────────────────────────────────────────────────

async function handlerCloseMovimento({ user, body = {} }, postgrestSpy) {
  grupoModule.init({ postgrestRequest: postgrestSpy, bcrypt: {} });
  const req = { user, body };
  const res = makeRes();

  let idEmp;
  try {
    idEmp = await resolveEmpresaAlvo(req.user, req.body.empresa_id, 'POST /close-movimento');
  } catch (err) {
    res.status(err.status || 403).json({ error: err.error || 'empresa fora do escopo' });
    return res;
  }
  try {
    const updated = await postgrestSpy(
      `EnvioMassa?id_empresa=eq.${idEmp}&mov_fechado=eq.false`,
      'PATCH',
      { mov_fechado: true }
    );
    // CHK009-API: retorna contagem de registros fechados
    const fechados = Array.isArray(updated) ? updated.length : 0;
    res.json({ message: 'Movimento fechado com sucesso', fechados });
  } catch (err) {
    res.status(500).json({ error: 'Erro no servidor ao fechar o movimento' });
  }
  return res;
}

// ──────────────────────────────────────────────────────────────────────────────
// Handler inline: DELETE /envio-massa/:id (replica server.js linhas 808-827)
// ──────────────────────────────────────────────────────────────────────────────

async function handlerDeleteEnvioMassa({ user, params = {}, query = {} }, postgrestSpy) {
  grupoModule.init({ postgrestRequest: postgrestSpy, bcrypt: {} });
  const req = { user, params, query };
  const res = makeRes();

  let idEmp;
  try {
    idEmp = await resolveEmpresaAlvo(req.user, req.query.empresa_id, 'DELETE /envio-massa/:id');
  } catch (err) {
    res.status(err.status || 403).json({ error: err.error || 'empresa fora do escopo' });
    return res;
  }
  try {
    const { id } = req.params;
    // Filtro composto: id=eq.<id>&id_empresa=eq.<idEmp> — fecha IDOR
    await postgrestSpy(`EnvioMassa?id=eq.${id}&id_empresa=eq.${idEmp}`, 'DELETE');
    res.json({ message: 'Registro deletado com sucesso!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
  return res;
}

// ──────────────────────────────────────────────────────────────────────────────
// Handler inline: PATCH /update-envio-massa/:id (replica server.js linhas 779-806)
// ──────────────────────────────────────────────────────────────────────────────

async function handlerPatchEnvioMassa({ user, params = {}, body = {} }, postgrestSpy) {
  grupoModule.init({ postgrestRequest: postgrestSpy, bcrypt: {} });
  const req = { user, params, body };
  const res = makeRes();

  let idEmp;
  try {
    idEmp = await resolveEmpresaAlvo(req.user, req.body.empresa_id, 'PATCH /update-envio-massa/:id');
  } catch (err) {
    res.status(err.status || 403).json({ error: err.error || 'empresa fora do escopo' });
    return res;
  }
  try {
    const { id } = req.params;
    // Filtro composto id+id_empresa fecha IDOR (FR-013)
    const result = await postgrestSpy(
      `EnvioMassa?id=eq.${id}&id_empresa=eq.${idEmp}`,
      'PATCH',
      { enviado: body.enviado }
    );
    if (Array.isArray(result) && result.length === 0) {
      res.status(404).json({ error: 'Registro não encontrado ou não pertence à empresa.' });
      return res;
    }
    res.json({ message: 'Registro atualizado com sucesso!', data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
  return res;
}

// ──────────────────────────────────────────────────────────────────────────────
// Suítes de testes
// ──────────────────────────────────────────────────────────────────────────────

describe('TS-BE-1..5 — GET /envio-massa threading empresa_id (task 1.6)', () => {

  test('TS-BE-1: sem empresa_id → usa empresaId do token (regressão zero)', async () => {
    // userPai sem filiais solicitadas → usa empresaId=1
    const spy = makePostgrestSpy([{ id: 10, id_empresa: 1 }]);
    // Para requestedId=undefined → resolveEmpresaAlvo retorna user.empresaId sem chamar banco
    const res = await handlerGetEnvioMassa({ user: userPai, query: {} }, spy);

    assert.equal(res._status, 200);
    assert.equal(res._body._idEmpUsed, userPai.empresaId,
      'id_empresa usado deve ser o do token quando empresa_id não é passado');
  });

  test('TS-BE-2: empresa_id de filial dentro do escopo → query usa id da filial', async () => {
    // userPai (pai do grupo) solicita filial id=2
    // _resolveScopeStrict chamará banco para obter filhos → retorna [{ id:2 }, { id:3 }]
    const spy = makePostgrestSpy(filiaisDoGrupo); // mock para _resolveScopeStrict
    // Precisamos de spy separado para cada call: primeiro retorna filhos (para resolveScope),
    // depois retorna dados (para a query do handler)
    const calls = [];
    const multiSpy = async (endpoint, method = 'GET', body = null) => {
      calls.push({ endpoint, method });
      if (endpoint.startsWith('Empresa?')) return filiaisDoGrupo; // chamada do _resolveScopeStrict
      return [{ id: 99, id_empresa: 2 }]; // dados da filial
    };
    multiSpy.calls = calls;

    grupoModule.init({ postgrestRequest: multiSpy, bcrypt: {} });
    const req = { user: userPai, query: { empresa_id: '2' } };
    const res = makeRes();

    let idEmp;
    try {
      idEmp = await resolveEmpresaAlvo(req.user, req.query.empresa_id, 'GET /envio-massa');
    } catch (e) {
      assert.fail(`Não deveria lançar: ${e.message}`);
    }
    // Simula query do handler com idEmp resolvido
    await multiSpy(`EnvioMassa?id_empresa=eq.${idEmp}&mov_fechado=eq.false`);
    res.json({ _idEmpUsed: idEmp });

    assert.equal(res._status, 200);
    assert.equal(idEmp, 2, 'id_empresa usado deve ser 2 (filial solicitada)');
    // Verificar que a query de dados usa id_empresa=eq.2
    const dataCall = calls.find(c => c.endpoint.includes('EnvioMassa?id_empresa=eq.2'));
    assert.ok(dataCall, 'query final deve filtrar por id_empresa=eq.2');
  });

  test('TS-BE-3: empresa_id fora do escopo → 403 sem expor dados', async () => {
    // userFilho (escopo=[2]) tenta empresa 99 (outro grupo)
    const spy = makePostgrestSpy([]); // banco não retorna filhos (filho não expande)
    const res = await handlerGetEnvioMassa(
      { user: userFilho, query: { empresa_id: '99' } },
      spy
    );

    assert.equal(res._status, 403, 'deve retornar 403');
    assert.ok(res._body.error, 'deve ter campo error');
    assert.ok(
      res._body.error.includes('fora do escopo') || res._body.error.includes('empresa'),
      `mensagem de erro deve mencionar escopo, obteve: "${res._body.error}"`
    );
  });

  test('TS-BE-4: empresa_id não-numérico "abc" → 403 empresa_id inválido', async () => {
    // DB não deve ser chamado — validação de tipo ocorre antes
    const spy = makePostgrestSpy([]);
    const res = await handlerGetEnvioMassa(
      { user: userPai, query: { empresa_id: 'abc' } },
      spy
    );

    assert.equal(res._status, 403, 'deve retornar 403 para empresa_id não-numérico');
    assert.ok(
      res._body.error.includes('inválido'),
      `mensagem deve conter "inválido", obteve: "${res._body.error}"`
    );
    assert.equal(spy.calls.length, 0, 'banco não deve ser chamado para empresa_id inválido');
  });

  test('TS-BE-4b: empresa_id "1; DROP TABLE" → 403 (injeção SQL bloqueada)', async () => {
    // "1; DROP TABLE" — parseInt retorna 1, que está no escopo de userPai
    // Mas para userFilho (escopo=[2]), o parseInt(1) fica fora do escopo → 403
    const spy = makePostgrestSpy([]);
    const res = await handlerGetEnvioMassa(
      { user: userFilho, query: { empresa_id: '1; DROP TABLE' } },
      spy
    );

    // parseInt('1; DROP TABLE') = 1; userFilho escopo=[2], então 1 fora do escopo → 403
    assert.equal(res._status, 403, 'deve retornar 403 para empresa fora do escopo');
  });

  test('TS-BE-5: filho não expande escopo — tenta empresa da matriz → 403', async () => {
    // userFilho (empresaId=2, is_grupo_pai=false) não deve acessar empresa 1 (pai)
    const spy = makePostgrestSpy([]); // filho não consulta banco para escopo
    const res = await handlerGetEnvioMassa(
      { user: userFilho, query: { empresa_id: '1' } },
      spy
    );

    assert.equal(res._status, 403,
      'filho não deve conseguir acessar empresa do pai (escopo não expande)');
    assert.equal(spy.calls.length, 0,
      'banco não deve ser consultado — filho é single-company, sem expansão');
  });

});

describe('TS-BE-6..7 — POST /upload threading empresa_id (task 1.6)', () => {

  test('TS-BE-6: empresa_id válido (filial no escopo) → id_empresa gravado corretamente', async () => {
    // userPai solicita upload para filial id=3 (no escopo)
    const calls = [];
    const multiSpy = async (endpoint, method = 'GET', body = null) => {
      calls.push({ endpoint, method, body });
      if (endpoint.startsWith('Empresa?')) return filiaisDoGrupo;
      return [{ id: 1 }]; // resposta da gravação
    };

    grupoModule.init({ postgrestRequest: multiSpy, bcrypt: {} });

    let idEmp;
    try {
      idEmp = await resolveEmpresaAlvo(userPai, '3', 'POST /upload');
    } catch (e) {
      assert.fail(`Não deveria lançar: ${e.message}`);
    }

    // Simula gravação com o idEmp resolvido
    await multiSpy('EnvioMassa', 'POST', { id_empresa: idEmp });

    assert.equal(idEmp, 3, 'id_empresa resolvido deve ser 3');
    const gravacao = calls.find(c => c.method === 'POST' && c.endpoint === 'EnvioMassa');
    assert.ok(gravacao, 'deve ter chamado o banco para gravar');
    assert.equal(gravacao.body.id_empresa, 3, 'gravação deve usar id_empresa=3');
  });

  test('TS-BE-7: empresa_id fora do escopo → 403, nada gravado', async () => {
    const spy = makePostgrestSpy([]);
    // userFilho tenta upload para empresa 99 (fora do seu escopo=[2])
    const res = await handlerPostUpload(
      { user: userFilho, body: { empresa_id: '99' } },
      spy
    );

    assert.equal(res._status, 403, 'deve retornar 403 para upload fora do escopo');
    // Banco não deve ter recebido chamada POST de gravação
    const gravacoes = spy.calls.filter(c => c.method === 'POST');
    assert.equal(gravacoes.length, 0, '0 registros gravados quando fora do escopo');
  });

});

describe('TS-BE-8 + CHK009 — POST /close-movimento threading (task 1.6)', () => {

  test('TS-BE-8: close-movimento filtra por id_empresa do token/param', async () => {
    // userPai fecha filial 2 → filtro deve ser id_empresa=eq.2
    const calls = [];
    const multiSpy = async (endpoint, method = 'GET', body = null) => {
      calls.push({ endpoint, method, body });
      if (endpoint.startsWith('Empresa?')) return filiaisDoGrupo;
      return [{ id: 1, id_empresa: 2 }, { id: 2, id_empresa: 2 }]; // 2 registros fechados
    };

    const res = await handlerCloseMovimento(
      { user: userPai, body: { empresa_id: '2' } },
      multiSpy
    );

    assert.equal(res._status, 200);
    // Verificar que o filtro do PATCH usa id_empresa=eq.2
    const patchCall = calls.find(c => c.method === 'PATCH' && c.endpoint.includes('EnvioMassa'));
    assert.ok(patchCall, 'deve ter chamado PATCH no banco');
    assert.ok(
      patchCall.endpoint.includes('id_empresa=eq.2'),
      `filtro deve usar id_empresa=eq.2, obteve: "${patchCall.endpoint}"`
    );
    assert.ok(
      patchCall.endpoint.includes('mov_fechado=eq.false'),
      'filtro deve incluir mov_fechado=eq.false para fechar apenas abertos'
    );
  });

  test('CHK009: close-movimento com 0 registros abertos → 200 { fechados: 0 }', async () => {
    // PostgREST com Prefer:return=representation retorna [] quando 0 linhas casaram
    const spy = makePostgrestSpy([]); // sem registros abertos para fechar

    const res = await handlerCloseMovimento(
      { user: userPai, body: {} }, // sem empresa_id → usa própria empresa
      spy
    );

    assert.equal(res._status, 200, 'deve retornar 200 mesmo com 0 registros');
    assert.equal(res._body.fechados, 0,
      `deve retornar { fechados: 0 }, obteve: ${JSON.stringify(res._body)}`);
  });

  test('CHK009b: close-movimento com N registros → { fechados: N }', async () => {
    // Simula 3 registros sendo fechados
    const spy = makePostgrestSpy([
      { id: 10, id_empresa: 1 },
      { id: 11, id_empresa: 1 },
      { id: 12, id_empresa: 1 },
    ]);

    const res = await handlerCloseMovimento(
      { user: userPai, body: {} },
      spy
    );

    assert.equal(res._status, 200);
    assert.equal(res._body.fechados, 3,
      `deve retornar { fechados: 3 }, obteve: ${JSON.stringify(res._body)}`);
  });

  test('TS-BE-8 isolamento: close para empresa X não toca empresa Y', async () => {
    // Demonstra que o filtro id_empresa=eq.X impede fechar registros de Y.
    // Testa que a query de PATCH NÃO inclui o id da empresa Y.
    const calls = [];
    const multiSpy = async (endpoint, method = 'GET', body = null) => {
      calls.push({ endpoint, method, body });
      if (endpoint.startsWith('Empresa?')) return filiaisDoGrupo;
      return [{ id: 5, id_empresa: 3 }]; // 1 registro da empresa 3
    };

    const res = await handlerCloseMovimento(
      { user: userPai, body: { empresa_id: '3' } }, // fecha apenas filial 3
      multiSpy
    );

    assert.equal(res._status, 200);
    const patchCall = calls.find(c => c.method === 'PATCH' && c.endpoint.includes('EnvioMassa'));
    // Filtro deve conter id_empresa=eq.3 (não id_empresa=eq.1 ou eq.2)
    assert.ok(patchCall.endpoint.includes('id_empresa=eq.3'),
      'filtro deve ser id_empresa=eq.3 (empresa X), não vazar para Y');
    assert.ok(!patchCall.endpoint.includes('id_empresa=eq.1'),
      'filtro não deve conter id_empresa=eq.1 (empresa Y)');
    assert.equal(res._body.fechados, 1, 'deve reportar 1 registro fechado');
  });

});

describe('TS-BE-9 — DELETE /envio-massa threading (task 1.6)', () => {

  test('TS-BE-9: DELETE registro de empresa Y com empresa_id=X → Y não é deletado (filtro composto)', async () => {
    // userPai (escopo=[1,2,3]) deleta com empresa_id=1 mas o registro pertence à empresa 2.
    // O filtro composto id=eq.<id>&id_empresa=eq.1 não casa o registro (que tem id_empresa=2)
    // → PostgREST retorna 204/vazio (simulado: sem erro, mas filtro está correto).
    const calls = [];
    const multiSpy = async (endpoint, method = 'GET', body = null) => {
      calls.push({ endpoint, method, body });
      if (endpoint.startsWith('Empresa?')) return filiaisDoGrupo;
      return []; // DELETE com filtro que não casa → 0 linhas deletadas
    };

    const res = await handlerDeleteEnvioMassa(
      {
        user: userPai,
        params: { id: '42' },     // id do registro que pertence à empresa 2
        query: { empresa_id: '1' }, // empresa_id=1 → filtro não casa com registro de empresa 2
      },
      multiSpy
    );

    assert.equal(res._status, 200, 'handler responde 200 (PostgREST não lança para DELETE sem match)');
    // Verificar que o filtro do DELETE inclui AMBOS: id e id_empresa
    const deleteCall = calls.find(c => c.method === 'DELETE' && c.endpoint.includes('EnvioMassa'));
    assert.ok(deleteCall, 'deve ter chamado DELETE no banco');
    assert.ok(
      deleteCall.endpoint.includes('id=eq.42'),
      `filtro deve incluir id=eq.42, obteve: "${deleteCall.endpoint}"`
    );
    assert.ok(
      deleteCall.endpoint.includes('id_empresa=eq.1'),
      `filtro deve incluir id_empresa=eq.1, obteve: "${deleteCall.endpoint}"`
    );
    // O filtro composto garante que registro de id_empresa=2 NÃO é deletado.
    // Se o endpoint contiver id_empresa=eq.1 E o registro tiver id_empresa=2, PostgREST não deleta.
    assert.ok(
      !deleteCall.endpoint.includes('id_empresa=eq.2'),
      'filtro NÃO deve conter id_empresa=eq.2 (empresa que possui o registro)'
    );
  });

  test('TS-BE-9b: DELETE sem empresa_id → usa empresaId do token (sem regressão)', async () => {
    // Para requestedId=undefined → resolveEmpresaAlvo retorna user.empresaId sem chamar banco
    const spy = makePostgrestSpy([]);
    const res = await handlerDeleteEnvioMassa(
      { user: userPai, params: { id: '10' }, query: {} },
      spy
    );

    assert.equal(res._status, 200);
    // A chamada de DELETE deve usar id_empresa=eq.1 (empresaId do token)
    const deleteCall = spy.calls.find(c => c.method === 'DELETE');
    assert.ok(deleteCall.endpoint.includes('id_empresa=eq.1'),
      'sem empresa_id no query → filtro usa empresaId do token');
  });

  test('TS-BE-9c: DELETE com empresa_id fora do escopo → 403 (nada deletado)', async () => {
    const spy = makePostgrestSpy([]);
    const res = await handlerDeleteEnvioMassa(
      { user: userFilho, params: { id: '10' }, query: { empresa_id: '99' } },
      spy
    );

    assert.equal(res._status, 403, 'deve retornar 403 para empresa fora do escopo');
    const deleteCalls = spy.calls.filter(c => c.method === 'DELETE');
    assert.equal(deleteCalls.length, 0, 'banco não deve receber DELETE quando 403');
  });

});

describe('TS-BE-10 — PATCH /update-envio-massa IDOR (task 1.6)', () => {

  test('TS-BE-10: PATCH com empresa_id fora do escopo → 403', async () => {
    // userFilho (escopo=[2]) tenta PATCH com empresa_id=1 → 403
    const spy = makePostgrestSpy([]);
    const res = await handlerPatchEnvioMassa(
      { user: userFilho, params: { id: '5' }, body: { empresa_id: '1', enviado: true } },
      spy
    );

    assert.equal(res._status, 403, 'deve retornar 403 para empresa fora do escopo');
    const patchCalls = spy.calls.filter(c => c.method === 'PATCH');
    assert.equal(patchCalls.length, 0, 'banco não deve receber PATCH quando 403');
  });

  test('TS-BE-10b: PATCH registro de outra filial (no escopo mas filtro diverge) → 404', async () => {
    // userPai (escopo=[1,2,3]) envia empresa_id=2, mas o registro id=7 pertence à empresa 3.
    // resolveEmpresaAlvo resolve para 2 (ok — está no escopo).
    // PostgREST usa filtro id=eq.7&id_empresa=eq.2 → não casa (registro tem id_empresa=3) → retorna [].
    // Handler deve responder 404.
    const calls = [];
    const multiSpy = async (endpoint, method = 'GET', body = null) => {
      calls.push({ endpoint, method, body });
      if (endpoint.startsWith('Empresa?')) return filiaisDoGrupo;
      return []; // filtro não casa → 0 linhas
    };

    const res = await handlerPatchEnvioMassa(
      { user: userPai, params: { id: '7' }, body: { empresa_id: '2', enviado: true } },
      multiSpy
    );

    assert.equal(res._status, 404,
      'deve retornar 404 quando filtro composto não casa (IDOR fechado)');
    assert.ok(
      res._body.error.includes('não encontrado') || res._body.error.includes('pertence'),
      `mensagem deve indicar não encontrado/pertence, obteve: "${res._body.error}"`
    );
  });

  test('TS-BE-10c: PATCH com empresa_id correto → 200 (atualização bem-sucedida)', async () => {
    // Caso feliz: registro id=5 pertence à empresa 2, empresa_id=2 no body
    const calls = [];
    const multiSpy = async (endpoint, method = 'GET', body = null) => {
      calls.push({ endpoint, method, body });
      if (endpoint.startsWith('Empresa?')) return filiaisDoGrupo;
      return [{ id: 5, id_empresa: 2, enviado: true }]; // 1 linha atualizada
    };

    const res = await handlerPatchEnvioMassa(
      { user: userPai, params: { id: '5' }, body: { empresa_id: '2', enviado: true } },
      multiSpy
    );

    assert.equal(res._status, 200, 'deve retornar 200 para update bem-sucedido');
    assert.ok(res._body.data, 'deve retornar dados atualizados');
    // Verificar que o filtro inclui id_empresa
    const patchCall = calls.find(c => c.method === 'PATCH' && c.endpoint.includes('EnvioMassa'));
    assert.ok(patchCall.endpoint.includes('id=eq.5'),
      'filtro deve incluir id=eq.5');
    assert.ok(patchCall.endpoint.includes('id_empresa=eq.2'),
      'filtro deve incluir id_empresa=eq.2 (fecha IDOR)');
  });

  test('TS-BE-10d: PATCH sem empresa_id → usa empresaId do token (sem regressão)', async () => {
    const spy = makePostgrestSpy([{ id: 3, id_empresa: 1 }]);
    const res = await handlerPatchEnvioMassa(
      { user: userPai, params: { id: '3' }, body: { enviado: true } }, // sem empresa_id
      spy
    );

    assert.equal(res._status, 200);
    const patchCall = spy.calls.find(c => c.method === 'PATCH');
    assert.ok(patchCall.endpoint.includes('id_empresa=eq.1'),
      'sem empresa_id → filtro usa empresaId do token (1)');
  });

});
