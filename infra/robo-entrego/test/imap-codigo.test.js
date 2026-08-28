// test/imap-codigo.test.js (tasks.md 3.2.4) — mock do client ImapFlow (sem
// servidor IMAP real). Casos: mensagem antes do timestamp é ignorada,
// mensagem sem match de regex é rejeitada, múltiplas mensagens -> usa a mais
// recente.
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { lerCodigoAcesso, extrairCodigo } = require('../src/imap-codigo');

/** Constrói um client ImapFlow mock a partir de um array de mensagens
 * `{ uid, date, corpo }`. Reproduz só a superfície usada por imap-codigo.js. */
function mockClient(mensagens, { releaseCalls } = {}) {
  return {
    async getMailboxLock(_mailbox, opts) {
      assert.equal(opts.readOnly, true, 'imap-codigo MUST abrir a mailbox em readOnly (hardening owasp-security)');
      return {
        release() {
          if (releaseCalls) releaseCalls.push(true);
        },
      };
    },
    async search(query) {
      assert.equal(query.subject, 'Código de Acesso');
      return mensagens.map((m) => m.uid);
    },
    async fetchOne(uid) {
      const m = mensagens.find((x) => x.uid === uid);
      if (!m) return false;
      return { envelope: { date: m.date }, source: Buffer.from(m.corpo, 'utf8') };
    },
  };
}

describe('extrairCodigo', () => {
  test('extrai um código de 6 dígitos isolado no texto', () => {
    assert.equal(extrairCodigo('Seu código de acesso é 482913. Não compartilhe.'), '482913');
  });

  test('texto sem 6 dígitos isolados -> null (rejeitado)', () => {
    assert.equal(extrairCodigo('Sem código nenhum aqui.'), null);
  });

  test('7 dígitos seguidos não casa como código de 6 (fronteira de palavra)', () => {
    assert.equal(extrairCodigo('pedido 1234567 confirmado'), null);
  });

  test('entrada não-string -> null', () => {
    assert.equal(extrairCodigo(null), null);
    assert.equal(extrairCodigo(undefined), null);
    assert.equal(extrairCodigo(123456), null);
  });
});

describe('lerCodigoAcesso', () => {
  const T0 = new Date('2026-08-27T10:00:00Z');
  // Desliga a espera nos testes de FALHA: a leitura agora repete até o timeout
  // (o e-mail leva segundos para chegar), e sem isto cada teste de erro
  // esperaria 2 minutos de verdade.
  const SEM_ESPERA = { timeoutMs: 0, dormir: async () => {} };

  // REGRESSÃO (execução assistida 2026-08-28): antes, a busca acontecia UMA vez,
  // imediatamente após o clique que dispara o e-mail. Como envio + entrega levam
  // segundos, o robô procurava antes de a mensagem existir e falhava sempre.
  test('e-mail que só chega na 2ª tentativa é encontrado (não desiste na 1ª)', async () => {
    let chamadas = 0;
    const msg = { uid: 7, date: new Date('2026-08-27T10:00:30Z'), corpo: 'seu código: 654321' };
    const client = {
      getMailboxLock: async () => ({ release: () => {} }),
      // 1ª busca: caixa ainda sem a mensagem. 2ª: já chegou.
      search: async () => (++chamadas === 1 ? [] : [msg.uid]),
      fetchOne: async () => ({ envelope: { date: msg.date }, source: Buffer.from(msg.corpo) }),
    };
    const dormidas = [];
    const codigo = await lerCodigoAcesso(client, T0, {
      timeoutMs: 60000, intervaloMs: 5000, dormir: async (ms) => { dormidas.push(ms); },
    });
    assert.equal(codigo, '654321');
    assert.equal(chamadas, 2, 'deveria ter tentado de novo após a caixa vir vazia');
    assert.deepEqual(dormidas, [5000], 'deveria esperar o intervalo entre as tentativas');
  });

  test('código em formato inválido NÃO é retentado (insistir não muda o conteúdo)', async () => {
    let chamadas = 0;
    const client = {
      getMailboxLock: async () => ({ release: () => {} }),
      search: async () => { chamadas++; return [1]; },
      fetchOne: async () => ({ envelope: { date: new Date('2026-08-27T10:00:30Z') }, source: Buffer.from('sem digitos aqui') }),
    };
    await assert.rejects(
      () => lerCodigoAcesso(client, T0, { timeoutMs: 60000, dormir: async () => {} }),
      /não contém código no formato esperado/
    );
    assert.equal(chamadas, 1, 'erro definitivo não deve consumir o timeout inteiro');
  });

  test('mensagem ANTES do timestamp é ignorada -> lança (nenhuma válida após)', async () => {
    const client = mockClient([{ uid: 1, date: new Date('2026-08-27T09:59:00Z'), corpo: 'código: 111111' }]);
    await assert.rejects(() => lerCodigoAcesso(client, T0, SEM_ESPERA), /nenhuma mensagem recebida após/);
  });

  test('mensagem sem match de regex é rejeitada -> lança', async () => {
    const client = mockClient([{ uid: 1, date: new Date('2026-08-27T10:01:00Z'), corpo: 'sem código nenhum' }]);
    await assert.rejects(() => lerCodigoAcesso(client, T0), /não contém código no formato esperado/);
  });

  test('múltiplas mensagens não lidas -> usa a MAIS RECENTE', async () => {
    const client = mockClient([
      { uid: 1, date: new Date('2026-08-27T10:01:00Z'), corpo: 'código: 111111' },
      { uid: 2, date: new Date('2026-08-27T10:05:00Z'), corpo: 'código: 222222' },
      { uid: 3, date: new Date('2026-08-27T10:03:00Z'), corpo: 'código: 333333' },
    ]);
    const codigo = await lerCodigoAcesso(client, T0);
    assert.equal(codigo, '222222');
  });

  test('happy path — 1 mensagem válida', async () => {
    const releaseCalls = [];
    const client = mockClient([{ uid: 1, date: new Date('2026-08-27T10:01:00Z'), corpo: 'Seu código de acesso é 482913.' }], { releaseCalls });
    const codigo = await lerCodigoAcesso(client, T0);
    assert.equal(codigo, '482913');
    assert.equal(releaseCalls.length, 1, 'lock.release() MUST ser chamado (nunca vazar lock)');
  });

  test('nenhuma mensagem com o assunto -> lança', async () => {
    const client = mockClient([]);
    await assert.rejects(() => lerCodigoAcesso(client, T0, SEM_ESPERA), /nenhuma mensagem encontrada/);
  });

  test('lock é liberado mesmo em caso de erro (finally)', async () => {
    const releaseCalls = [];
    const client = mockClient([], { releaseCalls });
    await assert.rejects(() => lerCodigoAcesso(client, T0, SEM_ESPERA));
    assert.equal(releaseCalls.length, 1);
  });

  test('aposTimestamp inválido lança antes de tocar o client', async () => {
    await assert.rejects(() => lerCodigoAcesso(mockClient([]), 'não é uma data'), /aposTimestamp inválido/);
  });
});

// --- REGRESSÃO: cabeçalhos MIME contaminavam a extração (2026-08-28) --------
describe('extrairCodigo — e-mail RAW com cabeçalhos', () => {
  const RAW = [
    'Message-ID: <123456.789@mail.entregolog.com>',
    'Date: Fri, 28 Aug 2026 19:42:33 -0300',
    'X-Google-Smtp-Source: AGHT+998877 654321 abcdef',
    'Content-Type: multipart/alternative; boundary="----=_Part_112233_445566"',
    '',
    '<html><body><p>Seu código de acesso é <b>482913</b></p></body></html>',
  ].join('\r\n');

  test('ignora 6-dígitos dos cabeçalhos e pega o código do corpo', () => {
    assert.equal(extrairCodigo(RAW), '482913');
  });

  test('não devolve o Message-ID (era o bug: 123456)', () => {
    assert.notEqual(extrairCodigo(RAW), '123456');
  });

  test('âncora de contexto vence outro 6-dígitos que apareça antes no corpo', () => {
    const corpo = 'Pedido 998877 processado.\r\n\r\nUse o código 246810 para entrar.';
    assert.equal(extrairCodigo(corpo), '246810');
  });

  test('texto simples sem cabeçalho continua funcionando', () => {
    assert.equal(extrairCodigo('seu código: 654321'), '654321');
  });
});
