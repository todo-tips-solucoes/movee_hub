// test/hub-client.test.js (tasks.md 3.3.5) — mock de `axiosInstance`
// (interface .post/.get -> {status, data, headers}), sem HTTP real.
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  criarClienteHub,
  ErroConfiguracaoHub,
  ErroHub,
  extrairCookieHeader,
  extrairValorCookie,
  decodificarPayloadJwt,
} = require('../src/hub-client');

/** JWT sintético (header.payload.assinatura) — só o payload importa, a
 * assinatura nunca é verificada client-side (decodificarPayloadJwt). */
function fakeJwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.assinatura-fake`;
}

function mockAxios(handlers) {
  return {
    async post(url, body, opts) {
      const h = handlers.post && handlers.post[url];
      if (!h) throw new Error(`mockAxios: sem handler POST para ${url}`);
      return h(body, opts);
    },
    async get(url, opts) {
      const h = handlers.get && handlers.get(url);
      if (!h) throw new Error(`mockAxios: sem handler GET para ${url}`);
      return h(opts);
    },
    async patch(url, body, opts) {
      const h = handlers.patch && handlers.patch(url);
      if (!h) throw new Error(`mockAxios: sem handler PATCH para ${url}`);
      return h(body, opts);
    },
  };
}

describe('funções puras — cookie/JWT', () => {
  test('extrairCookieHeader junta múltiplos Set-Cookie em 1 header', () => {
    const out = extrairCookieHeader(['hub_accessToken=abc; HttpOnly', 'hub_refreshToken=def; HttpOnly']);
    assert.equal(out, 'hub_accessToken=abc; hub_refreshToken=def');
  });
  test('extrairCookieHeader — string única também funciona', () => {
    assert.equal(extrairCookieHeader('hub_accessToken=abc; HttpOnly'), 'hub_accessToken=abc');
  });
  test('extrairCookieHeader — ausente -> null', () => {
    assert.equal(extrairCookieHeader(undefined), null);
  });
  test('extrairValorCookie localiza o cookie pelo nome', () => {
    assert.equal(extrairValorCookie('a=1; hub_accessToken=abc; b=2', 'hub_accessToken'), 'abc');
    assert.equal(extrairValorCookie('a=1', 'hub_accessToken'), null);
  });
  test('decodificarPayloadJwt lê o payload sem verificar assinatura', () => {
    const token = fakeJwt({ sub: 1, entidade_ativa: 6 });
    assert.deepEqual(decodificarPayloadJwt(token), { sub: 1, entidade_ativa: 6 });
  });
  test('decodificarPayloadJwt — token malformado -> null', () => {
    assert.equal(decodificarPayloadJwt('nao-e-jwt'), null);
    assert.equal(decodificarPayloadJwt(null), null);
  });
});

// login() real: POST /auth/login retorna token SEM entidade_ativa (mesmo
// padrão do backend real — routes/hub-auth.js#gerarAccessToken assina só
// {sub, email}, confirmado no roundtrip real da tasks.md 6.2); a claim só
// aparece após POST /me/entidade. Handler default aceita qualquer
// empresa_id postado e devolve a claim correspondente — testes que querem
// simular DIVERGÊNCIA de configuração sobrescrevem este handler.
function loginHandlerPadrao() {
  return async () => ({
    status: 200,
    data: {},
    headers: { 'set-cookie': [`hub_accessToken=${fakeJwt({ sub: 1 })}; HttpOnly`] },
  });
}
function entidadeHandlerPadrao() {
  return async (body) => ({
    status: 200,
    data: { entidade_ativa: body.empresa_id },
    headers: { 'set-cookie': [`hub_accessToken=${fakeJwt({ sub: 1, entidade_ativa: body.empresa_id })}; HttpOnly`] },
  });
}

describe('login', () => {
  test('sucesso — entidade_ativa (pós /me/entidade) bate com HUB_ID_EMPRESA', async () => {
    const axiosInstance = mockAxios({
      post: {
        '/api/v1/auth/login': loginHandlerPadrao(),
        '/api/v1/me/entidade': entidadeHandlerPadrao(),
      },
    });
    const client = criarClienteHub({ idEmpresaEsperado: 6, axiosInstance });
    const r = await client.login('robo@x.com', 'senha');
    assert.equal(r.entidadeAtiva, 6);
  });

  test('401 -> ErroHub com motivo', async () => {
    const axiosInstance = mockAxios({
      post: { '/api/v1/auth/login': async () => ({ status: 401, data: { erro: 'E-mail ou senha inválidos.' }, headers: {} }) },
    });
    const client = criarClienteHub({ idEmpresaEsperado: 6, axiosInstance });
    await assert.rejects(() => client.login('x', 'y'), (e) => e instanceof ErroHub && e.motivo === 'E-mail ou senha inválidos.');
  });

  test('POST /me/entidade falha (ex: 403 SEM_VINCULO) -> ErroConfiguracaoHub (nunca retry)', async () => {
    const axiosInstance = mockAxios({
      post: {
        '/api/v1/auth/login': loginHandlerPadrao(),
        '/api/v1/me/entidade': async () => ({ status: 403, data: { erro: 'SEM_VINCULO' }, headers: {} }),
      },
    });
    const client = criarClienteHub({ idEmpresaEsperado: 6, axiosInstance });
    await assert.rejects(() => client.login('robo@x.com', 'senha'), ErroConfiguracaoHub);
  });

  test('entidade_ativa devolvida diverge de HUB_ID_EMPRESA -> ErroConfiguracaoHub (nunca retry)', async () => {
    const axiosInstance = mockAxios({
      post: {
        '/api/v1/auth/login': loginHandlerPadrao(),
        '/api/v1/me/entidade': async () => ({
          status: 200,
          data: { entidade_ativa: 9 },
          headers: { 'set-cookie': [`hub_accessToken=${fakeJwt({ sub: 1, entidade_ativa: 9 })}; HttpOnly`] },
        }),
      },
    });
    const client = criarClienteHub({ idEmpresaEsperado: 6, axiosInstance });
    await assert.rejects(() => client.login('robo@x.com', 'senha'), ErroConfiguracaoHub);
  });

  test('200 sem Set-Cookie -> ErroHub', async () => {
    const axiosInstance = mockAxios({ post: { '/api/v1/auth/login': async () => ({ status: 200, data: {}, headers: {} }) } });
    const client = criarClienteHub({ idEmpresaEsperado: 6, axiosInstance });
    await assert.rejects(() => client.login('a', 'b'), ErroHub);
  });
});

async function clienteLogado({ idEmpresaEsperado = 6, handlers = {} } = {}) {
  const axiosInstance = mockAxios({
    post: {
      '/api/v1/auth/login': loginHandlerPadrao(),
      '/api/v1/me/entidade': entidadeHandlerPadrao(),
      ...handlers.post,
    },
    get: handlers.get,
    patch: handlers.patch,
  });
  const client = criarClienteHub({ idEmpresaEsperado, axiosInstance });
  await client.login('robo@x.com', 'senha');
  return client;
}

describe('enviarImportacao — 3 ramos de resposta (3.3.5)', () => {
  test('201 -> sinal upload_201', async () => {
    const client = await clienteLogado({
      handlers: { post: { '/api/v1/importacoes': async () => ({ status: 201, data: { id: 42, status: 'pending' }, headers: {} }) } },
    });
    const r = await client.enviarImportacao({ tipo: 'performance', nomeArquivo: 'a.csv', bufferArquivo: Buffer.from('x') });
    assert.deepEqual(r, { sinal: 'upload_201', id: 42, status: 'pending' });
  });

  test('409 -> sinal upload_409 (sucesso idempotente)', async () => {
    const client = await clienteLogado({
      handlers: { post: { '/api/v1/importacoes': async () => ({ status: 409, data: { error: 'CONFLITO', importacaoOriginalId: 7 }, headers: {} }) } },
    });
    const r = await client.enviarImportacao({ tipo: 'faturamento', nomeArquivo: 'a.csv', bufferArquivo: Buffer.from('x') });
    assert.deepEqual(r, { sinal: 'upload_409', importacaoOriginalId: 7 });
  });

  test('422 -> sinal upload_422 com motivo legível', async () => {
    const client = await clienteLogado({
      handlers: { post: { '/api/v1/importacoes': async () => ({ status: 422, data: { error: 'INVALIDO', motivo: 'CSV vazio' }, headers: {} }) } },
    });
    const r = await client.enviarImportacao({ tipo: 'performance', nomeArquivo: 'a.csv', bufferArquivo: Buffer.from('x') });
    assert.deepEqual(r, { sinal: 'upload_422', motivo: 'CSV vazio' });
  });

  test('sem login prévio -> ErroHub', async () => {
    const axiosInstance = mockAxios({});
    const client = criarClienteHub({ idEmpresaEsperado: 6, axiosInstance });
    await assert.rejects(() => client.enviarImportacao({ tipo: 'performance', nomeArquivo: 'a.csv', bufferArquivo: Buffer.from('x') }), ErroHub);
  });
});

describe('pollarImportacao', () => {
  test('completed -> sinal polling_completed', async () => {
    const client = await clienteLogado({
      handlers: { get: (_url) => async () => ({ status: 200, data: { status: 'completed' } }) },
    });
    const r = await client.pollarImportacao(1, { dormir: async () => {} });
    assert.equal(r.sinal, 'polling_completed');
  });

  test('failed -> sinal polling_failed', async () => {
    const client = await clienteLogado({ handlers: { get: (_url) => async () => ({ status: 200, data: { status: 'failed', erroResumo: 'x' } }) } });
    const r = await client.pollarImportacao(1, { dormir: async () => {} });
    assert.equal(r.sinal, 'polling_failed');
  });

  test('completed_with_errors -> sinal polling_completed_with_errors', async () => {
    const client = await clienteLogado({ handlers: { get: (_url) => async () => ({ status: 200, data: { status: 'completed_with_errors' } }) } });
    const r = await client.pollarImportacao(1, { dormir: async () => {} });
    assert.equal(r.sinal, 'polling_completed_with_errors');
  });

  test('pending -> processing -> completed (avança a cada chamada)', async () => {
    const sequencia = ['pending', 'processing', 'completed'];
    let i = 0;
    const client = await clienteLogado({ handlers: { get: (_url) => async () => ({ status: 200, data: { status: sequencia[i++] } }) } });
    const r = await client.pollarImportacao(1, { dormir: async () => {} });
    assert.equal(r.sinal, 'polling_completed');
    assert.equal(i, 3);
  });

  test('timeout — nunca sai de pending -> ErroHub (relógio + sleep falsos, sem tempo real)', async () => {
    let relogio = 0;
    const client = await clienteLogado({ handlers: { get: (_url) => async () => ({ status: 200, data: { status: 'pending' } }) } });
    await assert.rejects(
      () =>
        client.pollarImportacao(1, {
          intervaloMs: 10,
          timeoutMs: 25,
          agora: () => relogio,
          dormir: async () => {
            relogio += 10;
          },
        }),
      ErroHub
    );
  });
});

describe('registrarEvento (FASE 5, FR-013 auditoria)', () => {
  test('201 -> sinal evento_201', async () => {
    const client = await clienteLogado({
      handlers: { post: { '/api/v1/robo-entrego/eventos': async () => ({ status: 201, data: { ok: true }, headers: {} }) } },
    });
    const r = await client.registrarEvento({ acao: 'robo_entrego.suspeita_antibot', detalhes: { x: 1 } });
    assert.deepEqual(r, { sinal: 'evento_201' });
  });

  test('5xx -> sinal http_5xx_hub (best-effort, não lança)', async () => {
    const client = await clienteLogado({
      handlers: { post: { '/api/v1/robo-entrego/eventos': async () => ({ status: 503, data: {}, headers: {} }) } },
    });
    const r = await client.registrarEvento({ acao: 'robo_entrego.falha_definitiva' });
    assert.deepEqual(r, { sinal: 'http_5xx_hub', status: 503 });
  });

  test('422 (allowlist de acao) -> ErroHub', async () => {
    const client = await clienteLogado({
      handlers: { post: { '/api/v1/robo-entrego/eventos': async () => ({ status: 422, data: { erro: 'INVALIDO' }, headers: {} }) } },
    });
    await assert.rejects(() => client.registrarEvento({ acao: 'acao_inexistente' }), ErroHub);
  });

  test('sem login prévio -> ErroHub', async () => {
    const axiosInstance = mockAxios({});
    const client = criarClienteHub({ idEmpresaEsperado: 6, axiosInstance });
    await assert.rejects(() => client.registrarEvento({ acao: 'robo_entrego.sucesso' }), ErroHub);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// hub-motorista-360 FASE 5 (tasks.md 5.3.4) — buscarMotoristasParaEnriquecer
// + atualizarEnriquecimento (contracts/entrego-enriquecimento.md §2).
// ────────────────────────────────────────────────────────────────────────────

describe('buscarMotoristasParaEnriquecer', () => {
  test('200 -> devolve items (modo vai na querystring)', async () => {
    let urlChamada = null;
    const client = await clienteLogado({
      handlers: {
        get: (url) => { urlChamada = url; return async () => ({ status: 200, data: { items: [{ id: 1, idExterno: 'uuid-1' }] } }); },
      },
    });
    const items = await client.buscarMotoristasParaEnriquecer('sob-demanda');
    assert.deepEqual(items, [{ id: 1, idExterno: 'uuid-1' }]);
    assert.match(urlChamada, /modo=sob-demanda/);
  });

  test('items ausente no corpo -> [] (nunca undefined)', async () => {
    const client = await clienteLogado({ handlers: { get: () => async () => ({ status: 200, data: {} }) } });
    assert.deepEqual(await client.buscarMotoristasParaEnriquecer('semestral'), []);
  });

  test('403 -> ErroHub', async () => {
    const client = await clienteLogado({ handlers: { get: () => async () => ({ status: 403, data: { erro: 'PERMISSAO_NEGADA' } }) } });
    await assert.rejects(() => client.buscarMotoristasParaEnriquecer('sob-demanda'), ErroHub);
  });

  test('sem login prévio -> ErroHub', async () => {
    const axiosInstance = mockAxios({});
    const client = criarClienteHub({ idEmpresaEsperado: 6, axiosInstance });
    await assert.rejects(() => client.buscarMotoristasParaEnriquecer('sob-demanda'), ErroHub);
  });
});

describe('atualizarEnriquecimento', () => {
  test('sucesso=true -> PATCH inclui `dados`, nunca `motivoFalha`', async () => {
    let corpoRecebido = null;
    const client = await clienteLogado({
      handlers: {
        patch: () => async (body) => { corpoRecebido = body; return { status: 200, data: { ok: true } }; },
      },
    });
    const r = await client.atualizarEnriquecimento(10, { sucesso: true, dados: { dadosPessoais: {} }, modo: 'sob-demanda' });
    assert.deepEqual(r, { sinal: 'enriquecimento_200' });
    assert.deepEqual(corpoRecebido, { sucesso: true, modo: 'sob-demanda', dados: { dadosPessoais: {} } });
  });

  test('sucesso=false -> PATCH inclui `motivoFalha`, NUNCA `dados` (FR-007/contract §2)', async () => {
    let corpoRecebido = null;
    const client = await clienteLogado({
      handlers: {
        patch: () => async (body) => { corpoRecebido = body; return { status: 200, data: { ok: true } }; },
      },
    });
    await client.atualizarEnriquecimento(10, { sucesso: false, motivoFalha: 'antibot', modo: 'semestral' });
    assert.deepEqual(corpoRecebido, { sucesso: false, modo: 'semestral', motivoFalha: 'antibot' });
    assert.equal('dados' in corpoRecebido, false);
  });

  test('404 -> sinal enriquecimento_404 (id fora do escopo do serviço)', async () => {
    const client = await clienteLogado({ handlers: { patch: () => async () => ({ status: 404, data: { erro: 'NAO_ENCONTRADO' } }) } });
    const r = await client.atualizarEnriquecimento(999, { sucesso: true, dados: {} });
    assert.deepEqual(r, { sinal: 'enriquecimento_404' });
  });

  test('5xx -> sinal http_5xx_hub', async () => {
    const client = await clienteLogado({ handlers: { patch: () => async () => ({ status: 503, data: {} }) } });
    const r = await client.atualizarEnriquecimento(10, { sucesso: true, dados: {} });
    assert.deepEqual(r, { sinal: 'http_5xx_hub', status: 503 });
  });

  test('422 -> ErroHub', async () => {
    const client = await clienteLogado({ handlers: { patch: () => async () => ({ status: 422, data: { erro: 'INVALIDO' } }) } });
    await assert.rejects(() => client.atualizarEnriquecimento(10, { sucesso: true, dados: {} }), ErroHub);
  });

  test('sem login prévio -> ErroHub', async () => {
    const axiosInstance = mockAxios({});
    const client = criarClienteHub({ idEmpresaEsperado: 6, axiosInstance });
    await assert.rejects(() => client.atualizarEnriquecimento(10, { sucesso: true }), ErroHub);
  });
});
