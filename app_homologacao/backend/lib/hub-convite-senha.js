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

/** Nome vem do banco: entra no HTML escapado, nunca cru. */
function escaparHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Corpo HTML — tabela + CSS inline porque cliente de e-mail não tem `<style>`
 * confiável nem flex/grid. Sem imagem externa (Gmail bloqueia por padrão e o
 * e-mail chegaria vazio), então a marca é só tipografia e cor.
 *
 * O link aparece DUAS vezes de propósito: no botão e escrito por extenso
 * embaixo. Cliente que não renderiza o botão, ou quem precisa copiar a URL
 * para outro navegador, continua conseguindo entrar.
 */
function montarHtml({ saudacao, chamada, link, rodape, botao }) {
  const PRIMARIA = '#2c66e9'; // --primary do painel (frontend_v2/app/globals.css)
  return `<!doctype html>
<html lang="pt-BR"><body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2430;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;">
  <tr><td style="padding:32px 28px 8px;">
    <p style="margin:0 0 4px;font-size:18px;font-weight:600;color:${PRIMARIA};">Movee Hub</p>
    <p style="margin:16px 0 0;font-size:15px;line-height:22px;">${escaparHtml(saudacao)}</p>
    <p style="margin:12px 0 0;font-size:15px;line-height:22px;">${escaparHtml(chamada)}</p>
  </td></tr>
  <tr><td style="padding:24px 28px;">
    <a href="${escaparHtml(link)}" style="display:inline-block;padding:12px 24px;background:${PRIMARIA};color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:8px;">${escaparHtml(botao)}</a>
  </td></tr>
  <tr><td style="padding:0 28px 28px;">
    <p style="margin:0;font-size:13px;line-height:20px;color:#5b6472;">Se o botão não abrir, copie este endereço no navegador:<br>
      <a href="${escaparHtml(link)}" style="color:${PRIMARIA};word-break:break-all;">${escaparHtml(link)}</a>
    </p>
    <p style="margin:16px 0 0;font-size:13px;line-height:20px;color:#5b6472;">${escaparHtml(rodape)}</p>
  </td></tr>
</table>
</body></html>`;
}

/** Puro — separado do envio para poder ser conferido em teste sem rede.
 *  Devolve `texto` E `html`: o texto continua sendo o corpo que o mock guarda
 *  e de onde os testes extraem o token, e é o fallback de quem lê em texto. */
function montarMensagem({ nome, tokenBruto, tipo }) {
  const link = montarLink(tokenBruto);
  const primeiroNome = String(nome || '').trim().split(/\s+/)[0] || '';
  const saudacao = primeiroNome ? `Olá, ${primeiroNome}.` : 'Olá.';

  if (tipo === 'convite') {
    const chamada = 'Uma conta foi criada para você no Movee Hub.';
    const rodape = 'O link vale por 7 dias e só pode ser usado uma vez. Depois de criar a senha, entre pelo mesmo endereço com seu e-mail.';
    return {
      assunto: 'Seu acesso ao Movee Hub',
      texto: [
        saudacao,
        '',
        chamada,
        '',
        `Abra este link para criar sua senha: ${link}`,
        '',
        'O link vale por 7 dias e só pode ser usado uma vez.',
        'Depois de criar a senha, entre pelo endereço acima com seu e-mail.',
      ].join('\n'),
      html: montarHtml({ saudacao, chamada, link, rodape, botao: 'Criar minha senha' }),
    };
  }

  const chamada = 'Você pediu para redefinir a senha do Movee Hub.';
  const rodape = 'O link vale por 60 minutos e só pode ser usado uma vez. Se não foi você, ignore este e-mail — sua senha atual continua valendo.';
  return {
    assunto: 'Recuperação de senha — Movee Hub',
    texto: [
      saudacao,
      '',
      chamada,
      '',
      `Abra este link para criar uma nova senha: ${link}`,
      '',
      'O link vale por 60 minutos e só pode ser usado uma vez.',
      'Se não foi você, ignore este e-mail — sua senha atual continua valendo.',
    ].join('\n'),
    html: montarHtml({ saudacao, chamada, link, rodape, botao: 'Criar nova senha' }),
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
  const { assunto, texto, html } = montarMensagem({ nome, tokenBruto, tipo });
  const resultado = await enviarEmail({ para, assunto, texto, html });

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
