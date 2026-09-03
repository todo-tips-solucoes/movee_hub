// test/alerta-email.test.js (tasks.md 3.4.3) — transportador mock (sem SMTP
// real). Cobre: múltiplos destinatários (3.4.2) e corpo do e-mail nunca
// incluindo segredo/URL pré-assinada completa (3.4.3).
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { montarCorpoAlerta, enviarAlerta, criarTransportador } = require('../src/alerta-email');

function mockTransportador() {
  const enviados = [];
  return {
    enviados,
    async sendMail(msg) {
      enviados.push(msg);
      return { messageId: 'mock-id' };
    },
  };
}

describe('montarCorpoAlerta — nunca inclui segredo/URL pré-assinada (3.4.3)', () => {
  test('relatorios com url_s3/senha/token — nenhum desses campos aparece no corpo', () => {
    const corpo = montarCorpoAlerta({
      execucaoId: 'exec-1',
      resultado: 'falha_total',
      motivoFalha: 'timeout no portal',
      relatorios: [
        {
          tipo_hub: 'performance',
          status_hub: null,
          tentativas: 3,
          url_s3: 'https://s3.amazonaws.com/bucket/segredo-pre-assinado?X-Amz-Signature=abc123',
          senha: 'super-secreto',
          token: 'bearer-xyz',
        },
      ],
    });
    assert.doesNotMatch(corpo, /s3\.amazonaws\.com/);
    assert.doesNotMatch(corpo, /X-Amz-Signature/);
    assert.doesNotMatch(corpo, /super-secreto/);
    assert.doesNotMatch(corpo, /bearer-xyz/);
    assert.match(corpo, /exec-1/);
    assert.match(corpo, /falha_total/);
    assert.match(corpo, /timeout no portal/);
    assert.match(corpo, /performance/);
  });

  test('sem relatorios -> corpo ainda descreve execucao/resultado', () => {
    const corpo = montarCorpoAlerta({ execucaoId: 'exec-2', resultado: 'falha_definitiva' });
    assert.match(corpo, /exec-2/);
    assert.match(corpo, /falha_definitiva/);
  });
});

describe('enviarAlerta — múltiplos destinatários (3.4.2)', () => {
  test('lista separada por vírgula vira lista de destinatários no envio', async () => {
    const transportador = mockTransportador();
    await enviarAlerta({
      transportador,
      remetente: 'paulo@todo-tips.com',
      destinatarios: 'a@x.com, b@x.com,c@x.com',
      execucaoId: 'exec-3',
      resultado: 'falha_total',
      motivoFalha: 'x',
      relatorios: [],
    });
    assert.equal(transportador.enviados.length, 1);
    assert.equal(transportador.enviados[0].to, 'a@x.com, b@x.com, c@x.com');
  });

  test('destinatario unico funciona', async () => {
    const transportador = mockTransportador();
    await enviarAlerta({ transportador, remetente: 'x@y.com', destinatarios: 'so@um.com', execucaoId: 'e', resultado: 'falha_total' });
    assert.equal(transportador.enviados[0].to, 'so@um.com');
  });

  test('destinatarios vazio -> lança (nunca envia silenciosamente pra ninguém)', async () => {
    const transportador = mockTransportador();
    await assert.rejects(
      () => enviarAlerta({ transportador, remetente: 'x@y.com', destinatarios: '', execucaoId: 'e', resultado: 'falha_total' }),
      /ALERTA_DESTINATARIOS/
    );
  });

  test('corpo do e-mail enviado tambem passa pela mesma allowlist (nao vaza url_s3)', async () => {
    const transportador = mockTransportador();
    await enviarAlerta({
      transportador,
      remetente: 'x@y.com',
      destinatarios: 'a@x.com',
      execucaoId: 'e',
      resultado: 'falha_parcial',
      relatorios: [{ tipo_hub: 'faturamento', url_s3: 'https://segredo', tentativas: 1 }],
    });
    assert.doesNotMatch(transportador.enviados[0].text, /segredo/);
  });
});

// O bug de 2026-09-03: toda a suíte usava transportador MOCK, então a porta
// real nunca foi verificada por teste nenhum. A VPS filtra a saída em 25 e
// 465 — com 465 o alerta morria em ETIMEDOUT e o operador não recebia nada,
// sem rastro. Este teste é o que impede a regressão silenciosa.
describe('criarTransportador — porta SMTP que a VPS deixa sair', () => {
  test('usa 587 com STARTTLS (25 e 465 são filtradas na saída)', () => {
    const t = criarTransportador({ gmailEmail: 'x@y.com', gmailAppPassword: 'senha' });
    const opts = t.transporter.options;
    assert.equal(opts.port, 587, 'porta 465/25 é bloqueada pelo provedor da VPS');
    assert.equal(opts.secure, false, '587 abre em claro e sobe para TLS via STARTTLS');
    assert.equal(opts.requireTLS, true, 'sem requireTLS o envio poderia cair para texto claro');
  });

  test('transporterCustom continua tendo precedência (injeção nos testes)', () => {
    const mock = mockTransportador();
    assert.equal(criarTransportador({ transporterCustom: mock }), mock);
  });
});
