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

  test('mensagem ANTES do timestamp é ignorada -> lança (nenhuma válida após)', async () => {
    const client = mockClient([{ uid: 1, date: new Date('2026-08-27T09:59:00Z'), corpo: 'código: 111111' }]);
    await assert.rejects(() => lerCodigoAcesso(client, T0), /nenhuma mensagem recebida após/);
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
    await assert.rejects(() => lerCodigoAcesso(client, T0), /nenhuma mensagem encontrada/);
  });

  test('lock é liberado mesmo em caso de erro (finally)', async () => {
    const releaseCalls = [];
    const client = mockClient([], { releaseCalls });
    await assert.rejects(() => lerCodigoAcesso(client, T0));
    assert.equal(releaseCalls.length, 1);
  });

  test('aposTimestamp inválido lança antes de tocar o client', async () => {
    await assert.rejects(() => lerCodigoAcesso(mockClient([]), 'não é uma data'), /aposTimestamp inválido/);
  });
});
