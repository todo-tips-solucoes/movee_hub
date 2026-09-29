// Unit de lib/hub-convite-senha.js — link, textos e hash do token.
//
// O que pode quebrar em silêncio e por isso é conferido aqui: o hash precisa
// ser o MESMO de routes/hub-auth.js (senão o /redefinir-senha nunca acha o
// token gravado no convite) e o link precisa apontar para a rota que existe
// (`/hub/redefinir-senha?token=…`), senão o convite chega com link morto.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  TTL_CONVITE_MS,
  gerarTokenBruto,
  hashToken,
  montarLink,
  montarMensagem,
} = require('../lib/hub-convite-senha');

test('hashToken é o mesmo sha256 hex que hub-auth grava e compara', () => {
  const token = 'abc123';
  const esperado = crypto.createHash('sha256').update(token).digest('hex');
  assert.equal(hashToken(token), esperado);
  // Confere contra a implementação viva da rota, não contra uma cópia.
  const hubAuth = require('../routes/hub-auth');
  assert.equal(hashToken(token), hubAuth.hashToken(token));
});

test('gerarTokenBruto devolve 256 bits em hex, sempre diferentes', () => {
  const a = gerarTokenBruto();
  const b = gerarTokenBruto();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test('montarLink aponta para a tela de redefinição do hub', () => {
  const anterior = process.env.HUB_URL;
  delete process.env.HUB_URL;
  assert.equal(montarLink('tok'), 'https://app.moveelog.com.br/hub/redefinir-senha?token=tok');

  // Barra sobrando no env não pode virar `//hub/...`.
  process.env.HUB_URL = 'https://exemplo.test/';
  assert.equal(montarLink('tok'), 'https://exemplo.test/hub/redefinir-senha?token=tok');

  if (anterior === undefined) delete process.env.HUB_URL;
  else process.env.HUB_URL = anterior;
});

test('convite e recuperação diferem em assunto e validade, e ambos levam o link', () => {
  const convite = montarMensagem({ nome: 'Maria Souza', tokenBruto: 'tok', tipo: 'convite' });
  const recuperacao = montarMensagem({ nome: 'Maria Souza', tokenBruto: 'tok', tipo: 'recuperacao' });

  assert.match(convite.assunto, /acesso/i);
  assert.match(recuperacao.assunto, /recupera/i);
  assert.notEqual(convite.assunto, recuperacao.assunto);

  for (const m of [convite, recuperacao]) {
    assert.ok(m.texto.includes(montarLink('tok')), 'a mensagem precisa conter o link');
    assert.ok(m.texto.includes('Maria'), 'saudação usa o primeiro nome');
    assert.ok(!m.texto.includes('Souza'), 'sobrenome não é usado na saudação');
  }
  assert.match(convite.texto, /7 dias/);
  assert.match(recuperacao.texto, /60 minutos/);
});

test('sem nome, a saudação não vira "Olá, ."', () => {
  const m = montarMensagem({ nome: '', tokenBruto: 'tok', tipo: 'convite' });
  assert.ok(m.texto.startsWith('Olá.'), m.texto.slice(0, 20));
});

// O que quebra em silêncio num e-mail HTML: o link deixar de ser clicável
// (href errado) e o nome vindo do banco entrar cru no corpo. Nada disso
// aparece em teste de tela — só aqui.
test('o HTML traz o link no href do botão e repetido por extenso', () => {
  for (const tipo of ['convite', 'recuperacao']) {
    const { html } = montarMensagem({ nome: 'Ana', tokenBruto: 'deadbeef', tipo });
    const link = montarLink('deadbeef');
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(hrefs, [link, link], `${tipo}: botão e link por extenso apontam para o link`);
    assert.match(html, /<a [^>]*>Criar (minha|nova) senha<\/a>/);
  }
});

test('nome com HTML entra escapado, nunca cru', () => {
  const { html } = montarMensagem({
    nome: '<script>alert(1)</script>', tokenBruto: 'deadbeef', tipo: 'convite',
  });
  assert.ok(!html.includes('<script>'), 'tag vinda do nome não pode sobreviver no corpo');
  assert.match(html, /&lt;script&gt;/);
});

test('o texto puro continua indo junto (fallback e fonte do token nos testes)', () => {
  const m = montarMensagem({ nome: 'Ana', tokenBruto: 'deadbeef', tipo: 'convite' });
  assert.ok(m.texto.includes(montarLink('deadbeef')));
  assert.ok(!m.texto.includes('<'), 'o corpo de texto não pode carregar marcação');
});

test('TTL do convite é de 7 dias', () => {
  assert.equal(TTL_CONVITE_MS, 7 * 24 * 60 * 60 * 1000);
});

// Nos ambientes isolados não há credencial de e-mail: o mock é a caixa de
// entrada, e três scripts (hub-auth-integration.sh ×2, hub-e2e-homolog.sh)
// extraem o token do texto entregue lá com /redefinir-senha\?token=([0-9a-f]+)/.
// Se o texto mudar de forma, esses testes quebram longe daqui — então a
// forma é conferida aqui, perto de quem a produz.
test('com MAIL_MOCK_URL, a mensagem chega ao mock no formato que o E2E lê', async () => {
  const http = require('node:http');
  const { enviarLinkSenha } = require('../lib/hub-convite-senha');

  let recebido = null;
  const servidor = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => { recebido = JSON.parse(corpo); res.end('{}'); });
  });
  await new Promise((r) => servidor.listen(0, r));

  const anterior = process.env.MAIL_MOCK_URL;
  process.env.MAIL_MOCK_URL = `http://127.0.0.1:${servidor.address().port}`;
  try {
    const envio = await enviarLinkSenha({
      para: 'alvo@example.test', nome: 'Ana', tokenBruto: 'deadbeef', tipo: 'recuperacao',
    });
    assert.equal(envio.ok, true, 'mock entregue conta como envio feito');
    assert.equal(recebido.to, 'alvo@example.test');
    const extraido = /redefinir-senha\?token=([0-9a-f]+)/.exec(recebido.text);
    assert.equal(extraido && extraido[1], 'deadbeef');
  } finally {
    if (anterior === undefined) delete process.env.MAIL_MOCK_URL;
    else process.env.MAIL_MOCK_URL = anterior;
    servidor.close();
  }
});
