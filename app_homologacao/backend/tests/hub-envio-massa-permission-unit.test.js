/**
 * Testes unitários — middleware/hub-envio-massa-permission.js (S8, tasks.md
 * FASE 2.2.6/2.2.7). Rodam com: node --test
 * tests/hub-envio-massa-permission-unit.test.js
 *
 * Parte 1 (comportamento, 2.2.6): mock de `global.fetch` (mesmo padrão de
 * tests/hub-envio-massa-claims-unit.test.js / tests/hub-postgrest-unit.test.js)
 * — sem rede real. Casos positivo/negativo derivados 1:1 de
 * docs/specs/hub-envio-massa/contracts/matriz-papel-acao.md (fonte única da
 * verdade, tasks.md 2.2.6):
 *   - sessão legada (`req.hubContext` ausente) -> next() SEMPRE, independente
 *     da flag/permissão (Decision 5, FR-018)
 *   - `HUB_RBAC_ENVIO=off` + sessão hub -> next() SEMPRE (Decision 6, FR-006)
 *   - sessão hub, flag ligada (default): `codigo` presente no Set ->
 *     next(); ausente -> 403 PERMISSAO_INSUFICIENTE (FR-007), usando as
 *     células admin_entidade/operador/leitura da matriz
 *   - exceção na resolução -> 403 PERMISSAO_INSUFICIENTE, fail-closed, NUNCA
 *     next() num catch (mesmo padrão de middleware/hub-require-permission.js
 *     Decision 13)
 *
 * Parte 2 (cobertura de middleware, 2.2.7, achado F3 do gate `owasp-security`,
 * research.md linha ~378): verificação ESTÁTICA (leitura de texto de
 * server.js, "equivalente" a inspecionar `app._router.stack` — research.md
 * usa o termo "ou equivalente") de que as 11 rotas fixas de
 * contracts/legacy-endpoints.md têm `hubEnvioMassaClaimsBridge` +
 * `hubEnvioMassaRequirePermission('<código certo>')` na cadeia, na ordem
 * certa, e que NENHUMA outra rota do arquivo tem esses middlewares por
 * engano. Preferida a `require('../server.js')` + inspeção de
 * `app._router.stack` real porque: (a) server.js chama `app.listen(3000,
 * ...)` incondicionalmente ao ser importado (side effect de rede, sem guard
 * `require.main === module` hoje) e (b) adicionar esse guard + `module.exports
 * = app` tocaria server.js FORA da FASE 3, violando o diff mínimo exigido por
 * FR-015/task 3.2.2 (a inserção dos 2 middlewares nas 11 rotas é a ÚNICA
 * mudança permitida em server.js nesta feature, +  a chamada do log de
 * importação na FASE 4). A verificação por texto cobre exatamente o mesmo
 * risco (drift silencioso de middleware ausente/extra numa rota) sem esse
 * custo.
 *
 * ⚠️ ESTADO ESPERADO NESTA ONDA (FASE 2, task 2.2.7): os testes do bloco
 * "cobertura de middleware" abaixo FALHAM propositalmente até a FASE 3 (task
 * 3.1) inserir de fato os 2 middlewares nas 11 rotas de server.js — a Matriz
 * de Dependências do tasks.md (F2 --> F3) documenta essa ordem. Ver Decisão
 * registrada no state.json da execução (contexto "coverage-test-red-ate-F3").
 * A FASE 3 (task 3.1.13, ao rodar a suíte legada) deve confirmar que este
 * bloco também fica verde.
 *
 * Ref: contracts/legacy-endpoints.md, contracts/matriz-papel-acao.md,
 * research.md Decisions 2/3/5/6/13 + achado F3, tasks.md FASE 2.2.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.PGRST_JWT_SECRET = process.env.PGRST_JWT_SECRET || 'segredo-teste-postgrest';
process.env.POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest-fake:3000';

const { hubEnvioMassaRequirePermission } = require('../middleware/hub-envio-massa-permission');
const { limparCache } = require('../lib/hub-rbac-cache');

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_FLAG = process.env.HUB_RBAC_ENVIO;

function mockResponse(body) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

// Espelha o join UsuarioEntidade->Papel->PapelPermissao->Permissao que
// carregarPermissoesDoBanco(usuarioId, empresaId) faz em 2 chamadas
// PostgREST (lib/hub-rbac-cache.js): 1ª = UsuarioEntidade (papel_id), 2ª =
// PapelPermissao (permissao.codigo).
function mockFetchParaPapel(codigosPermissao) {
  let chamada = 0;
  return async () => {
    chamada += 1;
    if (chamada === 1) return mockResponse([{ papel_id: 1 }]);
    return mockResponse(codigosPermissao.map((c) => ({ permissao: { codigo: c } })));
  };
}

function mockReqRes({ hubContext, user } = {}) {
  const req = { hubContext, user };
  let statusCode = null;
  let jsonBody = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      jsonBody = body;
      return this;
    },
  };
  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };
  return { req, res, next, getStatus: () => statusCode, getJson: () => jsonBody, wasNextCalled: () => nextCalled };
}

describe('hubEnvioMassaRequirePermission — comportamento (2.2.6)', () => {
  beforeEach(() => {
    limparCache();
    delete process.env.HUB_RBAC_ENVIO;
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_FLAG === undefined) delete process.env.HUB_RBAC_ENVIO;
    else process.env.HUB_RBAC_ENVIO = ORIGINAL_FLAG;
    limparCache();
  });

  test('sessão legada (req.hubContext ausente) -> next() SEMPRE, independente de permissão/flag', async () => {
    global.fetch = async () => {
      throw new Error('não deveria consultar permissões para sessão legada');
    };
    const mw = hubEnvioMassaRequirePermission('envio_massa.aprovar');
    const { req, res, next, wasNextCalled } = mockReqRes({ hubContext: undefined, user: { empresaId: 5 } });
    await mw(req, res, next);
    assert.equal(wasNextCalled(), true);
  });

  test('sessão legada com req.hubContext.viaHub=false (defensivo) -> next() SEMPRE', async () => {
    global.fetch = async () => {
      throw new Error('não deveria consultar permissões');
    };
    const mw = hubEnvioMassaRequirePermission('envio_massa.aprovar');
    const { req, res, next, wasNextCalled } = mockReqRes({ hubContext: { viaHub: false }, user: { empresaId: 5 } });
    await mw(req, res, next);
    assert.equal(wasNextCalled(), true);
  });

  test('HUB_RBAC_ENVIO=off + sessão hub -> next() SEMPRE, sem consultar permissões (Decision 6, FR-006)', async () => {
    process.env.HUB_RBAC_ENVIO = 'off';
    global.fetch = async () => {
      throw new Error('não deveria consultar permissões com a flag off');
    };
    const mw = hubEnvioMassaRequirePermission('envio_massa.aprovar');
    const { req, res, next, wasNextCalled } = mockReqRes({
      hubContext: { viaHub: true, usuarioId: 1 },
      user: { empresaId: 7 },
    });
    await mw(req, res, next);
    assert.equal(wasNextCalled(), true);
  });

  test('matriz papel-ação: admin_entidade tem envio_massa.aprovar -> next()', async () => {
    global.fetch = mockFetchParaPapel(['envio_massa.consultar', 'envio_massa.criar', 'envio_massa.enviar', 'envio_massa.aprovar', 'envio_massa.gerenciar']);
    const mw = hubEnvioMassaRequirePermission('envio_massa.aprovar');
    const { req, res, next, wasNextCalled } = mockReqRes({
      hubContext: { viaHub: true, usuarioId: 10 },
      user: { empresaId: 7 },
    });
    await mw(req, res, next);
    assert.equal(wasNextCalled(), true);
  });

  test('matriz papel-ação: operador SEM envio_massa.aprovar -> 403 PERMISSAO_INSUFICIENTE (Cenário 2 US3)', async () => {
    global.fetch = mockFetchParaPapel(['envio_massa.consultar', 'envio_massa.criar', 'envio_massa.enviar']);
    const mw = hubEnvioMassaRequirePermission('envio_massa.aprovar');
    const { req, res, next, getStatus, getJson, wasNextCalled } = mockReqRes({
      hubContext: { viaHub: true, usuarioId: 11 },
      user: { empresaId: 7 },
    });
    await mw(req, res, next);
    assert.equal(wasNextCalled(), false);
    assert.equal(getStatus(), 403);
    assert.equal(getJson().error.code, 'PERMISSAO_INSUFICIENTE');
  });

  test('matriz papel-ação: leitura tem envio_massa.consultar -> next()', async () => {
    global.fetch = mockFetchParaPapel(['envio_massa.consultar']);
    const mw = hubEnvioMassaRequirePermission('envio_massa.consultar');
    const { req, res, next, wasNextCalled } = mockReqRes({
      hubContext: { viaHub: true, usuarioId: 12 },
      user: { empresaId: 7 },
    });
    await mw(req, res, next);
    assert.equal(wasNextCalled(), true);
  });

  test('matriz papel-ação: leitura SEM envio_massa.criar -> 403 PERMISSAO_INSUFICIENTE (Cenário 3 US3)', async () => {
    global.fetch = mockFetchParaPapel(['envio_massa.consultar']);
    const mw = hubEnvioMassaRequirePermission('envio_massa.criar');
    const { req, res, next, getStatus, getJson, wasNextCalled } = mockReqRes({
      hubContext: { viaHub: true, usuarioId: 12 },
      user: { empresaId: 7 },
    });
    await mw(req, res, next);
    assert.equal(wasNextCalled(), false);
    assert.equal(getStatus(), 403);
    assert.equal(getJson().error.code, 'PERMISSAO_INSUFICIENTE');
  });

  test('exceção na resolução de permissões -> 403 PERMISSAO_INSUFICIENTE, fail-closed, NUNCA next()', async () => {
    global.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const mw = hubEnvioMassaRequirePermission('envio_massa.consultar');
    const { req, res, next, getStatus, getJson, wasNextCalled } = mockReqRes({
      hubContext: { viaHub: true, usuarioId: 13 },
      user: { empresaId: 7 },
    });
    await mw(req, res, next);
    assert.equal(wasNextCalled(), false);
    assert.equal(getStatus(), 403);
    assert.equal(getJson().error.code, 'PERMISSAO_INSUFICIENTE');
  });
});

describe('cobertura de middleware nas 11 rotas legadas (2.2.7, achado F3)', () => {
  const SERVER_PATH = path.resolve(__dirname, '..', 'server.js');
  const SERVER_SRC = fs.readFileSync(SERVER_PATH, 'utf8');

  // Fonte única da verdade: contracts/legacy-endpoints.md +
  // contracts/matriz-papel-acao.md (§Ação -> endpoint).
  const ROTAS_ESPERADAS = [
    { method: 'get', pathLiteral: '/envio-massa', permissao: 'envio_massa.consultar' },
    { method: 'patch', pathLiteral: '/update-envio-massa/:id', permissao: 'envio_massa.criar' },
    { method: 'delete', pathLiteral: '/envio-massa/:id', permissao: 'envio_massa.aprovar' },
    { method: 'post', pathLiteral: '/start-process', permissao: 'envio_massa.enviar' },
    { method: 'get', pathLiteral: '/process-status', permissao: 'envio_massa.consultar' },
    { method: 'post', pathLiteral: '/stop-process', permissao: 'envio_massa.enviar' },
    { method: 'post', pathLiteral: '/upload', permissao: 'envio_massa.criar' },
    { method: 'get', pathLiteral: '/export-envio-massa', permissao: 'envio_massa.consultar' },
    { method: 'get', pathLiteral: '/download-xml-movimento', permissao: 'envio_massa.consultar' },
    { method: 'post', pathLiteral: '/validate-xml-batch', permissao: 'envio_massa.enviar' },
    { method: 'post', pathLiteral: '/close-movimento', permissao: 'envio_massa.aprovar' },
  ];

  function acharLinhaDaRota(method, pathLiteral) {
    const re = new RegExp(`app\\.${method}\\(\\s*'${pathLiteral.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'[^\n]*`);
    const m = SERVER_SRC.match(re);
    return m ? m[0] : null;
  }

  for (const rota of ROTAS_ESPERADAS) {
    test(`${rota.method.toUpperCase()} ${rota.pathLiteral} tem claims-bridge + permission('${rota.permissao}') na ordem certa`, () => {
      const linha = acharLinhaDaRota(rota.method, rota.pathLiteral);
      assert.ok(linha, `rota ${rota.method.toUpperCase()} ${rota.pathLiteral} não encontrada em server.js`);
      const idxClaims = linha.indexOf('hubEnvioMassaClaimsBridge');
      const idxPerm = linha.indexOf(`hubEnvioMassaRequirePermission('${rota.permissao}')`);
      assert.notEqual(idxClaims, -1, `hubEnvioMassaClaimsBridge ausente em ${rota.method.toUpperCase()} ${rota.pathLiteral}`);
      assert.notEqual(idxPerm, -1, `hubEnvioMassaRequirePermission('${rota.permissao}') ausente/código errado em ${rota.method.toUpperCase()} ${rota.pathLiteral}`);
      assert.ok(idxClaims < idxPerm, `ordem errada: claims-bridge deve vir ANTES de permission em ${rota.method.toUpperCase()} ${rota.pathLiteral}`);
    });
  }

  test('nenhuma rota FORA da lista fixa de 11 tem os middlewares novos (sem RBAC bypass silencioso via rota esquecida na lista)', () => {
    const pathsEsperados = new Set(ROTAS_ESPERADAS.map((r) => `${r.method}:${r.pathLiteral}`));
    const reTodasRotas = /app\.(get|post|patch|delete|put)\(\s*'([^']+)'[^\n]*/g;
    const pathsComMiddlewareNovo = new Set();
    let m;
    while ((m = reTodasRotas.exec(SERVER_SRC)) !== null) {
      const linha = m[0];
      if (linha.includes('hubEnvioMassaClaimsBridge') || linha.includes('hubEnvioMassaRequirePermission')) {
        pathsComMiddlewareNovo.add(`${m[1]}:${m[2]}`);
      }
    }
    const extras = [...pathsComMiddlewareNovo].filter((p) => !pathsEsperados.has(p));
    assert.deepEqual(extras, [], `rota(s) fora da lista fixa com middleware novo por engano: ${extras.join(', ')}`);
  });

  test('todas as 11 rotas esperadas estão de fato cobertas (nenhuma faltando)', () => {
    const reTodasRotas = /app\.(get|post|patch|delete|put)\(\s*'([^']+)'[^\n]*/g;
    const pathsComMiddlewareNovo = new Set();
    let m;
    while ((m = reTodasRotas.exec(SERVER_SRC)) !== null) {
      const linha = m[0];
      if (linha.includes('hubEnvioMassaClaimsBridge') && linha.includes('hubEnvioMassaRequirePermission')) {
        pathsComMiddlewareNovo.add(`${m[1]}:${m[2]}`);
      }
    }
    const faltando = ROTAS_ESPERADAS
      .map((r) => `${r.method}:${r.pathLiteral}`)
      .filter((p) => !pathsComMiddlewareNovo.has(p));
    assert.deepEqual(faltando, [], `rota(s) da lista fixa SEM os middlewares novos: ${faltando.join(', ')}`);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Separação de cookies hub × legado (2026-08-04). As 11 rotas acima são as
  // ÚNICAS servidas aos dois produtos, e por isso as únicas que podem aceitar o
  // cookie `hub_accessToken` via `authenticateTokenCompartilhado`. Toda outra
  // rota legada usa `authenticateToken`, que só aceita a sessão do painel — é o
  // que impede uma sessão do hub de chegar em `server.js` com
  // `req.user.empresaId === undefined` (origem do `?empresa_id=undefined`).
  // ──────────────────────────────────────────────────────────────────────────
  for (const rota of ROTAS_ESPERADAS) {
    test(`${rota.method.toUpperCase()} ${rota.pathLiteral} usa authenticateTokenCompartilhado (aceita sessão do hub)`, () => {
      const linha = acharLinhaDaRota(rota.method, rota.pathLiteral);
      assert.ok(linha, `rota ${rota.method.toUpperCase()} ${rota.pathLiteral} não encontrada em server.js`);
      assert.match(
        linha,
        /authenticateTokenCompartilhado,/,
        `rota compartilhada ${rota.method.toUpperCase()} ${rota.pathLiteral} precisa de authenticateTokenCompartilhado — com authenticateToken puro a tela de Envio em Massa do hub quebra (401)`,
      );
    });
  }

  test('nenhuma rota FORA das 11 aceita o cookie do hub (authenticateTokenCompartilhado)', () => {
    const pathsEsperados = new Set(ROTAS_ESPERADAS.map((r) => `${r.method}:${r.pathLiteral}`));
    const reTodasRotas = /app\.(get|post|patch|delete|put)\(\s*'([^']+)'[^\n]*/g;
    const extras = [];
    let m;
    while ((m = reTodasRotas.exec(SERVER_SRC)) !== null) {
      if (!m[0].includes('authenticateTokenCompartilhado')) continue;
      const chave = `${m[1]}:${m[2]}`;
      if (!pathsEsperados.has(chave)) extras.push(chave);
    }
    assert.deepEqual(
      extras,
      [],
      `rota(s) legada(s) aceitando sessão do hub sem a claims-bridge: ${extras.join(', ')}`,
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// hub-auditoria-admin FASE 2.1/2.2 (tasks.md 2.1.3/2.2.3/2.2.5) — cobertura
// de auditoria nas 7 escritas do módulo envio_massa que o inventário 2.1
// identificou como GAP (server.js não tinha nenhuma chamada a
// `registrarAuditoria`, só o log dedicado de `HUB_IMPORT_LOG_ENVIO`).
// Mesmo padrão de verificação ESTÁTICA do bloco acima (2.2.7): server.js não
// é `require`-ável em teste (side effect de `app.listen`), então a
// verificação é por texto — confirma que cada handler de escrita chama
// `auditarEnvioMassaSeViaHub(req, { acao: '<ação certa>', ... })` dentro do
// próprio corpo da rota (entre a linha da rota e a da PRÓXIMA rota).
// ────────────────────────────────────────────────────────────────────────────

describe('cobertura de auditoria nas 7 escritas do módulo envio_massa (2.1.3/2.2.3/2.2.5)', () => {
  const SERVER_PATH = path.resolve(__dirname, '..', 'server.js');
  const SERVER_SRC = fs.readFileSync(SERVER_PATH, 'utf8');
  const LINHAS = SERVER_SRC.split('\n');

  // Fonte única: checklist endpoint-a-endpoint da task 2.1 (tasks.md FASE 2.1,
  // seção "Evidência"), 1:1 com as 7 lacunas GAP identificadas.
  const ESCRITAS_ESPERADAS = [
    { method: 'patch', pathLiteral: '/update-envio-massa/:id', acao: 'movimento_editado' },
    { method: 'delete', pathLiteral: '/envio-massa/:id', acao: 'movimento_excluido' },
    { method: 'post', pathLiteral: '/start-process', acao: 'envio_massa_iniciado' },
    { method: 'post', pathLiteral: '/stop-process', acao: 'envio_massa_parado' },
    { method: 'post', pathLiteral: '/upload', acao: 'envio_massa_importado' },
    { method: 'post', pathLiteral: '/validate-xml-batch', acao: 'envio_massa_xml_validado' },
    { method: 'post', pathLiteral: '/close-movimento', acao: 'movimento_fechado' },
  ];

  // Bloco de texto do handler: da linha da rota até a linha da PRÓXIMA
  // definição de rota top-level `app.<verbo>(` (ou fim do arquivo).
  function blocoDoHandler(method, pathLiteral) {
    const reRota = new RegExp(`^app\\.${method}\\(\\s*'${pathLiteral.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`);
    const idxInicio = LINHAS.findIndex((l) => reRota.test(l));
    if (idxInicio === -1) return null;
    const reQualquerRota = /^app\.(get|post|patch|delete|put)\(/;
    let idxFim = LINHAS.length;
    for (let i = idxInicio + 1; i < LINHAS.length; i += 1) {
      if (reQualquerRota.test(LINHAS[i])) { idxFim = i; break; }
    }
    return LINHAS.slice(idxInicio, idxFim).join('\n');
  }

  for (const escrita of ESCRITAS_ESPERADAS) {
    test(`${escrita.method.toUpperCase()} ${escrita.pathLiteral} chama auditarEnvioMassaSeViaHub com acao '${escrita.acao}'`, () => {
      const bloco = blocoDoHandler(escrita.method, escrita.pathLiteral);
      assert.ok(bloco, `handler ${escrita.method.toUpperCase()} ${escrita.pathLiteral} não encontrado em server.js`);
      assert.match(
        bloco,
        /auditarEnvioMassaSeViaHub\(req,/,
        `${escrita.method.toUpperCase()} ${escrita.pathLiteral} não chama auditarEnvioMassaSeViaHub`
      );
      assert.ok(
        bloco.includes(`acao: '${escrita.acao}'`),
        `${escrita.method.toUpperCase()} ${escrita.pathLiteral} não usa a ação '${escrita.acao}' esperada`
      );
    });
  }

  test('auditarEnvioMassaSeViaHub só grava quando req.hubContext.viaHub === true (sessão legada nunca gera evento)', () => {
    const idxHelper = SERVER_SRC.indexOf('async function auditarEnvioMassaSeViaHub');
    assert.notEqual(idxHelper, -1, 'helper auditarEnvioMassaSeViaHub não encontrado em server.js');
    const corpoHelper = SERVER_SRC.slice(idxHelper, idxHelper + 400);
    assert.match(
      corpoHelper,
      /req\.hubContext\s*&&\s*req\.hubContext\.viaHub\s*===\s*true/,
      'guard viaHub ausente — sessão legada poderia gerar evento sem usuario_id hub válido'
    );
  });
});
