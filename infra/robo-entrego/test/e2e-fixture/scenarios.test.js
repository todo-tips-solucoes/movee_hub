// scenarios.test.js (tasks.md 6.3.2) — os 5 cenários de quickstart.md
// (happy path, sessão expirada, anti-bot, retry, duplicado) rodando a
// orquestração REAL (`executarRodada`, src/index.js) contra um Chromium
// REAL — a diferença desta suíte para as das FASEs 4/5 (que testam com
// `page` mockado em Node puro, sem browser nenhum). Só o portal EntreGô é
// fixture/mock (login.html/login-challenge.html + rotas Playwright
// interceptadas do BFF, ver lib/mock-bff.js); hub/IMAP/e-mail continuam
// injetados como mock — o lado hub já foi validado contra o hub-homolog
// REAL na FASE 6.2 (contracts/hub-api.md); 6.3 é especificamente sobre o
// portal.
//
// Roda SÓ dentro do container oficial `mcr.microsoft.com/playwright`
// (scripts/testar-fixture-e2e.sh) — nunca no host (convenção do repo,
// nenhum browser instalado aqui) e NUNCA contra o portal EntreGô real
// (research.md Decision 2; incidente PerimeterX 2026-08-28).
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { headersCors, mockBff, mockLoginPage } = require('./lib/mock-bff');
const { executarRodada } = require('../../src/index');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const LOGIN_HTML = fs.readFileSync(path.join(FIXTURES_DIR, 'login.html'), 'utf8');
const LOGIN_CHALLENGE_HTML = fs.readFileSync(path.join(FIXTURES_DIR, 'login-challenge.html'), 'utf8');
const STORAGE_STATE_FIXTURE = path.join(FIXTURES_DIR, 'storage-state.json');

let browser;
let workDir;
let contadorArquivo = 0;

before(async () => {
  browser = await chromium.launch();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robo-entrego-fixture-'));
});

after(async () => {
  await browser.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

function tmpFile(nome) {
  contadorArquivo += 1;
  return path.join(workDir, `${contadorArquivo}-${nome}`);
}

async function novaPagina({ sondaStatus = 200, urlsHandler, loginHtml = LOGIN_HTML } = {}) {
  const context = await browser.newContext({ storageState: STORAGE_STATE_FIXTURE });
  const page = await context.newPage();
  await mockLoginPage(page, loginHtml);
  await mockBff(page, { sondaStatus, urlsHandler });
  return { context, page };
}

function config(overrides = {}) {
  return {
    entregoEmail: 'robo-fixture@example.test',
    entregoSenha: 'senha-fixture',
    gmailEmail: 'robo-fixture@example.test',
    alertaDestinatarios: 'alertas-fixture@example.test',
    storageStatePath: tmpFile('entrego-session.json'),
    ...overrides,
  };
}

function clienteHub(overrides = {}) {
  return {
    login: async () => ({ entidadeAtiva: 6 }),
    enviarImportacao: async () => ({ sinal: 'upload_201', id: 'fixture-importacao', status: 'processing' }),
    pollarImportacao: async () => ({ sinal: 'polling_completed', dados: { status: 'completed' } }),
    registrarEvento: async () => ({ sinal: 'evento_201' }),
    ...overrides,
  };
}

const axiosInstance = {
  get: async () => ({ status: 200, headers: { 'content-type': 'text/csv' }, data: Buffer.from('col1,col2\n1,2\n') }),
};
const transportador = { sendMail: async () => ({ messageId: 'fixture' }) };
async function obterCodigo() {
  return '123456';
}

async function rodar({ page, clienteHub: ch, dormir, cfg } = {}) {
  return executarRodada({
    page,
    config: cfg || config(),
    clienteHub: ch || clienteHub(),
    obterCodigo,
    transportador,
    dormir,
    axiosInstance,
    caminhoLog: tmpFile('execucoes.jsonl'),
  });
}

test('Scenario 1 (quickstart.md) — happy path: sessão reutilizada, 2 relatórios sucesso', async () => {
  const { context, page } = await novaPagina({ sondaStatus: 200 });
  try {
    const linha = await rodar({ page });
    assert.equal(linha.resultado, 'sucesso');
    assert.equal(linha.relatorios.length, 2);
    assert.ok(linha.relatorios.every((r) => r.status_hub != null));
  } finally {
    await context.close();
  }
});

test('Scenario 2 (quickstart.md) — sessão expirada: login completo de 4 passos, depois sucesso', async () => {
  const { context, page } = await novaPagina({ sondaStatus: 401 });
  try {
    const storageStatePath = tmpFile('entrego-session.json');
    const linha = await rodar({ page, cfg: config({ storageStatePath }) });
    assert.equal(linha.resultado, 'sucesso');
    assert.ok(fs.existsSync(storageStatePath), 'storageState deve ser persistido após relogin (4.1.3)');
  } finally {
    await context.close();
  }
});

test('Scenario 3 (quickstart.md) — anti-bot no login: para IMEDIATAMENTE, falha_total, zero retry', async () => {
  const { context, page } = await novaPagina({ sondaStatus: 401, loginHtml: LOGIN_CHALLENGE_HTML });
  try {
    const linha = await rodar({ page });
    assert.equal(linha.resultado, 'falha_total');
    assert.equal(linha.relatorios.length, 0);
    assert.equal(linha.tentativas_totais, 1); // 1 = a própria tentativa de relogin; zero retry (SC-003)
  } finally {
    await context.close();
  }
});

test('Scenario 4 (quickstart.md) — falha transitória: 2 falhas 5xx + backoff, sucesso na 3ª tentativa', async () => {
  let chamadasPerformance = 0;
  const urlsHandler = async (route, url) => {
    if (url.searchParams.get('type') === 'PERFORMANCE') {
      chamadasPerformance += 1;
      if (chamadasPerformance < 3) {
        return route.fulfill({ status: 500, contentType: 'application/json', headers: headersCors(route), body: '{}' });
      }
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: headersCors(route),
      body: JSON.stringify([{ url: 'https://s3.amazonaws.com/fixture-bucket/relatorio.csv', date: '2026-08-27' }]),
    });
  };
  const { context, page } = await novaPagina({ sondaStatus: 200, urlsHandler });
  try {
    const dormidas = [];
    const linha = await rodar({
      page,
      dormir: async (ms) => {
        dormidas.push(ms);
      },
    });
    assert.equal(linha.resultado, 'sucesso');
    const rPerf = linha.relatorios.find((r) => r.tipo_portal === 'PERFORMANCE');
    assert.equal(rPerf.tentativas, 3);
    assert.deepEqual(dormidas, [60000, 300000]); // FR-012: backoff 1min, 5min — sem esperar de verdade
  } finally {
    await context.close();
  }
});

test('Scenario 5 (quickstart.md) — arquivo já importado: 409 tratado como sucesso idempotente', async () => {
  const { context, page } = await novaPagina({ sondaStatus: 200 });
  try {
    const linha = await rodar({
      page,
      clienteHub: clienteHub({ enviarImportacao: async () => ({ sinal: 'upload_409', importacaoOriginalId: 'fixture-original' }) }),
    });
    assert.equal(linha.resultado, 'sucesso');
    assert.equal(linha.relatorios.length, 2);
    assert.ok(linha.relatorios.every((r) => r.status_hub === 'duplicado'));
  } finally {
    await context.close();
  }
});
