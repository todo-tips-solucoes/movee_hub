const test = require('node:test');
const assert = require('node:assert');
const { enviarEmail, _definirConfigParaTeste } = require('../lib/resend-email');

const CONFIG = { apiKey: 're_fake', remetente: 'Movee <nao-responda@exemplo.com>', replyTo: 'resp@exemplo.com' };
const respostaOk = () => ({ ok: true, json: async () => ({ id: 'abc-123' }) });

test.describe('enviarEmail() — Resend', () => {
  test('monta a chamada com remetente, destino e reply-to da config', async () => {
    _definirConfigParaTeste(CONFIG);
    let capturado;
    const fake = async (url, opts) => { capturado = { url, opts }; return respostaOk(); };
    const r = await enviarEmail({ para: 'motorista@x.com', assunto: 'Oi', texto: 'corpo' }, fake);

    assert.equal(r.ok, true);
    assert.equal(r.id, 'abc-123');
    assert.equal(capturado.url, 'https://api.resend.com/emails');
    assert.match(capturado.opts.headers.Authorization, /^Bearer re_fake$/);
    const corpo = JSON.parse(capturado.opts.body);
    assert.equal(corpo.from, CONFIG.remetente);
    assert.deepEqual(corpo.to, ['motorista@x.com']);
    assert.equal(corpo.reply_to, CONFIG.replyTo);
  });

  // Recuperação de senha indisponível é ruim; backend fora do ar é pior. Estas
  // três falhas NUNCA podem lançar para quem chamou.
  test('config ausente não lança — devolve CONFIG_AUSENTE', async () => {
    _definirConfigParaTeste(null);
    assert.deepEqual(await enviarEmail({ para: 'a@b.com', assunto: 'x' }), { ok: false, erro: 'CONFIG_AUSENTE' });
  });

  test('recusa do provedor não lança — devolve RECUSADO com status', async () => {
    _definirConfigParaTeste(CONFIG);
    const fake = async () => ({ ok: false, status: 422, json: async () => ({ message: 'domain not verified' }) });
    const r = await enviarEmail({ para: 'a@b.com', assunto: 'x' }, fake);
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'RECUSADO');
    assert.equal(r.status, 422);
  });

  test('falha de rede não lança — devolve REDE', async () => {
    _definirConfigParaTeste(CONFIG);
    const fake = async () => { throw new Error('ECONNREFUSED'); };
    assert.deepEqual(await enviarEmail({ para: 'a@b.com', assunto: 'x' }, fake), { ok: false, erro: 'REDE' });
  });

  test('sem destinatário ou assunto, nem chama o provedor', async () => {
    _definirConfigParaTeste(CONFIG);
    let chamou = false;
    const fake = async () => { chamou = true; return respostaOk(); };
    assert.equal((await enviarEmail({ assunto: 'x' }, fake)).erro, 'DADOS_INVALIDOS');
    assert.equal((await enviarEmail({ para: 'a@b.com' }, fake)).erro, 'DADOS_INVALIDOS');
    assert.equal(chamou, false);
  });

  test('config sem replyTo não manda o campo', async () => {
    _definirConfigParaTeste({ apiKey: 're_x', remetente: 'A <a@b.com>' });
    let capturado;
    const fake = async (_u, opts) => { capturado = JSON.parse(opts.body); return respostaOk(); };
    await enviarEmail({ para: 'a@b.com', assunto: 'x', texto: 'y' }, fake);
    assert.equal('reply_to' in capturado, false);
  });
});
