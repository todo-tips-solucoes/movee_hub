/**
 * Testes unitários — migrarCnpjMotorista + rota PATCH /update-envio-massa/:id
 * Rodam com: node --test tests/migrar-cnpj-motorista.test.js
 * Sem dependências externas (usa node:test + node:assert nativos do Node 18+).
 *
 * Cobre C1..C8 do quickstart.md + SEC-04 (TOCTOU UNIQUE→409).
 *
 * Estratégia: copias locais das funções puras + mock de postgrestRequest
 * para testar migrarCnpjMotorista e a lógica da rota de forma isolada.
 *
 * Ref: tasks 2.2.1..2.2.7, 3.2.1..3.2.8
 */

'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ──────────────────────────────────────────────────────────────────────────────
// Cópias locais de helpers puros (espelho de server.js)
// ──────────────────────────────────────────────────────────────────────────────

const onlyDigits = (v) => String(v ?? '').replace(/\D/g, '');
const isCNPJ14 = (digits) => /^\d{14}$/.test(digits);

// ──────────────────────────────────────────────────────────────────────────────
// Implementação testável de migrarCnpjMotorista com postgrestRequest injetável
// (espelho fiel de server.js — mesma lógica, postgrestRequest como parâmetro)
// ──────────────────────────────────────────────────────────────────────────────

async function migrarCnpjMotoristaTstable(cnpjAntigo, cnpjNovo, idEmpresa, cache, postgrestRequest) {
  try {
    // [E1] PRÉ-CHECK 409: cnpjNovo já tem motorista cadastrado?
    const existeNovo = await postgrestRequest(
      `Motorista?cnpj_prestador=eq.${encodeURIComponent(cnpjNovo)}&select=cnpj_prestador`
    );
    if (Array.isArray(existeNovo) && existeNovo.length > 0) {
      return { conflict: true };
    }

    // Buscar motorista com o CNPJ antigo
    const existeAntigo = await postgrestRequest(
      `Motorista?cnpj_prestador=eq.${encodeURIComponent(cnpjAntigo)}&select=cnpj_prestador,nome,ativo`
    );

    if (Array.isArray(existeAntigo) && existeAntigo.length > 0) {
      // Motorista antigo existe → PATCH preservando nome/ativo (nunca toca senha)
      await postgrestRequest(
        `Motorista?cnpj_prestador=eq.${encodeURIComponent(cnpjAntigo)}`,
        'PATCH',
        { cnpj_prestador: cnpjNovo }
      );
    } else {
      // Motorista antigo ausente → pré-cadastro sem senha
      try {
        await postgrestRequest(
          'Motorista',
          'POST',
          { cnpj_prestador: cnpjNovo, nome: '', ativo: true }
        );
      } catch (postErr) {
        // SEC-04: violação UNIQUE (code 23505) no POST → conflict, não 500
        if (
          postErr && (
            (postErr.code === '23505') ||
            (postErr.message && postErr.message.includes('23505')) ||
            (postErr.message && postErr.message.toLowerCase().includes('unique'))
          )
        ) {
          return { conflict: true };
        }
        throw postErr;
      }
    }

    return { ok: true };
  } catch (err) {
    // SEC-05: nunca logar objeto Motorista completo (contém hash de senha)
    // (em teste, apenas retornamos o erro sem console.error)
    return { error: err };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Lógica testável da rota PATCH (validações [A]..[H] sem Express)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Simula a lógica da rota PATCH /update-envio-massa/:id.
 * Retorna { status, body } em vez de res.status().json().
 */
async function patchRouteLogic({
  id,
  body,
  user,
  resolveEmpresaAlvo,
  mesmoGrupoQue,
  postgrestRequest,
  migrarCnpjMotorista,
  updateEnvioMassa,
}) {
  const { enviado, mensagem, tipo } = body;

  // [A] Resolver empresa-alvo
  let idEmp;
  try {
    idEmp = await resolveEmpresaAlvo(user, body.empresa_id);
  } catch (err) {
    return { status: err.status || 403, body: { error: err.message || 'empresa fora do escopo' } };
  }

  const cnpjRaw = body.cnpj_prestador;
  const hasCnpjChange = cnpjRaw !== undefined && cnpjRaw !== null && cnpjRaw !== '';

  try {
    if (hasCnpjChange) {
      // [B] Validar cnpjNovo
      const cnpjNovo = onlyDigits(cnpjRaw);
      if (!isCNPJ14(cnpjNovo)) {
        return { status: 400, body: { error: 'CNPJ inválido — deve conter 14 dígitos.' } };
      }

      // [C] Buscar movimento atual
      const movimentos = await postgrestRequest(
        `EnvioMassa?id=eq.${id}&id_empresa=eq.${idEmp}&select=cnpj_prestador`
      );
      if (!Array.isArray(movimentos) || movimentos.length === 0) {
        return { status: 404, body: { error: 'Movimento não encontrado.' } };
      }
      const cnpjAntigo = onlyDigits(movimentos[0].cnpj_prestador);

      // [D] Idempotência
      if (cnpjNovo !== cnpjAntigo) {
        // [E] Gate de grupo
        const _cache = {};
        const isMoveeGroup = await mesmoGrupoQue(idEmp, 6, _cache);

        if (isMoveeGroup) {
          // [F] Patch em lote + [F-Motorista]
          const patchLote = await postgrestRequest(
            `EnvioMassa?id_empresa=eq.${idEmp}&cnpj_prestador=eq.${encodeURIComponent(cnpjAntigo)}`,
            'PATCH',
            { cnpj_prestador: cnpjNovo }
          );
          if (patchLote && patchLote.error) {
            return { status: 500, body: { error: 'Erro ao atualizar movimentos em lote.' } };
          }
          const migResult = await migrarCnpjMotorista(cnpjAntigo, cnpjNovo, idEmp, _cache);
          if (migResult.conflict) {
            return { status: 409, body: { error: 'CNPJ já cadastrado para outro motorista.' } };
          }
          if (migResult.error) {
            return { status: 500, body: { error: 'Movimentos atualizados, mas falha ao migrar base do motorista.' } };
          }
        } else {
          const patchLote = await postgrestRequest(
            `EnvioMassa?id_empresa=eq.${idEmp}&cnpj_prestador=eq.${encodeURIComponent(cnpjAntigo)}`,
            'PATCH',
            { cnpj_prestador: cnpjNovo }
          );
          if (patchLote && patchLote.error) {
            return { status: 500, body: { error: 'Erro ao atualizar movimentos em lote.' } };
          }
        }
      }
    }

    // [G] Patch demais campos
    const result = await updateEnvioMassa(id, enviado, mensagem, tipo, idEmp);
    if (Array.isArray(result) && result.length === 0) {
      return { status: 404, body: { error: 'Registro não encontrado ou não pertence à empresa.' } };
    }

    // [H] 200
    return { status: 200, body: { message: 'Registro atualizado com sucesso!', data: result } };
  } catch (error) {
    return { status: 500, body: { error: error.message } };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures reutilizáveis
// ──────────────────────────────────────────────────────────────────────────────

const CNPJ_ANTIGO = '11222333000181';
const CNPJ_NOVO   = '44555666000195';
const CNPJ_INVALIDO = '123';
const ID_EMP = 6; // grupo Movee

const userMovee = { empresaId: ID_EMP, id: 1 };

function resolveEmpresaAlvoOK(user, requestedId) {
  return Promise.resolve(requestedId != null ? Number(requestedId) : user.empresaId);
}

function resolveEmpresaAlvoFora() {
  const err = new Error('empresa fora do escopo');
  err.status = 403;
  return Promise.reject(err);
}

function mesmoGrupoQueTrue() { return Promise.resolve(true); }
function mesmoGrupoQueFalse() { return Promise.resolve(false); }

function updateEnvioMassaOK(id, enviado, mensagem, tipo, idEmp) {
  return Promise.resolve([{ id, id_empresa: idEmp, enviado }]);
}

// ──────────────────────────────────────────────────────────────────────────────
// Testes de migrarCnpjMotorista (C1..C4, C7, SEC-04)
// ──────────────────────────────────────────────────────────────────────────────

describe('migrarCnpjMotorista', () => {

  // C1 — Happy path: antigo existe, novo livre → PATCH Motorista
  test('C1: antigo existe, novo livre → { ok: true }', async () => {
    const calls = [];
    const mock = async (endpoint, method = 'GET', body = null) => {
      calls.push({ endpoint, method, body });
      if (method === 'GET' && endpoint.includes('cnpj_prestador=eq.' + CNPJ_NOVO)) {
        return []; // novo não existe → sem conflito
      }
      if (method === 'GET' && endpoint.includes('cnpj_prestador=eq.' + CNPJ_ANTIGO)) {
        return [{ cnpj_prestador: CNPJ_ANTIGO, nome: 'Fulano', ativo: true }];
      }
      if (method === 'PATCH') {
        return []; // PATCH OK
      }
      return [];
    };

    const result = await migrarCnpjMotoristaTstable(CNPJ_ANTIGO, CNPJ_NOVO, ID_EMP, {}, mock);
    assert.deepEqual(result, { ok: true });

    // Deve ter feito pré-check (GET novo), busca antigo (GET antigo) e PATCH
    const patchCall = calls.find(c => c.method === 'PATCH');
    assert.ok(patchCall, 'deve chamar PATCH em Motorista');
    assert.deepEqual(patchCall.body, { cnpj_prestador: CNPJ_NOVO });
    // ZERO chamadas POST (antigo existia — sem pré-cadastro)
    const postCall = calls.find(c => c.method === 'POST');
    assert.equal(postCall, undefined, 'não deve chamar POST quando antigo existe');
  });

  // C2 — fora do grupo: função não é chamada; testamos que retorno seria { ok:true }
  // (o gate pertence à rota; aqui testamos que a função em si não re-verifica grupo)
  test('C2: chamada sem gate de grupo (responsabilidade da rota) → não acessa Motorista para fora do grupo', async () => {
    // Simulamos a rota decidindo NÃO chamar migrarCnpjMotorista para empresa fora do grupo
    let migrarFoiChamada = false;
    const mockMigrar = async () => {
      migrarFoiChamada = true;
      return { ok: true };
    };

    const postgrestMock = async (endpoint, method = 'GET', body = null) => {
      if (method === 'GET' && endpoint.startsWith('EnvioMassa')) {
        return [{ cnpj_prestador: CNPJ_ANTIGO }];
      }
      return [];
    };

    const result = await patchRouteLogic({
      id: 1,
      body: { empresa_id: 99, cnpj_prestador: CNPJ_NOVO },
      user: { empresaId: 99, id: 2 },
      resolveEmpresaAlvo: resolveEmpresaAlvoOK,
      mesmoGrupoQue: mesmoGrupoQueFalse, // empresa fora do grupo
      postgrestRequest: postgrestMock,
      migrarCnpjMotorista: mockMigrar,
      updateEnvioMassa: updateEnvioMassaOK,
    });

    assert.equal(migrarFoiChamada, false, 'migrarCnpjMotorista NÃO deve ser chamada para empresa fora do grupo (SEC-03, FR-013)');
    assert.equal(result.status, 200);
  });

  // C3 — Conflito 409: novo CNPJ já tem motorista cadastrado
  test('C3: pré-check retorna motorista para cnpjNovo → { conflict: true }', async () => {
    const calls = [];
    const mock = async (endpoint, method = 'GET') => {
      calls.push({ endpoint, method });
      if (method === 'GET' && endpoint.includes('cnpj_prestador=eq.' + CNPJ_NOVO)) {
        return [{ cnpj_prestador: CNPJ_NOVO }]; // conflito
      }
      return [];
    };

    const result = await migrarCnpjMotoristaTstable(CNPJ_ANTIGO, CNPJ_NOVO, ID_EMP, {}, mock);
    assert.deepEqual(result, { conflict: true });

    // Nada deve ter sido escrito (sem PATCH/POST)
    const writes = calls.filter(c => c.method !== 'GET');
    assert.equal(writes.length, 0, 'nenhuma escrita quando pré-check detecta conflito');
  });

  // C4 — Antigo inexistente → pré-cadastro
  test('C4: antigo ausente → POST pré-cadastro sem senha', async () => {
    const calls = [];
    const mock = async (endpoint, method = 'GET', body = null) => {
      calls.push({ endpoint, method, body });
      if (method === 'GET' && endpoint.includes('cnpj_prestador=eq.' + CNPJ_NOVO)) {
        return []; // novo não existe
      }
      if (method === 'GET' && endpoint.includes('cnpj_prestador=eq.' + CNPJ_ANTIGO)) {
        return []; // antigo não existe
      }
      if (method === 'POST') {
        return [{ cnpj_prestador: CNPJ_NOVO, nome: '', ativo: true }];
      }
      return [];
    };

    const result = await migrarCnpjMotoristaTstable(CNPJ_ANTIGO, CNPJ_NOVO, ID_EMP, {}, mock);
    assert.deepEqual(result, { ok: true });

    const postCall = calls.find(c => c.method === 'POST');
    assert.ok(postCall, 'deve chamar POST para pré-cadastro');
    assert.equal(postCall.endpoint, 'Motorista');
    assert.deepEqual(postCall.body, { cnpj_prestador: CNPJ_NOVO, nome: '', ativo: true });
    // sem PATCH (antigo não existia)
    const patchCall = calls.find(c => c.method === 'PATCH');
    assert.equal(patchCall, undefined, 'não deve PATCH quando antigo ausente');
  });

  // C7 — Falha parcial: PATCH Motorista lança erro → { error }
  test('C7: PATCH Motorista lança erro → { error } sem revelar senha', async () => {
    const mock = async (endpoint, method = 'GET', body = null) => {
      if (method === 'GET' && endpoint.includes('cnpj_prestador=eq.' + CNPJ_NOVO)) {
        return [];
      }
      if (method === 'GET' && endpoint.includes('cnpj_prestador=eq.' + CNPJ_ANTIGO)) {
        return [{ cnpj_prestador: CNPJ_ANTIGO, nome: 'Fulano', ativo: true }];
      }
      if (method === 'PATCH') {
        throw new Error('PostgREST indisponível');
      }
      return [];
    };

    const result = await migrarCnpjMotoristaTstable(CNPJ_ANTIGO, CNPJ_NOVO, ID_EMP, {}, mock);
    assert.ok(result.error, 'deve retornar { error } em caso de falha');
    assert.ok(result.error instanceof Error);
    // SEC-05: o objeto error não deve conter senha
    const errStr = JSON.stringify(result.error.message || '');
    assert.ok(!errStr.includes('senha'), 'erro não deve expor campo senha');
  });

  // SEC-04 — TOCTOU: POST retorna violação UNIQUE → { conflict: true }
  test('SEC-04: POST Motorista viola UNIQUE (23505) → { conflict: true }', async () => {
    const mock = async (endpoint, method = 'GET', body = null) => {
      if (method === 'GET' && endpoint.includes('cnpj_prestador=eq.' + CNPJ_NOVO)) {
        return []; // pré-check passa (janela TOCTOU)
      }
      if (method === 'GET' && endpoint.includes('cnpj_prestador=eq.' + CNPJ_ANTIGO)) {
        return []; // antigo ausente
      }
      if (method === 'POST') {
        const err = new Error('duplicate key value violates unique constraint');
        err.code = '23505';
        throw err;
      }
      return [];
    };

    const result = await migrarCnpjMotoristaTstable(CNPJ_ANTIGO, CNPJ_NOVO, ID_EMP, {}, mock);
    assert.deepEqual(result, { conflict: true }, 'UNIQUE violation deve retornar { conflict: true }, não { error }');
  });

  // SEC-04 — variante: mensagem "unique" sem code (alguns drivers)
  test('SEC-04 variante: POST com mensagem "unique" → { conflict: true }', async () => {
    const mock = async (endpoint, method = 'GET', body = null) => {
      if (method === 'GET') return [];
      if (method === 'POST') {
        const err = new Error('violates unique constraint on cnpj_prestador');
        throw err;
      }
      return [];
    };

    const result = await migrarCnpjMotoristaTstable(CNPJ_ANTIGO, CNPJ_NOVO, ID_EMP, {}, mock);
    assert.deepEqual(result, { conflict: true });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Testes da lógica da rota PATCH (C1, C2, C3, C5, C6, C8)
// ──────────────────────────────────────────────────────────────────────────────

describe('patchRouteLogic (rota PATCH /update-envio-massa/:id)', () => {

  // C1 — Happy path via rota (grupo Movee, motorista existe)
  test('C1 via rota: grupo Movee, migração OK → 200', async () => {
    const postgrestMock = async (endpoint, method = 'GET', body = null) => {
      if (method === 'GET' && endpoint.startsWith('EnvioMassa')) {
        return [{ cnpj_prestador: CNPJ_ANTIGO }];
      }
      if (method === 'PATCH' && endpoint.startsWith('EnvioMassa')) {
        return [];
      }
      return [];
    };

    const migrarMock = async () => ({ ok: true });

    const result = await patchRouteLogic({
      id: 1,
      body: { empresa_id: ID_EMP, cnpj_prestador: CNPJ_NOVO },
      user: userMovee,
      resolveEmpresaAlvo: resolveEmpresaAlvoOK,
      mesmoGrupoQue: mesmoGrupoQueTrue,
      postgrestRequest: postgrestMock,
      migrarCnpjMotorista: migrarMock,
      updateEnvioMassa: updateEnvioMassaOK,
    });

    assert.equal(result.status, 200);
    assert.ok(result.body.message.includes('sucesso'));
  });

  // C5 — Idempotência: CNPJ não muda → NO-OP de CNPJ, 200
  test('C5: cnpjNovo === cnpjAntigo (idempotência) → NO-OP de CNPJ, 200', async () => {
    let migrarFoiChamada = false;
    const postgrestMock = async (endpoint, method = 'GET') => {
      if (method === 'GET' && endpoint.startsWith('EnvioMassa')) {
        return [{ cnpj_prestador: CNPJ_ANTIGO }]; // mesmo CNPJ
      }
      return [];
    };
    const migrarMock = async () => { migrarFoiChamada = true; return { ok: true }; };
    let patchLoteFoiChamado = false;
    const postgrestMockComLote = async (endpoint, method = 'GET', body = null) => {
      if (method === 'GET') return [{ cnpj_prestador: CNPJ_ANTIGO }];
      if (method === 'PATCH' && endpoint.startsWith('EnvioMassa?id_empresa')) {
        patchLoteFoiChamado = true;
        return [];
      }
      return [];
    };

    const result = await patchRouteLogic({
      id: 1,
      body: { empresa_id: ID_EMP, cnpj_prestador: CNPJ_ANTIGO }, // mesmo CNPJ
      user: userMovee,
      resolveEmpresaAlvo: resolveEmpresaAlvoOK,
      mesmoGrupoQue: mesmoGrupoQueTrue,
      postgrestRequest: postgrestMockComLote,
      migrarCnpjMotorista: migrarMock,
      updateEnvioMassa: updateEnvioMassaOK,
    });

    assert.equal(result.status, 200);
    assert.equal(migrarFoiChamada, false, 'migrarCnpjMotorista NÃO deve ser chamada quando CNPJ não muda');
    assert.equal(patchLoteFoiChamado, false, 'PATCH em lote NÃO deve ocorrer quando CNPJ não muda');
  });

  // C6 — CNPJ inválido → 400
  test('C6: cnpj_prestador inválido → 400', async () => {
    const result = await patchRouteLogic({
      id: 1,
      body: { empresa_id: ID_EMP, cnpj_prestador: CNPJ_INVALIDO },
      user: userMovee,
      resolveEmpresaAlvo: resolveEmpresaAlvoOK,
      mesmoGrupoQue: mesmoGrupoQueTrue,
      postgrestRequest: async () => [],
      migrarCnpjMotorista: async () => ({ ok: true }),
      updateEnvioMassa: updateEnvioMassaOK,
    });

    assert.equal(result.status, 400);
    assert.ok(result.body.error.includes('inválido'));
  });

  // C8 — IDOR: empresa fora do escopo → 403
  test('C8: empresa fora do escopo → 403', async () => {
    const result = await patchRouteLogic({
      id: 1,
      body: { empresa_id: 999, cnpj_prestador: CNPJ_NOVO },
      user: userMovee,
      resolveEmpresaAlvo: resolveEmpresaAlvoFora,
      mesmoGrupoQue: mesmoGrupoQueTrue,
      postgrestRequest: async () => [],
      migrarCnpjMotorista: async () => ({ ok: true }),
      updateEnvioMassa: updateEnvioMassaOK,
    });

    assert.equal(result.status, 403);
  });

  // C3 via rota — conflito 409 propagado pelo migrarCnpjMotorista
  test('C3 via rota: migrarCnpjMotorista retorna conflict → 409', async () => {
    const postgrestMock = async (endpoint, method = 'GET') => {
      if (method === 'GET' && endpoint.startsWith('EnvioMassa')) {
        return [{ cnpj_prestador: CNPJ_ANTIGO }];
      }
      return [];
    };

    const result = await patchRouteLogic({
      id: 1,
      body: { empresa_id: ID_EMP, cnpj_prestador: CNPJ_NOVO },
      user: userMovee,
      resolveEmpresaAlvo: resolveEmpresaAlvoOK,
      mesmoGrupoQue: mesmoGrupoQueTrue,
      postgrestRequest: postgrestMock,
      migrarCnpjMotorista: async () => ({ conflict: true }),
      updateEnvioMassa: updateEnvioMassaOK,
    });

    assert.equal(result.status, 409);
    assert.ok(result.body.error.toLowerCase().includes('cnpj'));
  });

  // Sem cnpj_prestador no body → apenas [G] (não-regressão)
  test('sem cnpj_prestador: apenas atualiza enviado/mensagem/tipo (não-regressão)', async () => {
    let migrarFoiChamada = false;
    const result = await patchRouteLogic({
      id: 1,
      body: { empresa_id: ID_EMP, enviado: true, mensagem: 'OK', tipo: 'men1' },
      user: userMovee,
      resolveEmpresaAlvo: resolveEmpresaAlvoOK,
      mesmoGrupoQue: mesmoGrupoQueTrue,
      postgrestRequest: async () => [],
      migrarCnpjMotorista: async () => { migrarFoiChamada = true; return { ok: true }; },
      updateEnvioMassa: updateEnvioMassaOK,
    });

    assert.equal(result.status, 200);
    assert.equal(migrarFoiChamada, false, 'sem cnpj_prestador: migrarCnpjMotorista NÃO deve ser chamada');
  });

  // helpers onlyDigits + isCNPJ14
  test('onlyDigits: remove pontos, barras e traços do CNPJ formatado', () => {
    assert.equal(onlyDigits('11.222.333/0001-81'), '11222333000181');
    assert.equal(onlyDigits(''), '');
    assert.equal(onlyDigits(null), '');
  });

  test('isCNPJ14: valida exatamente 14 dígitos', () => {
    assert.equal(isCNPJ14('11222333000181'), true);
    assert.equal(isCNPJ14('1122233300018'), false, '13 dígitos → false');
    assert.equal(isCNPJ14('112223330001810'), false, '15 dígitos → false');
    assert.equal(isCNPJ14(''), false);
    assert.equal(isCNPJ14('abcdefghijklmn'), false);
  });
});
