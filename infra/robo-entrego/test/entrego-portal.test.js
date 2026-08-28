// test/entrego-portal.test.js (tasks.md 4.1.4, 4.2.5, 4.3.5) — mock de `page`
// (interface .evaluate/.waitForFunction/.goto/.fill/.click/.waitForSelector/
// .context().storageState()) e de `axiosInstance`, sem Playwright real nem
// HTTP real (convenção do repo: nunca instalar browsers no host).
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  carregarStorageState,
  persistirStorageState,
  sondarSessaoValida,
  garantirSessaoValida,
  realizarLoginCompleto,
  buscarUrlsRelatorio,
  baixarCsv,
  validarItensUrls,
  TRADUCAO_TIPO_HUB,
  ErroAntibotSuspeito,
  ErroPortalTransitorio,
} = require('../src/entrego-portal');

function tmpPath(nome) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'robo-entrego-test-')), nome);
}

// --- 4.1.1/4.1.3 — carregar/persistir storageState -------------------------

describe('carregarStorageState / persistirStorageState', () => {
  test('ausente -> null', () => {
    assert.equal(carregarStorageState(tmpPath('nao-existe.json')), null);
  });

  test('persiste e recarrega com permissão 600', () => {
    const caminho = tmpPath('sub/entrego-session.json');
    persistirStorageState({ cookies: [{ name: 'x', value: '1' }] }, caminho);
    assert.deepEqual(carregarStorageState(caminho), { cookies: [{ name: 'x', value: '1' }] });
    const modo = fs.statSync(caminho).mode & 0o777;
    assert.equal(modo, 0o600);
  });
});

// --- 4.1.2 — sonda de sessão -------------------------------------------------

// `urlAtual` default 'about:blank' reproduz o estado REAL de uma aba recém-criada
// — foi esse estado que expôs o bug da sonda em 2026-08-28 (fetch com credenciais
// de about:blank falha). `gotos` registra as navegações para os testes de regressão.
function mockPageEvaluate(retorno, { urlAtual = 'https://franqueado.entregolog.com/' } = {}) {
  const gotos = [];
  return {
    gotos,
    url: () => urlAtual,
    goto: async (u) => { gotos.push(u); urlAtual = u; },
    evaluate: async (fn, args) => (typeof retorno === 'function' ? retorno(fn, args) : retorno),
  };
}

describe('sondarSessaoValida', () => {
  // REGRESSÃO (execução assistida 2026-08-28): a sonda faz fetch com
  // credentials:'include' DENTRO da página. Numa aba recém-criada (about:blank)
  // esse fetch falha na hora com "Failed to fetch", e a sonda estourava
  // ErroPortalTransitorio em TODA primeira execução. O mock antigo escondia isso
  // porque `evaluate` devolvia o status pedido sem passar por origem nenhuma.
  test('about:blank -> navega para o portal ANTES de sondar', async () => {
    const page = mockPageEvaluate({ status: 200 }, { urlAtual: 'about:blank' });
    assert.deepEqual(await sondarSessaoValida(page), { valida: true });
    assert.deepEqual(page.gotos, ['https://franqueado.entregolog.com'],
      'deveria navegar para a origem do portal antes do evaluate');
  });

  test('já na origem do portal -> NÃO navega de novo', async () => {
    const page = mockPageEvaluate({ status: 200 }, { urlAtual: 'https://franqueado.entregolog.com/supply/reports' });
    assert.deepEqual(await sondarSessaoValida(page), { valida: true });
    assert.deepEqual(page.gotos, [], 'navegação desnecessária custa tempo e gera sinal para o anti-bot');
  });

  // REGRESSÃO (execução assistida 2026-08-28): a sonda mandava só `Accept`. Sem
  // `X-IFood-Logistics-Auth`/`x-cookie-login` o BFF responde 401 mesmo com a
  // sessão VÁLIDA — o robô concluía "expirou" e refazia o login completo em toda
  // execução, anulando a decisão do block-003 e pondo o login (etapa sujeita ao
  // anti-bot) no caminho crítico diário.
  test('sonda envia os headers que o BFF exige (senão 401 com sessão válida)', async () => {
    let argsRecebidos;
    const page = mockPageEvaluate((fn, args) => { argsRecebidos = args; return { status: 200 }; });
    await sondarSessaoValida(page);
    assert.ok(argsRecebidos.headers, 'a sonda deve receber headers');
    assert.equal(argsRecebidos.headers['X-IFood-Logistics-Auth'], 'true');
    assert.equal(argsRecebidos.headers['x-cookie-login'], 'true');
  });

  test('200 -> valida true', async () => {
    const page = mockPageEvaluate({ status: 200 });
    assert.deepEqual(await sondarSessaoValida(page), { valida: true });
  });

  test('401 -> valida false (não é falha)', async () => {
    const page = mockPageEvaluate({ status: 401 });
    assert.deepEqual(await sondarSessaoValida(page), { valida: false });
  });

  test('5xx -> ErroPortalTransitorio sinal http_5xx_portal', async () => {
    const page = mockPageEvaluate({ status: 503 });
    await assert.rejects(() => sondarSessaoValida(page), (e) => e instanceof ErroPortalTransitorio && e.sinal === 'http_5xx_portal');
  });

  test('exceção de rede no evaluate -> ErroPortalTransitorio sinal erro_conexao', async () => {
    const page = { evaluate: async () => { throw new Error('net::ERR_CONNECTION_RESET'); } };
    await assert.rejects(() => sondarSessaoValida(page), (e) => e instanceof ErroPortalTransitorio && e.sinal === 'erro_conexao');
  });

  test('status inesperado (ex.: 403) -> ErroAntibotSuspeito', async () => {
    const page = mockPageEvaluate({ status: 403 });
    await assert.rejects(() => sondarSessaoValida(page), ErroAntibotSuspeito);
  });
});

// --- 4.1 completo — garantirSessaoValida ------------------------------------

describe('garantirSessaoValida', () => {
  test('sessão válida -> não reloga (obterCodigo nunca chamado)', async () => {
    const page = mockPageEvaluate({ status: 200 });
    let chamouObterCodigo = false;
    const r = await garantirSessaoValida(page, { email: 'a@x.com', senha: 's', obterCodigo: async () => { chamouObterCodigo = true; return '123456'; } });
    assert.deepEqual(r, { relogou: false });
    assert.equal(chamouObterCodigo, false);
  });

  test('sessão 401 -> aciona login completo e persiste storageState novo', async () => {
    const caminho = tmpPath('sessao/entrego-session.json');
    let evalCount = 0;
    const page = {
      evaluate: async () => {
        evalCount += 1;
        return { status: 401 }; // sonda
      },
      goto: async () => {},
      fill: async () => {},
      click: async () => {},
      waitForSelector: async () => {},
      waitForFunction: async () => {},
      context: () => ({ storageState: async () => ({ cookies: [{ name: 'sess', value: 'novo' }] }) }),
    };
    const r = await garantirSessaoValida(page, {
      email: 'a@x.com',
      senha: 's',
      obterCodigo: async () => '654321',
      storageStatePath: caminho,
    });
    assert.deepEqual(r, { relogou: true });
    assert.equal(evalCount, 1); // só a sonda passou por page.evaluate; login usa fill/click/waitFor*
    assert.deepEqual(carregarStorageState(caminho), { cookies: [{ name: 'sess', value: 'novo' }] });
  });
});

// --- 4.2 — login completo (4 passos) ----------------------------------------

function mockPageLogin({ falharEm = null } = {}) {
  const chamadas = [];
  const metodo = (nome, impl) => async (...args) => {
    chamadas.push(nome);
    if (falharEm === nome) throw new Error(`TimeoutError: esperando por elemento (${nome})`);
    return impl ? impl(...args) : undefined;
  };
  return {
    chamadas,
    goto: metodo('goto'),
    fill: metodo('fill'),
    click: metodo('click'),
    waitForSelector: metodo('waitForSelector'),
    waitForFunction: metodo('waitForFunction'),
    context: () => ({ storageState: async () => ({ cookies: [{ name: 'sess', value: 'ok' }] }) }),
  };
}

describe('realizarLoginCompleto', () => {
  test('4 passos completam com dados de teste — obterCodigo recebe o timestamp do passo 2', async () => {
    const page = mockPageLogin();
    let timestampRecebido = null;
    const storageState = await realizarLoginCompleto(page, {
      email: 'a@x.com',
      senha: 'segredo',
      obterCodigo: async (ts) => {
        timestampRecebido = ts;
        return '111222';
      },
    });
    assert.deepEqual(storageState, { cookies: [{ name: 'sess', value: 'ok' }] });
    assert.ok(timestampRecebido instanceof Date);
    // passos 1-3 antes de pedir o código; passo 4 depois
    assert.deepEqual(page.chamadas, ['goto', 'fill', 'click', 'waitForSelector', 'fill', 'click', 'click', 'waitForSelector', 'fill', 'click', 'waitForFunction']);
  });

  test('timeout no passo 1-3 (ex.: modal "OK, entendi" não aparece) -> ErroAntibotSuspeito, nunca trava', async () => {
    const page = mockPageLogin({ falharEm: 'click' }); // primeiro click (botão Continuar) falha
    await assert.rejects(
      () => realizarLoginCompleto(page, { email: 'a@x.com', senha: 's', obterCodigo: async () => '000000' }),
      ErroAntibotSuspeito
    );
  });

  test('timeout no passo 4 (código confirmado mas localStorage nunca aparece) -> ErroAntibotSuspeito', async () => {
    const page = mockPageLogin({ falharEm: 'waitForFunction' });
    await assert.rejects(
      () => realizarLoginCompleto(page, { email: 'a@x.com', senha: 's', obterCodigo: async () => '000000' }),
      ErroAntibotSuspeito
    );
  });

  test('falha do obterCodigo (IMAP) propaga como está — NÃO vira ErroAntibotSuspeito', async () => {
    const page = mockPageLogin();
    await assert.rejects(
      () =>
        realizarLoginCompleto(page, {
          email: 'a@x.com',
          senha: 's',
          obterCodigo: async () => {
            throw new Error('imap-codigo: nenhuma mensagem encontrada');
          },
        }),
      (e) => !(e instanceof ErroAntibotSuspeito) && /imap-codigo/.test(e.message)
    );
  });
});

// --- 4.3.1-4.3.3 — buscarUrlsRelatorio --------------------------------------

const ITEM_VALIDO = { url: 'https://s3.amazonaws.com/bucket/performance-report/x/2026-08-26/a.csv?X-Amz-Expires=604800', date: '2026-08-26' };

describe('validarItensUrls', () => {
  test('shape medido (array de {url,date}) é aceito', () => {
    assert.deepEqual(validarItensUrls([ITEM_VALIDO]), [ITEM_VALIDO]);
  });

  test('envelope {data:[...]} (não é o shape medido) -> ErroAntibotSuspeito', () => {
    assert.throws(() => validarItensUrls({ data: [ITEM_VALIDO] }), ErroAntibotSuspeito);
  });

  test('item sem url s3 -> ErroAntibotSuspeito', () => {
    assert.throws(() => validarItensUrls([{ date: '2026-08-26' }]), ErroAntibotSuspeito);
  });

  test('item com date fora do formato yyyy-MM-dd -> ErroAntibotSuspeito', () => {
    assert.throws(() => validarItensUrls([{ ...ITEM_VALIDO, date: '26/08/2026' }]), ErroAntibotSuspeito);
  });
});

describe('buscarUrlsRelatorio', () => {
  test('resposta pronta (1 chamada) — traduz PERFORMANCE->performance', async () => {
    const page = mockPageEvaluate({ status: 200, contentType: 'application/json', corpo: [ITEM_VALIDO] });
    const r = await buscarUrlsRelatorio(page, { tipo: 'PERFORMANCE', dataInicial: '2026-08-26', dataFinal: '2026-08-26' });
    assert.deepEqual(r, [{ tipoPortal: 'PERFORMANCE', tipoHub: 'performance', url: ITEM_VALIDO.url, date: ITEM_VALIDO.date }]);
    assert.equal(TRADUCAO_TIPO_HUB.FINANCE, 'faturamento');
  });

  test('array vazio -> poll até aparecer item (sem tempo real, relógio+sleep injetados)', async () => {
    let chamadas = 0;
    const page = {
      evaluate: async () => {
        chamadas += 1;
        return chamadas < 3 ? { status: 200, contentType: 'application/json', corpo: [] } : { status: 200, contentType: 'application/json', corpo: [ITEM_VALIDO] };
      },
    };
    let relogio = 0;
    const r = await buscarUrlsRelatorio(page, {
      tipo: 'FINANCE',
      dataInicial: '2026-08-26',
      dataFinal: '2026-08-26',
      intervaloMs: 10,
      timeoutMs: 1000,
      agora: () => relogio,
      dormir: async () => { relogio += 10; },
    });
    assert.equal(chamadas, 3);
    assert.equal(r[0].tipoHub, 'faturamento');
  });

  test('array vazio até estourar o timeout -> ErroPortalTransitorio sinal timeout_rede (nunca anti-bot)', async () => {
    const page = mockPageEvaluate({ status: 200, contentType: 'application/json', corpo: [] });
    let relogio = 0;
    await assert.rejects(
      () =>
        buscarUrlsRelatorio(page, {
          tipo: 'PERFORMANCE',
          dataInicial: '2026-08-26',
          dataFinal: '2026-08-26',
          intervaloMs: 10,
          timeoutMs: 25,
          agora: () => relogio,
          dormir: async () => { relogio += 10; },
        }),
      (e) => e instanceof ErroPortalTransitorio && e.sinal === 'timeout_rede'
    );
  });

  test('401 no meio da rodada -> ErroPortalTransitorio sinal sessao_expirada_401', async () => {
    const page = mockPageEvaluate({ status: 401, contentType: 'application/json', corpo: [] });
    await assert.rejects(
      () => buscarUrlsRelatorio(page, { tipo: 'PERFORMANCE', dataInicial: '2026-08-26', dataFinal: '2026-08-26' }),
      (e) => e instanceof ErroPortalTransitorio && e.sinal === 'sessao_expirada_401'
    );
  });

  test('5xx -> ErroPortalTransitorio sinal http_5xx_portal', async () => {
    const page = mockPageEvaluate({ status: 502, contentType: 'application/json', corpo: [] });
    await assert.rejects(
      () => buscarUrlsRelatorio(page, { tipo: 'PERFORMANCE', dataInicial: '2026-08-26', dataFinal: '2026-08-26' }),
      (e) => e instanceof ErroPortalTransitorio && e.sinal === 'http_5xx_portal'
    );
  });

  test('resposta é HTML (não JSON) -> ErroAntibotSuspeito, nunca retry transitório (4.3.3/4.3.5)', async () => {
    const page = mockPageEvaluate({ status: 200, contentType: 'text/html', corpo: '<html>challenge</html>' });
    await assert.rejects(
      () => buscarUrlsRelatorio(page, { tipo: 'PERFORMANCE', dataInicial: '2026-08-26', dataFinal: '2026-08-26' }),
      ErroAntibotSuspeito
    );
  });

  test('exceção de rede no evaluate -> ErroPortalTransitorio sinal erro_conexao', async () => {
    const page = { evaluate: async () => { throw new Error('net::ERR_TIMED_OUT'); } };
    await assert.rejects(
      () => buscarUrlsRelatorio(page, { tipo: 'PERFORMANCE', dataInicial: '2026-08-26', dataFinal: '2026-08-26' }),
      (e) => e instanceof ErroPortalTransitorio && e.sinal === 'erro_conexao'
    );
  });
});

// --- 4.3.4 — download do CSV -------------------------------------------------

function mockAxiosGet(resposta) {
  return { get: async () => resposta };
}

describe('baixarCsv', () => {
  test('200 CSV puro -> buffer + sha256', async () => {
    const csv = 'col1;col2\nval1;val2\n';
    const axiosInstance = mockAxiosGet({ status: 200, headers: { 'content-type': 'text/csv' }, data: Buffer.from(csv) });
    const { buffer, sha256 } = await baixarCsv('https://s3.amazonaws.com/x.csv', { axiosInstance });
    assert.equal(buffer.toString('utf8'), csv);
    assert.equal(sha256.length, 64);
  });

  test('XML de erro do S3 (URL expirada) -> ErroPortalTransitorio sinal erro_conexao', async () => {
    const xml = '<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>';
    const axiosInstance = mockAxiosGet({ status: 403, headers: { 'content-type': 'application/xml' }, data: Buffer.from(xml) });
    await assert.rejects(
      () => baixarCsv('https://s3.amazonaws.com/x.csv', { axiosInstance }),
      (e) => e instanceof ErroPortalTransitorio && e.sinal === 'erro_conexao'
    );
  });

  test('200 mas corpo começa com <?xml (content-type mentiroso) -> ErroPortalTransitorio', async () => {
    const xml = '<?xml version="1.0"?><Error><Code>Expired</Code></Error>';
    const axiosInstance = mockAxiosGet({ status: 200, headers: { 'content-type': 'text/plain' }, data: Buffer.from(xml) });
    await assert.rejects(() => baixarCsv('https://s3.amazonaws.com/x.csv', { axiosInstance }), ErroPortalTransitorio);
  });

  test('exceção de rede -> ErroPortalTransitorio sinal erro_conexao', async () => {
    const axiosInstance = { get: async () => { throw new Error('ECONNRESET'); } };
    await assert.rejects(
      () => baixarCsv('https://s3.amazonaws.com/x.csv', { axiosInstance }),
      (e) => e instanceof ErroPortalTransitorio && e.sinal === 'erro_conexao'
    );
  });
});
