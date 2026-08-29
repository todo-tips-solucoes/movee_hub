// test/diagnostico-falha.test.js — o diagnóstico anexado ao log em caso de falha.
// Existe porque, em 2026-08-28, 3 execuções reais falharam e o `execucoes.jsonl`
// não explicou NENHUMA; 3 das 11 mensagens de erro apontavam para a conclusão
// ERRADA. Estes testes travam as duas propriedades que importam: ele NUNCA
// derruba a rodada, e NUNCA grava credencial.
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { instrumentarRede, coletar, _evalEstadoPagina } = require('../src/diagnostico-falha');

describe('instrumentarRede', () => {
  test('registra método/status/path e DESCARTA a querystring assinada', () => {
    let handler;
    const page = { on: (evt, fn) => { if (evt === 'response') handler = fn; } };
    const rede = instrumentarRede(page);
    handler({
      url: () => 'https://s3.amazonaws.com/bucket/rel.csv?X-Amz-Signature=SEGREDO&X-Amz-Date=1',
      status: () => 200,
      request: () => ({ method: () => 'GET' }),
    });
    const linha = rede.eventos[0];
    assert.ok(linha.includes('200 GET'), 'deve ter status e método');
    assert.ok(!linha.includes('SEGREDO'), 'assinatura AWS NUNCA pode entrar no log');
    assert.ok(linha.includes('[X-Amz-Signature,X-Amz-Date]'), 'só os NOMES dos parâmetros');
  });

  test('ignora assets e domínios de terceiros', () => {
    let handler;
    const rede = instrumentarRede({ on: (e, fn) => { if (e === 'response') handler = fn; } });
    const resp = (u) => ({ url: () => u, status: () => 200, request: () => ({ method: () => 'GET' }) });
    handler(resp('https://franqueado.entregolog.com/app.js'));
    handler(resp('https://www.google-analytics.com/g/collect?v=2'));
    assert.equal(rede.eventos.length, 0);
  });

  test('page sem .on (mock/teste) não lança', () => {
    assert.deepEqual(instrumentarRede({}).eventos, []);
  });
});

describe('coletar', () => {
  test('agrega estado da página e rede', async () => {
    const page = { evaluate: async () => ({ url: 'https://x/login', botoes: [{ texto: 'Continuar' }] }) };
    const d = await coletar(page, { eventos: ['401 POST /auth'] });
    assert.equal(d.pagina.url, 'https://x/login');
    assert.deepEqual(d.rede, ['401 POST /auth']);
    assert.ok(d.capturado_em);
  });

  // A propriedade mais importante: o diagnóstico existe para EXPLICAR a falha,
  // então ele jamais pode virar a falha.
  test('page.evaluate que explode NÃO derruba a coleta', async () => {
    const page = { evaluate: async () => { throw new Error('página morreu'); } };
    const d = await coletar(page, { eventos: [] });
    assert.ok(d.pagina_erro.includes('página morreu'));
    assert.ok(d.capturado_em, 'ainda deve devolver algo utilizável');
  });

  test('screenshot que falha não derruba a coleta', async () => {
    const page = {
      evaluate: async () => ({ url: 'https://x' }),
      screenshot: async () => { throw new Error('sem disco'); },
    };
    const d = await coletar(page, { eventos: [] }, { screenshotPath: '/tmp/x.png' });
    assert.ok(d.screenshot_erro.includes('sem disco'));
    assert.equal(d.pagina.url, 'https://x');
  });

  test('page nula não lança', async () => {
    const d = await coletar(null, null);
    assert.ok(d.capturado_em);
  });
});

describe('_evalEstadoPagina (roda dentro da página)', () => {
  test('valor de input vira booleano — nunca o conteúdo digitado', () => {
    const fonte = _evalEstadoPagina.toString();
    assert.ok(/preenchido:\s*!!e\.value/.test(fonte),
      'o valor do campo NUNCA pode ser gravado; só se está preenchido');
    assert.ok(!/value:\s*e\.value/.test(fonte), 'não pode expor e.value diretamente');
  });

  test('coleta TODOS os botões, não button[type=submit]', () => {
    const fonte = _evalEstadoPagina.toString();
    assert.ok(fonte.includes("querySelectorAll('button')"),
      'o portal não renderiza o atributo type — filtrar por ele devolve vazio');
  });
});
