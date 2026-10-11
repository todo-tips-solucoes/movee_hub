'use strict';

// Rotas de hub-usuarios com o PostgREST e o RBAC substituídos por fakes em
// memória (require.cache) — sem Docker. Trava dois contratos:
//  - GET /usuarios expõe `nuncaAcessou` (derivado de `ultimo_login_em`) SEPARADO
//    de `linkSenhaPendente`: são fatos diferentes e podem coexistir;
//  - POST /usuarios/:id/convite mantém status/corpos/auditoria depois da
//    extração do miolo para `reenviarConviteDe`.

const { test, describe, beforeEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'segredo-teste-usuarios';
process.env.PGRST_JWT_SECRET = process.env.PGRST_JWT_SECRET || 'segredo-teste-postgrest';
process.env.POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest-fake:3000';

const lib = (n) => path.resolve(__dirname, '..', 'lib', n);
function fake(modulo, exports_) {
  require.cache[require.resolve(modulo)] = { id: modulo, filename: modulo, loaded: true, exports: exports_ };
}

const estado = {};
const chamadas = { postgrest: [], auditoria: [] };
fake(lib('hub-postgrest.js'), {
  hubPostgrestRequest: async (endpoint, method = 'GET', body = null) => {
    chamadas.postgrest.push({ endpoint, method, body });
    return estado.postgrest(endpoint, method, body);
  },
});
fake(lib('hub-rbac-cache.js'), {
  obterPermissoesEfetivasPorEntidade: async () => new Set(['usuarios.gerenciar']),
  obterPermissoesEfetivas: async () => new Set(['usuarios.gerenciar']),
  obterModulosAtivosPorEntidade: async () => new Set(['usuarios']),
  usuarioEhAdminPlataforma: async () => estado.admin === true,
  alvoTemPapelRestritoAtivo: async (id) => estado.restrito === true || !!(estado.restritos && estado.restritos.has(id)),
  invalidarUsuario: () => {},
});
fake(lib('hub-auditoria.js'), {
  registrarAuditoria: async (a) => { chamadas.auditoria.push(a); },
});
fake(lib('hub-entidade-nome.js'), { buscarNomesEntidades: async () => new Map([[6, 'Movee']]) });
const realConvite = require('../lib/hub-convite-senha');
fake(lib('hub-convite-senha.js'), {
  ...realConvite,
  enviarLinkSenha: async () => estado.envio,
});

const { router } = require('../routes/hub-usuarios');

const app = express();
app.use(cookieParser());
app.use(express.json());
app.use('/usuarios', router);
let server; let base;
// Um `sub` por chamada: o limitador do lote é por usuário, e os testes não
// podem consumir a cota uns dos outros.
let proximoSub = 100;
const cookieDe = (sub) => `hub_accessToken=${jwt.sign({ sub, entidade_ativa: 6 }, process.env.JWT_SECRET, { algorithm: 'HS256' })}`;
const cookie = cookieDe(1);

before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

async function chamar(metodo, url, corpo, sub) {
  const r = await fetch(base + url, {
    method: metodo,
    headers: { cookie: sub ? cookieDe(sub) : cookie, 'content-type': 'application/json' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  return { status: r.status, corpo: await r.json() };
}

beforeEach(() => {
  chamadas.postgrest.length = 0;
  chamadas.auditoria.length = 0;
  estado.admin = false;
  estado.restrito = false;
  estado.restritos = new Set();
  estado.envio = { ok: true };
});

describe('GET /usuarios — nuncaAcessou', () => {
  const futuro = new Date(Date.now() + 3600e3).toISOString();
  const vinculo = (id, extra) => ({
    id, ativo: true, papel: { id: 3, nome: 'financeiro' },
    usuario: { id, nome: `U${id}`, email: `u${id}@x.com`, ativo: true, token_recuperacao_expira: null, ultimo_login_em: null, ...extra },
  });

  test('deriva de ultimo_login_em e é independente de linkSenhaPendente', async () => {
    estado.postgrest = async () => [
      vinculo(1, {}),                                                        // nunca acessou, sem link
      vinculo(2, { token_recuperacao_expira: futuro }),                      // nunca acessou + link
      vinculo(3, { ultimo_login_em: '2026-10-01T10:00:00Z' }),               // já acessou, sem link
      vinculo(4, { ultimo_login_em: '2026-10-01T10:00:00Z', token_recuperacao_expira: futuro }), // já acessou + link (esqueci a senha)
    ];
    const { status, corpo } = await chamar('GET', '/usuarios');
    assert.equal(status, 200);
    const por = Object.fromEntries(corpo.usuarios.map((u) => [u.id, [u.nuncaAcessou, u.linkSenhaPendente]]));
    assert.deepEqual(por, { 1: [true, false], 2: [true, true], 3: [false, false], 4: [false, true] });
  });

  test('pede ultimo_login_em ao PostgREST', async () => {
    estado.postgrest = async () => [];
    await chamar('GET', '/usuarios');
    assert.match(chamadas.postgrest[0].endpoint, /ultimo_login_em/);
  });
});

describe('POST /usuarios/:id/convite — contrato externo preservado', () => {
  const rotas = (extra = {}) => async (endpoint, method) => {
    if (endpoint.startsWith('UsuarioEntidade')) return extra.vinculos ?? [{ id: 1 }];
    if (endpoint.startsWith('Usuario?id=eq.7&select')) return extra.alvos ?? [{ id: 7, nome: 'Ana', email: 'a@x.com', ativo: true }];
    if (method === 'PATCH') return [];
    return [];
  };

  test('sucesso: 200, PATCH do token e auditoria convite_reenviado', async () => {
    estado.postgrest = rotas();
    const r = await chamar('POST', '/usuarios/7/convite');
    assert.deepEqual([r.status, r.corpo], [200, { ok: true, conviteEnviado: true }]);
    const patch = chamadas.postgrest.find((c) => c.method === 'PATCH');
    assert.ok(patch.body.token_recuperacao_hash && patch.body.token_recuperacao_expira);
    assert.equal(chamadas.auditoria[0].acao, 'convite_reenviado');
    assert.deepEqual(chamadas.auditoria[0].detalhes, { conviteEnviado: true });
  });

  test('e-mail não entregue: 502 EMAIL_NAO_ENVIADO, token já gravado e auditoria com conviteEnviado=false', async () => {
    estado.postgrest = rotas();
    estado.envio = { ok: false, erro: 'x' };
    const r = await chamar('POST', '/usuarios/7/convite');
    assert.deepEqual([r.status, r.corpo], [502, { erro: 'EMAIL_NAO_ENVIADO' }]);
    assert.ok(chamadas.postgrest.some((c) => c.method === 'PATCH'));
    assert.deepEqual(chamadas.auditoria[0].detalhes, { conviteEnviado: false });
  });

  test('inativo: 409 USUARIO_INATIVO, sem PATCH nem e-mail', async () => {
    estado.postgrest = rotas({ alvos: [{ id: 7, nome: 'Ana', email: 'a@x.com', ativo: false }] });
    const r = await chamar('POST', '/usuarios/7/convite');
    assert.deepEqual([r.status, r.corpo], [409, { erro: 'USUARIO_INATIVO' }]);
    assert.equal(chamadas.postgrest.some((c) => c.method === 'PATCH'), false);
  });

  test('fora do escopo: 404', async () => {
    estado.postgrest = rotas({ vinculos: [] });
    const r = await chamar('POST', '/usuarios/7/convite');
    assert.deepEqual([r.status, r.corpo.erro], [404, 'USUARIO_NAO_ENCONTRADO']);
  });

  test('papel restrito sem ser admin plataforma: 403 e auditoria de tentativa', async () => {
    estado.postgrest = rotas();
    estado.restrito = true;
    const r = await chamar('POST', '/usuarios/7/convite');
    assert.deepEqual([r.status, r.corpo.erro], [403, 'PAPEL_RESTRITO']);
    assert.equal(chamadas.auditoria[0].acao, 'usuario_vinculo_negado');
    assert.equal(chamadas.postgrest.some((c) => c.method === 'PATCH'), false);
  });

  test('id não inteiro: 400 DADOS_INVALIDOS', async () => {
    const r = await chamar('POST', '/usuarios/abc/convite');
    assert.deepEqual([r.status, r.corpo.erro], [400, 'DADOS_INVALIDOS']);
  });
});

describe('POST /usuarios/convites — lote', () => {
  // Fake de PostgREST por faixa de ids: tudo no escopo, ativo, salvo o configurado.
  const montar = ({ inativos = [], foraEscopo = [] } = {}) => async (endpoint, method) => {
    const ids = (endpoint.match(/in\.\(([\d,]+)\)/) || [])[1];
    const lista = ids ? ids.split(',').map(Number) : [];
    if (endpoint.startsWith('UsuarioEntidade?usuario_id=in')) {
      return lista.filter((i) => !foraEscopo.includes(i)).map((usuario_id) => ({ usuario_id }));
    }
    if (endpoint.startsWith('Usuario?id=in')) {
      return lista.map((id) => ({ id, nome: `U${id}`, email: `u${id}@x.com`, ativo: !inativos.includes(id) }));
    }
    if (method === 'PATCH') return [];
    return [];
  };
  const post = (corpo) => chamar('POST', '/usuarios/convites', corpo, proximoSub++);
  const patches = () => chamadas.postgrest.filter((c) => c.method === 'PATCH');

  test('teto: mais de 50 ids -> 400 LOTE_GRANDE com o limite', async () => {
    estado.postgrest = montar();
    const r = await post({ usuarioIds: Array.from({ length: 51 }, (_, i) => i + 1) });
    assert.deepEqual([r.status, r.corpo], [400, { erro: 'LOTE_GRANDE', limite: 50 }]);
    assert.equal(chamadas.postgrest.length, 0);
  });

  test('exatamente 50 ids passa', async () => {
    estado.postgrest = montar();
    const r = await post({ usuarioIds: Array.from({ length: 50 }, (_, i) => i + 1) });
    assert.equal(r.status, 200);
    assert.equal(r.corpo.enviados, 50);
  });

  test('body inválido -> 400 DADOS_INVALIDOS', async () => {
    estado.postgrest = montar();
    for (const corpo of [
      {},                                                  // sem usuarioIds
      { usuarioIds: [] },                                  // vazio
      { usuarioIds: [1, 'x'] },                            // elemento não inteiro
      { usuarioIds: [1.5] },
    ]) {
      const r = await post(corpo);
      assert.deepEqual([r.status, r.corpo.erro], [400, 'DADOS_INVALIDOS'], JSON.stringify(corpo));
    }
    assert.equal(patches().length, 0);
  });

  test('relatório misto: enviado, inativo, fora do escopo e e-mail que falhou', async () => {
    estado.postgrest = montar({ inativos: [2], foraEscopo: [3] });
    let n = 0;
    // 1º envio ok, 2º falha (ids 1 e 4 chegam ao envio)
    Object.defineProperty(estado, 'envio', { configurable: true, get: () => (n++ === 0 ? { ok: true } : { ok: false, erro: 'x' }) });
    const r = await post({ usuarioIds: [1, 2, 3, 4] });
    Object.defineProperty(estado, 'envio', { configurable: true, writable: true, value: { ok: true } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.corpo.resultado, [
      { usuarioId: 1, status: 'enviado' },
      { usuarioId: 2, status: 'pulado', motivo: 'USUARIO_INATIVO' },
      { usuarioId: 3, status: 'pulado', motivo: 'USUARIO_NAO_ENCONTRADO' },
      { usuarioId: 4, status: 'pulado', motivo: 'EMAIL_NAO_ENVIADO' },
    ]);
    assert.deepEqual([r.corpo.enviados, r.corpo.pulados], [1, 3]);
    // só os alvos que chegaram ao envio ganharam token novo
    assert.equal(patches().length, 2);
  });

  test('papel restrito: pulado, SEM token novo, e auditoria de tentativa registrada', async () => {
    estado.postgrest = montar();
    estado.restritos = new Set([5]);
    const r = await post({ usuarioIds: [4, 5] });
    assert.deepEqual(r.corpo.resultado, [
      { usuarioId: 4, status: 'enviado' },
      { usuarioId: 5, status: 'pulado', motivo: 'PAPEL_RESTRITO' },
    ]);
    assert.equal(patches().length, 1);
    const negada = chamadas.auditoria.filter((a) => a.acao === 'usuario_vinculo_negado');
    assert.equal(negada.length, 1);
    assert.equal(negada[0].detalhes.usuarioAlvoId, 5);
    assert.equal(negada[0].detalhes.rota, 'POST /usuarios/convites');
  });

  test('admin plataforma não é barrado pela trava', async () => {
    estado.postgrest = montar();
    estado.admin = true;
    estado.restritos = new Set([5]);
    const r = await post({ usuarioIds: [5] });
    assert.equal(r.corpo.enviados, 1);
  });

  test('todosPendentes foi recusado de propósito: 400 DADOS_INVALIDOS e nada é enviado', async () => {
    estado.postgrest = montar();
    for (const corpo of [{ todosPendentes: true }, { todosPendentes: true, usuarioIds: undefined }]) {
      const r = await post(corpo);
      assert.deepEqual([r.status, r.corpo.erro], [400, 'DADOS_INVALIDOS']);
    }
    assert.equal(chamadas.postgrest.length, 0);
  });

  test('consultas de escopo e alvos são em lote (uma cada), independentes de N', async () => {
    estado.postgrest = montar();
    await post({ usuarioIds: Array.from({ length: 30 }, (_, i) => i + 1) });
    const get = (pre) => chamadas.postgrest.filter((c) => c.endpoint.startsWith(pre)).length;
    assert.equal(get('UsuarioEntidade?usuario_id=in'), 1);
    assert.equal(get('Usuario?id=in'), 1);
  });

  test('rate limit: a 11ª requisição do MESMO usuário leva 429; outro usuário não é afetado', async () => {
    estado.postgrest = montar();
    const sub = 9000;
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await chamar('POST', '/usuarios/convites', { usuarioIds: [1] }, sub)).status, 200);
    }
    assert.equal((await chamar('POST', '/usuarios/convites', { usuarioIds: [1] }, sub)).status, 429);
    assert.equal((await chamar('POST', '/usuarios/convites', { usuarioIds: [1] }, sub + 1)).status, 200);
  });
});
