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

  // 09:59 (1 min antes) passou a ser ACEITO pela margem de 2 min introduzida em
  // 2026-08-29. O que o teste cobre — mensagem de uma rodada ANTERIOR não pode
  // vazar — continua válido com uma distância realista entre janelas.
  test('mensagem MUITO antes do timestamp é ignorada -> lança (nenhuma válida após)', async () => {
    const client = mockClient([{ uid: 1, date: new Date('2026-08-27T08:30:00Z'), corpo: 'código: 111111' }]);
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

// --- REGRESSÃO: SINCE do IMAP é por DIA, no fuso do servidor (2026-08-29) ----
describe('lerCodigoAcesso — janela do SEARCH', () => {
  test('busca com since recuado 1 dia (senão perde mensagem na virada de dia)', async () => {
    const T = new Date('2026-08-29T00:30:00Z');
    let sinceUsado = null;
    const msg = { date: new Date('2026-08-29T00:22:00Z'), corpo: 'seu código: 135790' };
    const client = {
      getMailboxLock: async () => ({ release: () => {} }),
      search: async (q) => { sinceUsado = q.since; return [1]; },
      fetchOne: async () => ({ envelope: { date: msg.date }, source: Buffer.from(msg.corpo) }),
    };
    // aposTimestamp DEPOIS da mensagem faria o filtro client-side descartar,
    // então usamos um T0 anterior à mensagem para exercitar só a janela.
    const T0 = new Date('2026-08-29T00:20:00Z');
    const codigo = await lerCodigoAcesso(client, T0, { timeoutMs: 0, dormir: async () => {} });
    assert.equal(codigo, '135790');
    // O `since` parte do corte COM margem (disparo - 2min), depois recua 24h.
    const diffHoras = (T0 - sinceUsado) / 3600000;
    assert.ok(diffHoras >= 24 && diffHoras <= 24.1,
      `o since deve ficar ~24h antes do disparo (obtido: ${diffHoras}h)`);
    assert.ok(sinceUsado < T, 'janela precisa cobrir a véspera no fuso do servidor');
  });

  test('a margem NÃO deixa passar mensagem anterior ao disparo (filtro client-side)', async () => {
    const T0 = new Date('2026-08-29T00:20:00Z');
    const antiga = { date: new Date('2026-08-28T23:00:00Z'), corpo: 'código: 111111' };
    const client = {
      getMailboxLock: async () => ({ release: () => {} }),
      search: async () => [1],
      fetchOne: async () => ({ envelope: { date: antiga.date }, source: Buffer.from(antiga.corpo) }),
    };
    await assert.rejects(
      () => lerCodigoAcesso(client, T0, { timeoutMs: 0, dormir: async () => {} }),
      /nenhuma mensagem recebida após/
    );
  });
});

// --- margem + instrumentação (falhas reais de 2026-08-29 13h e 14h) ---------
// As rodadas falharam com "nenhuma mensagem recebida após o timestamp" ENQUANTO
// o e-mail estava na caixa, chegado ~2 min antes de o polling começar. A causa
// do descompasso não foi determinada — o log não registrava o timestamp de
// disparo. Estes testes travam a margem (paliativo) e a instrumentação (que
// permite fechar a causa na próxima ocorrência).
describe('lerCodigoAcesso — margem e diagnóstico', () => {
  const DISPARO = new Date('2026-08-29T16:04:00Z');
  // exatamente o caso real: e-mail 2 min ANTES do timestamp de disparo
  const MSG_ANTES = { date: new Date('2026-08-29T16:02:02Z'), corpo: 'seu código: 246813' };

  function clientCom(msg) {
    return {
      getMailboxLock: async () => ({ release: () => {} }),
      search: async () => [1],
      fetchOne: async () => ({ envelope: { date: msg.date }, source: Buffer.from(msg.corpo) }),
    };
  }

  test('e-mail chegado 2min ANTES do disparo é aceito pela margem', async () => {
    const codigo = await lerCodigoAcesso(clientCom(MSG_ANTES), DISPARO, {
      timeoutMs: 0, dormir: async () => {},
    });
    assert.equal(codigo, '246813', 'era o caso real de 13h/14h de 2026-08-29');
  });

  test('margem=0 reproduz a falha antiga (prova que era a margem)', async () => {
    await assert.rejects(
      () => lerCodigoAcesso(clientCom(MSG_ANTES), DISPARO, { timeoutMs: 0, margemMs: 0, dormir: async () => {} }),
      /nenhuma mensagem recebida após/
    );
  });

  test('mensagem MUITO antiga (1h) continua rejeitada — margem não é buraco', async () => {
    const antiga = { date: new Date('2026-08-29T15:00:00Z'), corpo: 'código: 111111' };
    await assert.rejects(
      () => lerCodigoAcesso(clientCom(antiga), DISPARO, { timeoutMs: 0, dormir: async () => {} }),
      /nenhuma mensagem recebida após/
    );
  });

  test('o erro carrega os 3 dados que faltaram para diagnosticar', async () => {
    const antiga = { date: new Date('2026-08-29T15:00:00Z'), corpo: 'código: 111111' };
    try {
      await lerCodigoAcesso(clientCom(antiga), DISPARO, { timeoutMs: 0, dormir: async () => {} });
      assert.fail('deveria ter lançado');
    } catch (e) {
      assert.ok(e.diagnosticoImap, 'o erro deve carregar diagnóstico');
      assert.equal(e.diagnosticoImap.disparo, DISPARO.toISOString());
      assert.ok(e.diagnosticoImap.corte_com_margem, 'corte efetivamente usado');
      assert.ok(e.diagnosticoImap.polling_iniciou, 'quando o polling começou');
      assert.equal(e.diagnosticoImap.mais_recente, '2026-08-29T15:00:00.000Z',
        'a mensagem mais recente que HAVIA na caixa — distingue "não enviou" de "não reconheci"');
      assert.match(e.message, /disparo=.*msg_mais_recente=/, 'a própria mensagem já traz o essencial');
    }
  });
});
