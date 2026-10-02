// test/hub-client.test.js (tasks.md 3.3.5) — mock de `axiosInstance`
// (interface .post/.get -> {status, data, headers}), sem HTTP real.
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  criarClienteHub,
  esperaRetry429,
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

  test('sucesso=false + sinalFalha presente -> PATCH inclui `sinalFalha`, NUNCA `dados` (contract §3, task 4.2.1)', async () => {
    let corpoRecebido = null;
    const client = await clienteLogado({
      handlers: {
        patch: () => async (body) => { corpoRecebido = body; return { status: 200, data: { ok: true } }; },
      },
    });
    await client.atualizarEnriquecimento(10, { sucesso: false, motivoFalha: 'pessoa não encontrada', sinalFalha: 'pessoa_nao_encontrada', modo: 'sob-demanda' });
    assert.deepEqual(corpoRecebido, { sucesso: false, modo: 'sob-demanda', motivoFalha: 'pessoa não encontrada', sinalFalha: 'pessoa_nao_encontrada' });
    assert.equal('dados' in corpoRecebido, false);
  });

  test('sucesso=false + sinalFalha ausente (undefined) -> PATCH NÃO inclui `sinalFalha`', async () => {
    let corpoRecebido = null;
    const client = await clienteLogado({
      handlers: {
        patch: () => async (body) => { corpoRecebido = body; return { status: 200, data: { ok: true } }; },
      },
    });
    await client.atualizarEnriquecimento(10, { sucesso: false, motivoFalha: 'erro genérico sem sinal', sinalFalha: undefined, modo: 'sob-demanda' });
    assert.equal('sinalFalha' in corpoRecebido, false);
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

// ──────────────────────────────────────────────────────────────────────────────
// 429 no reporte de enriquecimento (achado da drenagem de 2026-09-06/07).
// O limitador do backend (30 req / 15 min por usuário) cobre o PATCH de
// resultado; a rodada custa 21 requisições e, com throttle de 30 s, estourava.
// Perder este PATCH é perder trabalho JÁ FEITO no portal.
// ──────────────────────────────────────────────────────────────────────────────

describe('esperaRetry429', () => {
  test('usa retry-after (s) e, na falta dele, ratelimit-reset', () => {
    assert.equal(esperaRetry429({ 'retry-after': '20' }), 20_000);
    assert.equal(esperaRetry429({ 'ratelimit-reset': '90' }), 90_000);
    assert.equal(esperaRetry429({ 'Retry-After': '5' }), 5_000, 'header case-insensitive');
  });
  test('sem cabeçalho -> 60 s; piso de 1 s; teto de 5 min', () => {
    assert.equal(esperaRetry429({}), 60_000);
    assert.equal(esperaRetry429({ 'retry-after': '0' }), 1000);
    assert.equal(esperaRetry429({ 'retry-after': '9999' }), 300_000);
    assert.equal(esperaRetry429({ 'retry-after': 'abc' }), 60_000, 'lixo cai no default');
  });
});

describe('atualizarEnriquecimento — retry no 429', () => {
  function clienteCom(respostas, esperas) {
    let i = 0;
    const axiosInstance = mockAxios({
      post: {
        '/api/v1/auth/login': loginHandlerPadrao(),
        '/api/v1/me/entidade': entidadeHandlerPadrao(),
      },
      patch: () => async () => respostas[i++],
    });
    return criarClienteHub({ idEmpresaEsperado: 6, axiosInstance, dormir: async (ms) => { esperas.push(ms); } });
  }

  test('429 seguido de 200 -> retenta, espera o tempo do header e NÃO perde o resultado', async () => {
    const esperas = [];
    const c = clienteCom([
      { status: 429, data: { erro: 'Muitas requisições.' }, headers: { 'retry-after': '30' } },
      { status: 200, data: {}, headers: {} },
    ], esperas);
    await c.login('a@b', 's');
    const r = await c.atualizarEnriquecimento(7, { sucesso: true, dados: { x: 1 }, modo: 'sob-demanda' });
    assert.equal(r.sinal, 'enriquecimento_200');
    assert.deepEqual(esperas, [30_000], 'esperou exatamente o que o header pediu');
  });

  test('429 persistente -> lança ErroHub após esgotar as tentativas', async () => {
    const esperas = [];
    const c = clienteCom([
      { status: 429, data: {}, headers: { 'retry-after': '2' } },
      { status: 429, data: {}, headers: { 'retry-after': '2' } },
      { status: 429, data: {}, headers: { 'retry-after': '2' } },
    ], esperas);
    await c.login('a@b', 's');
    await assert.rejects(
      () => c.atualizarEnriquecimento(9, { sucesso: false, motivoFalha: 'x', modo: 'sob-demanda' }),
      (e) => e instanceof ErroHub && /429/.test(e.message)
    );
    assert.equal(esperas.length, 2, '3 tentativas => 2 esperas');
  });

  test('200 de primeira -> nenhuma espera (caminho normal intocado)', async () => {
    const esperas = [];
    const c = clienteCom([{ status: 200, data: {}, headers: {} }], esperas);
    await c.login('a@b', 's');
    assert.equal((await c.atualizarEnriquecimento(1, { sucesso: true, dados: {}, modo: 'semestral' })).sinal, 'enriquecimento_200');
    assert.deepEqual(esperas, []);
  });
});

// ---------------------------------------------------------------------------
// Renovação de sessão no 401 (frente de confiabilidade do robô, 2026-10-02).
//
// Incidente que isto corrige: `hub_accessToken` vive 15 min e o cliente fazia
// login UMA vez por execução. Quando o portal EntreGô demorava a gerar o
// relatório, a execução passava de 15 min e o upload levava 401 — o dia inteiro
// se perdia. Medido no log real: as 3 falhas por 401 (11/09, 15/09, 16/09)
// duraram 28, 25 e 27 min; nenhuma execução abaixo de 15 min deu 401.
// ---------------------------------------------------------------------------
describe('renovação de sessão no 401', () => {
  /** Mock que devolve 401 nas `quantos401` primeiras chamadas ao caminho dado. */
  function mockComExpiracao({ quantos401 = 1, refreshStatus = 200 } = {}) {
    const chamadas = { upload: 0, refresh: 0 };
    const cookiesEnviados = { refresh: null, uploadDepois: null };
    return {
      chamadas,
      cookiesEnviados,
      axios: {
        async post(url, body, opts) {
          if (url === '/api/v1/auth/login') return loginHandlerPadrao()();
          if (url === '/api/v1/me/entidade') return entidadeHandlerPadrao()(body);
          if (url === '/api/v1/auth/refresh') {
            chamadas.refresh += 1;
            cookiesEnviados.refresh = opts.headers.Cookie;
            if (refreshStatus !== 200) return { status: refreshStatus, data: {}, headers: {} };
            return {
              status: 200,
              data: { ok: true },
              headers: {
                'set-cookie': [
                  `hub_accessToken=${fakeJwt({ sub: 1, entidade_ativa: 6 })}; HttpOnly`,
                  'hub_refreshToken=novo-refresh; HttpOnly',
                ],
              },
            };
          }
          if (url === '/api/v1/importacoes') {
            chamadas.upload += 1;
            if (chamadas.upload <= quantos401) return { status: 401, data: { erro: 'Sessão inválida.' }, headers: {} };
            cookiesEnviados.uploadDepois = opts.headers.Cookie;
            return { status: 201, data: { id: 9, status: 'pending' }, headers: {} };
          }
          throw new Error(`sem handler POST para ${url}`);
        },
        async get() { throw new Error('não deveria chamar GET'); },
        async patch() { throw new Error('não deveria chamar PATCH'); },
      },
    };
  }

  test('401 no upload: renova a sessão e refaz a chamada, que então passa', async () => {
    const m = mockComExpiracao();
    const client = criarClienteHub({ baseURL: 'http://x', idEmpresaEsperado: 6, axiosInstance: m.axios });
    await client.login('robo@x.com', 'senha');

    const r = await client.enviarImportacao({ tipo: 'performance', nomeArquivo: 'a.csv', bufferArquivo: Buffer.from('x') });

    assert.equal(r.sinal, 'upload_201', 'o upload deveria ter passado depois de renovar');
    assert.equal(m.chamadas.refresh, 1, 'deveria ter chamado /auth/refresh exatamente uma vez');
    assert.equal(m.chamadas.upload, 2, 'deveria ter refeito o upload uma vez');
  });

  test('manda o cookie INTEIRO no refresh, não só o refreshToken', async () => {
    // O hub relê `entidade_ativa` do accessToken ANTIGO, mesmo expirado
    // (routes/hub-auth.js#entidadeAtivaDeAccessAntigo, PR #161). Mandar só o
    // refresh faria o token novo nascer sem entidade e as chamadas seguintes
    // voltariam 400 ENTIDADE_NAO_SELECIONADA.
    const m = mockComExpiracao();
    const client = criarClienteHub({ baseURL: 'http://x', idEmpresaEsperado: 6, axiosInstance: m.axios });
    await client.login('robo@x.com', 'senha');
    await client.enviarImportacao({ tipo: 'performance', nomeArquivo: 'a.csv', bufferArquivo: Buffer.from('x') });

    assert.match(m.cookiesEnviados.refresh, /hub_accessToken=/, 'o refresh precisa levar o accessToken antigo');
  });

  test('a chamada refeita usa o cookie NOVO, não o vencido', async () => {
    const m = mockComExpiracao();
    const client = criarClienteHub({ baseURL: 'http://x', idEmpresaEsperado: 6, axiosInstance: m.axios });
    await client.login('robo@x.com', 'senha');
    await client.enviarImportacao({ tipo: 'performance', nomeArquivo: 'a.csv', bufferArquivo: Buffer.from('x') });

    assert.match(m.cookiesEnviados.uploadDepois, /hub_refreshToken=novo-refresh/, 'o upload refeito deveria usar o cookie devolvido pelo refresh');
  });

  test('refresh que falha: devolve o 401 original, sem insistir', async () => {
    // 401 que sobrevive ao refresh não é token vencido — é vínculo/cadastro do
    // usuário de serviço. Insistir só atrasaria a falha.
    const m = mockComExpiracao({ quantos401: 99, refreshStatus: 401 });
    const client = criarClienteHub({ baseURL: 'http://x', idEmpresaEsperado: 6, axiosInstance: m.axios });
    await client.login('robo@x.com', 'senha');

    await assert.rejects(
      () => client.enviarImportacao({ tipo: 'performance', nomeArquivo: 'a.csv', bufferArquivo: Buffer.from('x') }),
      (e) => e instanceof ErroHub && /status inesperado 401/.test(e.message)
    );
    assert.equal(m.chamadas.refresh, 1, 'tentou renovar uma vez');
    assert.equal(m.chamadas.upload, 1, 'não refez a chamada quando o refresh falhou');
  });

  test('401 que persiste mesmo após renovar: não entra em laço', async () => {
    const m = mockComExpiracao({ quantos401: 99 });
    const client = criarClienteHub({ baseURL: 'http://x', idEmpresaEsperado: 6, axiosInstance: m.axios });
    await client.login('robo@x.com', 'senha');

    await assert.rejects(() => client.enviarImportacao({ tipo: 'performance', nomeArquivo: 'a.csv', bufferArquivo: Buffer.from('x') }), ErroHub);
    assert.equal(m.chamadas.upload, 2, 'exatamente uma retentativa, não mais');
    assert.equal(m.chamadas.refresh, 1, 'exatamente um refresh, não mais');
  });
});
