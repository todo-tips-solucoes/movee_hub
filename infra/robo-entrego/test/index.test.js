// test/index.test.js (tasks.md 5.1.5) — cenários 1-5 e 7 de quickstart.md,
// com mocks de `page` (Playwright), `clienteHub` (hub-client), `axiosInstance`
// (download do CSV), `transportador` (nodemailer) e `dormir` (backoff sem
// tempo real). Nenhum browser/IMAP/SMTP/HTTP real (convenção do repo).
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const index = require('../src/index');
const { carregarStorageState } = require('../src/entrego-portal');

function tmpPath(nome) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'robo-entrego-index-')), nome);
}

// ---------------------------------------------------------------------------
// Mocks reutilizáveis
// ---------------------------------------------------------------------------

/** `urls`: { PERFORMANCE: valorOuFn, FINANCE: valorOuFn } — cada um no shape `_evalBuscarUrls` retorna: {status, contentType, corpo}. */
// `renovar` default 401: o refresh falha e o fluxo cai no login completo —
// preserva a semântica dos cenários escritos antes do §10.
function criarPageMock({ sonda = { status: 200 }, urls = {}, renovar = { status: 401 } } = {}) {
  const mock = {
    chamadasLogin: 0,
    evaluate: async (fn, args) => {
      if (fn.name === '_evalSondaSessao') {
        return typeof sonda === 'function' ? sonda(args) : sonda;
      }
      if (fn.name === '_evalRenovarSessao') {
        return typeof renovar === 'function' ? renovar(args) : renovar;
      }
      if (fn.name === '_evalBuscarUrls') {
        const h = urls[args.tipo];
        if (!h) throw new Error(`mock: sem handler de urls para ${args.tipo}`);
        return typeof h === 'function' ? h(args) : h;
      }
      throw new Error(`mock page.evaluate: fn desconhecida (${fn.name})`);
    },
    goto: async () => {},
    fill: async () => { mock.chamadasLogin += 1; },
    click: async () => { mock.chamadasLogin += 1; },
    waitForSelector: async () => {},
    waitForFunction: async () => {},
    context: () => ({ storageState: async () => ({ cookies: [{ name: 'sess', value: 'novo' }] }) }),
  };
  return mock;
}

function criarClienteHubMock({ upload = { sinal: 'upload_201', id: 1, status: 'pending' }, poll = { sinal: 'polling_completed', dados: { status: 'completed' } }, reprocessar = { sinal: 'reprocessar_202', id: 42, status: 'pending' } } = {}) {
  const eventos = [];
  const reprocessados = [];
  return {
    eventos,
    reprocessados,
    login: async () => ({ entidadeAtiva: 6 }),
    enviarImportacao: typeof upload === 'function' ? upload : async () => upload,
    reprocessarImportacao: async (id) => {
      reprocessados.push(id);
      return typeof reprocessar === 'function' ? reprocessar(id) : reprocessar;
    },
    pollarImportacao: typeof poll === 'function' ? poll : async () => poll,
    registrarEvento: async (args) => {
      eventos.push(args);
      return { sinal: 'evento_201' };
    },
  };
}

function csvAxios() {
  return { get: async () => ({ status: 200, headers: { 'content-type': 'text/csv' }, data: Buffer.from('col1;col2\n1;2\n') }) };
}

function criarTransportadorMock() {
  const enviados = [];
  return {
    enviados,
    sendMail: async (opts) => {
      enviados.push(opts);
      return {};
    },
  };
}

const CONFIG_BASE = {
  entregoEmail: 'a@x.com',
  entregoSenha: 'segredo',
  gmailEmail: 'g@x.com',
  hubServicoEmail: 'h@x.com',
  hubServicoSenha: 'segredo',
  alertaDestinatarios: 'paulo@todo-tips.com',
};

function config(overrides = {}) {
  return { ...CONFIG_BASE, storageStatePath: tmpPath('entrego-session.json'), ...overrides };
}

const dormirRapido = async () => {}; // FR-012 backoff sem tempo real
const semSleepChamadas = () => {
  const chamadas = [];
  return { dormir: async (ms) => chamadas.push(ms), chamadas };
};

const URLS_OK = (tipo) => ({
  status: 200,
  contentType: 'application/json',
  corpo: [{ url: `https://s3.amazonaws.com/bucket/${tipo}.csv`, date: '2026-08-26' }],
});

// ---------------------------------------------------------------------------
// Helpers puros
// ---------------------------------------------------------------------------

describe('dataAnteriorISO', () => {
  test('subtrai 1 dia (America/Sao_Paulo)', () => {
    // meio-dia UTC de 2026-08-28 = manhã em SP (UTC-3) — dia anterior = 27
    assert.equal(index.dataAnteriorISO(Date.parse('2026-08-28T12:00:00Z')), '2026-08-27');
  });

  test('borda de meia-noite UTC ainda é o dia anterior correto em SP', () => {
    // 2026-08-28T02:00:00Z = 2026-08-27T23:00 em SP -> dia anterior = 26
    assert.equal(index.dataAnteriorISO(Date.parse('2026-08-28T02:00:00Z')), '2026-08-26');
  });
});

describe('carregarEnv / lerConfiguracao', () => {
  test('carregarEnv parseia KEY=VALUE, ignora comentário/linha em branco, nunca sobrescreve env já setado', () => {
    const caminho = tmpPath('.env');
    fs.writeFileSync(caminho, '# comentário\nFOO_TEST_1=bar\n\nFOO_TEST_2=baz\n');
    const env = {};
    const original = process.env.FOO_TEST_1;
    try {
      delete process.env.FOO_TEST_1;
      delete process.env.FOO_TEST_2;
      index.carregarEnv(caminho);
      assert.equal(process.env.FOO_TEST_1, 'bar');
      assert.equal(process.env.FOO_TEST_2, 'baz');
    } finally {
      delete process.env.FOO_TEST_1;
      delete process.env.FOO_TEST_2;
      if (original !== undefined) process.env.FOO_TEST_1 = original;
    }
  });

  test('carregarEnv com arquivo ausente -> no-op (nunca lança)', () => {
    assert.doesNotThrow(() => index.carregarEnv(tmpPath('nao-existe.env')));
  });

  test('lerConfiguracao — campo obrigatório ausente lança erro claro', () => {
    assert.throws(() => index.lerConfiguracao({}), /configuração incompleta/);
  });

  test('lerConfiguracao — completo devolve objeto normalizado', () => {
    const env = {
      ENTREGO_EMAIL: 'a@x.com',
      ENTREGO_SENHA: 's',
      GMAIL_EMAIL: 'g@x.com',
      GMAIL_APP_PASSWORD: 'p',
      HUB_SERVICO_EMAIL: 'h@x.com',
      HUB_SERVICO_SENHA: 's2',
      HUB_ID_EMPRESA: '6',
      HUB_BASE_URL: 'https://app.moveelog.com.br',
      ALERTA_DESTINATARIOS: 'x@x.com',
    };
    const cfg = index.lerConfiguracao(env);
    assert.equal(cfg.hubIdEmpresa, '6');
    assert.equal(cfg.storageStatePath, require('../src/entrego-portal').STORAGE_STATE_PATH_DEFAULT);
  });
});

// ---------------------------------------------------------------------------
// comRetryTransitorio / determinarAcao
// ---------------------------------------------------------------------------

describe('comRetryTransitorio (FR-012)', () => {
  test('sucesso na 1a tentativa — sem sleep', async () => {
    const { dormir, chamadas } = semSleepChamadas();
    const { valor, tentativas } = await index.comRetryTransitorio(async () => 'ok', { dormir });
    assert.equal(valor, 'ok');
    assert.equal(tentativas, 1);
    assert.deepEqual(chamadas, []);
  });

  test('2 falhas transitórias + sucesso na 3a — tentativas:3, backoff 1min/5min', async () => {
    let i = 0;
    const { dormir, chamadas } = semSleepChamadas();
    const fn = async () => {
      i += 1;
      if (i < 3) {
        const e = new Error('rede');
        e.sinal = 'erro_conexao';
        throw e;
      }
      return 'ok';
    };
    const { valor, tentativas } = await index.comRetryTransitorio(fn, { dormir });
    assert.equal(valor, 'ok');
    assert.equal(tentativas, 3);
    assert.deepEqual(chamadas, index.BACKOFF_MS_SEQUENCIA.slice(0, 2));
  });

  test('esgota as 4 tentativas (3 retries) — propaga com .tentativas=4', async () => {
    const { dormir } = semSleepChamadas();
    const fn = async () => {
      const e = new Error('rede');
      e.sinal = 'timeout_rede';
      throw e;
    };
    await assert.rejects(
      () => index.comRetryTransitorio(fn, { dormir }),
      (e) => e.tentativas === 4
    );
  });

  test('erro não-transitório (schema_inesperado) propaga IMEDIATAMENTE, sem sleep', async () => {
    const { dormir, chamadas } = semSleepChamadas();
    const fn = async () => {
      const e = new Error('antibot');
      e.sinal = 'schema_inesperado';
      throw e;
    };
    await assert.rejects(() => index.comRetryTransitorio(fn, { dormir }), (e) => e.tentativas === 1);
    assert.deepEqual(chamadas, []);
  });

  test('erro sem sinal reconhecido -> tratado como NÃO transitório (padrão conservador), sem retry', async () => {
    const { dormir, chamadas } = semSleepChamadas();
    const fn = async () => {
      throw new Error('sem sinal');
    };
    await assert.rejects(() => index.comRetryTransitorio(fn, { dormir }), (e) => e.tentativas === 1);
    assert.deepEqual(chamadas, []);
  });
});

describe('determinarAcao', () => {
  const { ErroConfiguracaoHub } = require('../src/hub-client');
  const { ErroAntibotSuspeito } = require('../src/entrego-portal');

  test('ErroConfiguracaoHub -> falha_configuracao', () => {
    assert.equal(index.determinarAcao(new ErroConfiguracaoHub('x')), index.ACOES_EVENTO.FALHA_CONFIGURACAO);
  });

  test('ErroAntibotSuspeito -> suspeita_antibot', () => {
    assert.equal(index.determinarAcao(new ErroAntibotSuspeito('x')), index.ACOES_EVENTO.SUSPEITA_ANTIBOT);
  });

  test('sinal schema_inesperado (sem ser instância) -> suspeita_antibot', () => {
    const e = new Error('x');
    e.sinal = 'schema_inesperado';
    assert.equal(index.determinarAcao(e), index.ACOES_EVENTO.SUSPEITA_ANTIBOT);
  });

  test('sinal transitório esgotado, ou falha do hub, ou desconhecido -> falha_definitiva (default seguro)', () => {
    const e1 = new Error('x'); e1.sinal = 'erro_conexao';
    const e2 = new Error('x'); e2.sinal = 'polling_failed';
    const e3 = new Error('x'); // sem sinal
    for (const e of [e1, e2, e3]) {
      assert.equal(index.determinarAcao(e), index.ACOES_EVENTO.FALHA_DEFINITIVA);
    }
  });
});

// ---------------------------------------------------------------------------
// executarRodada — Scenarios 1-5, 7 de quickstart.md
// ---------------------------------------------------------------------------

describe('executarRodada — Scenario 1: happy path, sessão reutilizada', () => {
  test('2 relatórios completed -> resultado sucesso, sem e-mail/auditoria', async () => {
    const page = criarPageMock({ sonda: { status: 200 }, urls: { PERFORMANCE: URLS_OK('PERFORMANCE'), FINANCE: URLS_OK('FINANCE') } });
    const clienteHub = criarClienteHubMock();
    const transportador = criarTransportadorMock();
    const r = await index.executarRodada({
      page,
      config: config(),
      clienteHub,
      obterCodigo: async () => '123456',
      transportador,
      dormir: dormirRapido,
      axiosInstance: csvAxios(),
      caminhoLog: tmpPath('execucoes.jsonl'),
    });
    assert.equal(r.resultado, 'sucesso');
    assert.equal(r.relatorios.length, 2);
    assert.ok(r.relatorios.every((rel) => rel.status_hub === 'completed'));
    assert.equal(transportador.enviados.length, 0);
    assert.equal(clienteHub.eventos.length, 0);
  });
});

describe('executarRodada — Scenario 2: sessão expirada (401 na sonda) -> login completo', () => {
  test('novo storageState persistido; rodada segue e conclui sucesso', async () => {
    const page = criarPageMock({ sonda: { status: 401 }, urls: { PERFORMANCE: URLS_OK('PERFORMANCE'), FINANCE: URLS_OK('FINANCE') } });
    const clienteHub = criarClienteHubMock();
    const cfg = config();
    const r = await index.executarRodada({
      page,
      config: cfg,
      clienteHub,
      obterCodigo: async () => '123456',
      transportador: criarTransportadorMock(),
      dormir: dormirRapido,
      axiosInstance: csvAxios(),
      caminhoLog: tmpPath('execucoes.jsonl'),
    });
    assert.equal(r.resultado, 'sucesso');
    assert.deepEqual(carregarStorageState(cfg.storageStatePath), { cookies: [{ name: 'sess', value: 'novo' }] });
  });
});

// §10: a importação também passa a renovar pelo refresh antes de relogar —
// tanto na sonda inicial quanto no 401 no meio da rodada (tentativaComRelogin),
// que antes chamava o login completo direto.
describe('executarRodada — Scenario 2b: sessão expirada -> refresh 200 -> segue SEM login completo', () => {
  test('sonda 401 + refresh 200: nenhum passo de login, storageState persistido, rodada sucesso', async () => {
    const page = criarPageMock({ sonda: { status: 401 }, renovar: { status: 200 }, urls: { PERFORMANCE: URLS_OK('PERFORMANCE'), FINANCE: URLS_OK('FINANCE') } });
    const cfg = config();
    const r = await index.executarRodada({
      page, config: cfg, clienteHub: criarClienteHubMock(),
      obterCodigo: async () => { throw new Error('login completo NÃO deveria ser acionado'); },
      transportador: criarTransportadorMock(), dormir: dormirRapido, axiosInstance: csvAxios(), caminhoLog: tmpPath('execucoes.jsonl'),
    });
    assert.equal(r.resultado, 'sucesso');
    assert.equal(page.chamadasLogin, 0);
    assert.deepEqual(carregarStorageState(cfg.storageStatePath), { cookies: [{ name: 'sess', value: 'novo' }] });
  });

  test('401 no meio do relatório + refresh 200: retenta sem login completo', async () => {
    let chamadasUrls = 0;
    let sondas = 0;
    const page = criarPageMock({
      // 1ª sonda (início da rodada) 200; a do relogin no meio 401 -> força o refresh
      sonda: () => { sondas += 1; return { status: sondas === 1 ? 200 : 401 }; },
      renovar: { status: 200 },
      urls: {
        PERFORMANCE: () => { chamadasUrls += 1; return chamadasUrls === 1 ? { status: 401, contentType: 'application/json', corpo: {} } : URLS_OK('PERFORMANCE'); },
        FINANCE: URLS_OK('FINANCE'),
      },
    });
    const r = await index.executarRodada({
      page, config: config(), clienteHub: criarClienteHubMock(),
      obterCodigo: async () => { throw new Error('login completo NÃO deveria ser acionado'); },
      transportador: criarTransportadorMock(), dormir: dormirRapido, axiosInstance: csvAxios(), caminhoLog: tmpPath('execucoes.jsonl'),
    });
    assert.equal(r.resultado, 'sucesso');
    assert.equal(chamadasUrls, 2);
    assert.equal(sondas, 2);
    assert.equal(page.chamadasLogin, 0);
  });
});

describe('executarRodada — Scenario 3: desafio anti-bot -> parada imediata, sem retry, falha_total', () => {
  test('PERFORMANCE com HTML no lugar de JSON aborta a rodada — FINANCE nunca é tentado', async () => {
    let chamadasFinance = 0;
    const page = criarPageMock({
      sonda: { status: 200 },
      urls: {
        PERFORMANCE: { status: 200, contentType: 'text/html', corpo: '<html>challenge</html>' },
        FINANCE: () => {
          chamadasFinance += 1;
          return URLS_OK('FINANCE');
        },
      },
    });
    const clienteHub = criarClienteHubMock();
    const transportador = criarTransportadorMock();
    const r = await index.executarRodada({
      page,
      config: config(),
      clienteHub,
      obterCodigo: async () => '123456',
      transportador,
      dormir: dormirRapido,
      axiosInstance: csvAxios(),
      caminhoLog: tmpPath('execucoes.jsonl'),
    });
    assert.equal(r.resultado, 'falha_total');
    assert.equal(chamadasFinance, 0); // FR-011: nunca tenta o próximo tipo após suspeita
    assert.equal(r.relatorios.length, 1);
    assert.equal(clienteHub.eventos.length, 1);
    assert.equal(clienteHub.eventos[0].acao, 'robo_entrego.suspeita_antibot');
    assert.equal(transportador.enviados.length, 1);
  });
});

describe('executarRodada — Scenario 4: falha transitória, retry com backoff, depois sucesso', () => {
  test('2 falhas de rede + sucesso na 3a — tentativas:3 no relatório, resultado sucesso, sem alerta', async () => {
    let i = 0;
    const page = criarPageMock({
      sonda: { status: 200 },
      urls: {
        PERFORMANCE: () => {
          i += 1;
          if (i < 3) throw new Error('net::ERR_CONNECTION_RESET');
          return URLS_OK('PERFORMANCE');
        },
        FINANCE: URLS_OK('FINANCE'),
      },
    });
    const clienteHub = criarClienteHubMock();
    const transportador = criarTransportadorMock();
    const { dormir, chamadas } = semSleepChamadas();
    const r = await index.executarRodada({
      page,
      config: config(),
      clienteHub,
      obterCodigo: async () => '123456',
      transportador,
      dormir,
      axiosInstance: csvAxios(),
      caminhoLog: tmpPath('execucoes.jsonl'),
    });
    assert.equal(r.resultado, 'sucesso');
    const perf = r.relatorios.find((x) => x.tipo_portal === 'PERFORMANCE');
    assert.equal(perf.tentativas, 3);
    assert.deepEqual(chamadas, index.BACKOFF_MS_SEQUENCIA.slice(0, 2));
    assert.equal(transportador.enviados.length, 0);
  });
});

describe('executarRodada — Scenario 5: arquivo já importado (409) -> sucesso idempotente', () => {
  test('status_hub duplicado, sem retry, sem alerta', async () => {
    const page = criarPageMock({ sonda: { status: 200 }, urls: { PERFORMANCE: URLS_OK('PERFORMANCE'), FINANCE: URLS_OK('FINANCE') } });
    let pollChamado = false;
    const clienteHub = criarClienteHubMock({ upload: { sinal: 'upload_409', importacaoOriginalId: 42 }, poll: async () => { pollChamado = true; return { sinal: 'polling_completed', dados: { status: 'completed' } }; } });
    const transportador = criarTransportadorMock();
    const r = await index.executarRodada({
      page,
      config: config(),
      clienteHub,
      obterCodigo: async () => '123456',
      transportador,
      dormir: dormirRapido,
      axiosInstance: csvAxios(),
      caminhoLog: tmpPath('execucoes.jsonl'),
    });
    assert.equal(r.resultado, 'sucesso');
    assert.ok(r.relatorios.every((rel) => rel.status_hub === 'duplicado'));
    // Mudou em 2026-08-30: o 409 CONSULTA o status da importação anterior antes
    // de decidir. Anterior `completed` -> duplicado de verdade, nada a refazer.
    assert.equal(pollChamado, true);
    assert.deepEqual(clienteHub.reprocessados, []);
    assert.equal(transportador.enviados.length, 0);
  });
});

describe('executarRodada — 409 sobre importação TORTA -> reprocessa o mesmo id', () => {
  // O dia 28/08/2026 entrou com 1 linha a menos porque a regra de validação
  // mudou DEPOIS (PR #132). Reenviar o arquivo batia no UNIQUE do hash e
  // voltava 409, e o robô dava o dia por importado. Sem este caminho, um dia
  // torto não tem como ser refeito por ninguém.
  test('anterior completed_with_errors -> chama reprocessar e o dia entra', async () => {
    const page = criarPageMock({ sonda: { status: 200 }, urls: { PERFORMANCE: URLS_OK('PERFORMANCE'), FINANCE: URLS_OK('FINANCE') } });
    const statusPorChamada = [];
    const clienteHub = criarClienteHubMock({
      upload: { sinal: 'upload_409', importacaoOriginalId: 42 },
      poll: async () => {
        // Cada relatório faz 2 chamadas: a ímpar lê o estado da importação
        // anterior (torta), a par lê o desfecho do reprocessamento (ok).
        statusPorChamada.push(1);
        return statusPorChamada.length % 2 === 1
          ? { sinal: 'polling_completed_with_errors', dados: { status: 'completed_with_errors' } }
          : { sinal: 'polling_completed', dados: { status: 'completed' } };
      },
    });
    const transportador = criarTransportadorMock();
    const r = await index.executarRodada({
      page,
      config: config(),
      clienteHub,
      obterCodigo: async () => '123456',
      transportador,
      dormir: dormirRapido,
      axiosInstance: csvAxios(),
      caminhoLog: tmpPath('execucoes.jsonl'),
    });
    assert.equal(r.resultado, 'sucesso');
    assert.deepEqual(clienteHub.reprocessados, [42, 42]); // os 2 relatórios
    assert.ok(r.relatorios.every((rel) => rel.status_hub === 'completed'));
    assert.ok(r.relatorios.every((rel) => rel.reprocessado === true));
    assert.equal(transportador.enviados.length, 0);
  });

  test('reprocessar recusado (409) -> falha com o estado real, nunca sucesso inventado', async () => {
    const page = criarPageMock({ sonda: { status: 200 }, urls: { PERFORMANCE: URLS_OK('PERFORMANCE'), FINANCE: URLS_OK('FINANCE') } });
    const clienteHub = criarClienteHubMock({
      upload: { sinal: 'upload_409', importacaoOriginalId: 42 },
      poll: { sinal: 'polling_failed', dados: { status: 'failed', erroResumo: 'cabeçalho inválido' } },
      reprocessar: { sinal: 'reprocessar_409' },
    });
    const transportador = criarTransportadorMock();
    const r = await index.executarRodada({
      page,
      config: config(),
      clienteHub,
      obterCodigo: async () => '123456',
      transportador,
      dormir: dormirRapido,
      axiosInstance: csvAxios(),
      caminhoLog: tmpPath('execucoes.jsonl'),
    });
    assert.equal(r.resultado, 'falha_total');
    assert.match(r.motivo_falha, /não pôde ser reprocessada/);
  });
});

describe('executarRodada — falha parcial (data-model.md dec-025)', () => {
  test('1 sucesso + 1 falha definitiva (422) -> falha_parcial, reação isolada só para o que falhou', async () => {
    const page = criarPageMock({ sonda: { status: 200 }, urls: { PERFORMANCE: URLS_OK('PERFORMANCE'), FINANCE: URLS_OK('FINANCE') } });
    const clienteHub = criarClienteHubMock({
      upload: async ({ tipo }) => (tipo === 'faturamento' ? { sinal: 'upload_422', motivo: 'CSV vazio' } : { sinal: 'upload_201', id: 1, status: 'pending' }),
    });
    const transportador = criarTransportadorMock();
    const r = await index.executarRodada({
      page,
      config: config(),
      clienteHub,
      obterCodigo: async () => '123456',
      transportador,
      dormir: dormirRapido,
      axiosInstance: csvAxios(),
      caminhoLog: tmpPath('execucoes.jsonl'),
    });
    assert.equal(r.resultado, 'falha_parcial');
    assert.equal(clienteHub.eventos.length, 1);
    assert.equal(clienteHub.eventos[0].acao, 'robo_entrego.falha_definitiva');
    assert.equal(transportador.enviados.length, 1);
    // o relatório bem-sucedido (performance) não aparece no e-mail de alerta
    const corpoEmail = transportador.enviados[0].text;
    assert.ok(!/performance/.test(corpoEmail));
  });
});

describe('executarRodada — sessão expira NO MEIO da rodada (401 fora da sonda inicial)', () => {
  test('reloga 1x sem contar como tentativa (FR-016), relatório conclui com tentativas:1', async () => {
    let chamadasUrls = 0;
    const page = criarPageMock({
      sonda: { status: 200 },
      urls: {
        PERFORMANCE: () => {
          chamadasUrls += 1;
          if (chamadasUrls === 1) return { status: 401, contentType: 'application/json', corpo: {} };
          return URLS_OK('PERFORMANCE');
        },
        FINANCE: URLS_OK('FINANCE'),
      },
    });
    const clienteHub = criarClienteHubMock();
    const r = await index.executarRodada({
      page,
      config: config(),
      clienteHub,
      obterCodigo: async () => '123456',
      transportador: criarTransportadorMock(),
      dormir: dormirRapido,
      axiosInstance: csvAxios(),
      caminhoLog: tmpPath('execucoes.jsonl'),
    });
    assert.equal(r.resultado, 'sucesso');
    const perf = r.relatorios.find((x) => x.tipo_portal === 'PERFORMANCE');
    assert.equal(perf.tentativas, 1); // relogin não conta como tentativa
    assert.equal(chamadasUrls, 2);
  });
});

describe('executarRodada — falha ANTES do loop (login do hub, ErroConfiguracaoHub)', () => {
  test('nenhum relatório tentado -> falha_total, acao falha_configuracao', async () => {
    const page = criarPageMock({ sonda: { status: 200 }, urls: { PERFORMANCE: URLS_OK('PERFORMANCE'), FINANCE: URLS_OK('FINANCE') } });
    const { ErroConfiguracaoHub } = require('../src/hub-client');
    const clienteHub = criarClienteHubMock();
    clienteHub.login = async () => {
      throw new ErroConfiguracaoHub('entidade_ativa não bate');
    };
    const transportador = criarTransportadorMock();
    const r = await index.executarRodada({
      page,
      config: config(),
      clienteHub,
      obterCodigo: async () => '123456',
      transportador,
      dormir: dormirRapido,
      axiosInstance: csvAxios(),
      caminhoLog: tmpPath('execucoes.jsonl'),
    });
    assert.equal(r.resultado, 'falha_total');
    assert.equal(r.relatorios.length, 0);
    assert.equal(clienteHub.eventos[0].acao, 'robo_entrego.falha_configuracao');
  });
});

// ---------------------------------------------------------------------------
// Scenario 7 — lock (pulado_lock)
// ---------------------------------------------------------------------------

describe('executarPuladoLock (tasks.md 5.1.4, quickstart Scenario 7)', () => {
  test('registra resultado pulado_lock sem tocar portal/hub', () => {
    const caminhoLog = tmpPath('execucoes.jsonl');
    const linha = index.executarPuladoLock({ caminhoLog });
    assert.equal(linha.resultado, 'pulado_lock');
    assert.deepEqual(linha.relatorios, []);
    const conteudo = fs.readFileSync(caminhoLog, 'utf8').trim().split('\n');
    assert.equal(conteudo.length, 2); // inicio + fim
    assert.equal(JSON.parse(conteudo[1]).resultado, 'pulado_lock');
  });
});
