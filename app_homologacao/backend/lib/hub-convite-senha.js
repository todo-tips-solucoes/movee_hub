// Link de senha do hub enviado por e-mail — dois usos, um único texto e um
// único link:
//   - convite: usuário recém-criado em /usuarios, que ainda não tem senha;
//   - recuperação: "esqueci minha senha" (routes/hub-auth.js).
//
// Os dois consomem a MESMA tela (`/hub/redefinir-senha?token=…`) e as MESMAS
// colunas (`Usuario.token_recuperacao_hash` / `…_expira`), então só mudam o
// assunto e a validade.
//
// ⚠️ Até 2026-09-29 o `/recuperar-senha` do hub só escrevia no mock
// (`MAIL_MOCK_URL`), que existe apenas nos ambientes isolados: em produção o
// e-mail simplesmente não saía. O envio real vive aqui e é usado pelos dois
// pontos — o mock continua sendo chamado onde existe, para o E2E seguir
// lendo o token na caixa falsa.

'use strict';

const crypto = require('node:crypto');
const { enviarEmail } = require('./resend-email');

/** Convite de primeiro acesso: prazo largo porque quem recebe pode não abrir
 *  o e-mail no mesmo dia. A recuperação segue com 1 h (hub-auth.js). */
const TTL_CONVITE_MS = 7 * 24 * 60 * 60 * 1000;

/** 256 bits, mesmo padrão do refresh/recuperação (owasp ASVS L1). */
function gerarTokenBruto() {
  return crypto.randomBytes(32).toString('hex');
}

/** Igual ao hashToken de routes/hub-auth.js — o `/redefinir-senha` compara
 *  com ESTE hash, então os dois precisam ser o mesmo algoritmo. */
function hashToken(tokenBruto) {
  return crypto.createHash('sha256').update(tokenBruto).digest('hex');
}

function montarLink(tokenBruto) {
  const base = (process.env.HUB_URL || 'https://app.moveelog.com.br').replace(/\/+$/, '');
  return `${base}/hub/redefinir-senha?token=${tokenBruto}`;
}

/** Puro — separado do envio para poder ser conferido em teste sem rede. */
function montarMensagem({ nome, tokenBruto, tipo }) {
  const link = montarLink(tokenBruto);
  const primeiroNome = String(nome || '').trim().split(/\s+/)[0] || '';
  const saudacao = primeiroNome ? `Olá, ${primeiroNome}.` : 'Olá.';

  if (tipo === 'convite') {
    return {
      assunto: 'Seu acesso ao Movee Hub',
      texto: [
        saudacao,
        '',
        'Uma conta foi criada para você no Movee Hub.',
        '',
        `Abra este link para criar sua senha: ${link}`,
        '',
        'O link vale por 7 dias e só pode ser usado uma vez.',
        'Depois de criar a senha, entre pelo endereço acima com seu e-mail.',
      ].join('\n'),
    };
  }

  return {
    assunto: 'Recuperação de senha — Movee Hub',
    texto: [
      saudacao,
      '',
      'Você pediu para redefinir a senha do Movee Hub.',
      '',
      `Abra este link para criar uma nova senha: ${link}`,
      '',
      'O link vale por 60 minutos e só pode ser usado uma vez.',
      'Se não foi você, ignore este e-mail — sua senha atual continua valendo.',
    ].join('\n'),
  };
}

/**
 * Envia o link. NUNCA lança (enviarEmail já devolve `{ok,erro}`): quem chama
 * está no meio de um fluxo — criar usuário, pedir recuperação — que não pode
 * quebrar porque o provedor de e-mail está fora.
 *
 * Nos ambientes isolados do hub não há credencial de e-mail, e é do mock
 * (`MAIL_MOCK_URL`) que o E2E lê o link. Quando ele existe, a mesma mensagem
 * vai para lá e o envio conta como feito — é a caixa de entrada daquele
 * ambiente. Produção não define a variável e usa só o Resend.
 *
 * @param {{para:string, nome?:string, tokenBruto:string, tipo:'convite'|'recuperacao'}} args
 * @returns {Promise<{ok:boolean, id?:string|null, erro?:string}>}
 */
async function enviarLinkSenha({ para, nome, tokenBruto, tipo }) {
  const { assunto, texto } = montarMensagem({ nome, tokenBruto, tipo });
  const resultado = await enviarEmail({ para, assunto, texto });

  const mailMockUrl = process.env.MAIL_MOCK_URL;
  if (!mailMockUrl) return resultado;

  try {
    await fetch(`${mailMockUrl}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: para, subject: assunto, text: texto }),
    });
    return { ok: true, mock: true };
  } catch (e) {
    console.error('[hub-convite-senha] falha ao entregar no mock de e-mail:', e.message);
    return resultado;
  }
}

module.exports = {
  TTL_CONVITE_MS,
  gerarTokenBruto,
  hashToken,
  montarLink,
  montarMensagem,
  enviarLinkSenha,
};
