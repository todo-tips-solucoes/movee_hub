// Moldura HTML dos e-mails transacionais — usada pelo hub
// (lib/hub-convite-senha.js) e pelo app do motorista (routes/motorista.js).
//
// Nasceu dentro de hub-convite-senha.js em 2026-09-29 e saiu de lá no mesmo
// dia, quando o segundo produto precisou do mesmo botão: `require` de um
// módulo chamado "hub-*" dentro do app do motorista confundiria quem lesse.
//
// Por que tabela e estilo inline: cliente de e-mail não tem `<style>`
// confiável nem flex/grid. Por que nenhuma imagem: o Gmail bloqueia remota
// por padrão e o e-mail chegaria vazio — a marca é tipografia e cor.

'use strict';

/** Texto vindo do banco (nome de pessoa) entra escapado, nunca cru. */
function escaparHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Um único layout: marca, saudação, chamada, botão e rodapé.
 *
 * O link aparece DUAS vezes de propósito — no botão e escrito por extenso.
 * Cliente que não renderiza o botão, ou quem precisa copiar a URL para outro
 * navegador, continua conseguindo entrar.
 *
 * @param {{marca:string, saudacao:string, chamada:string, link:string,
 *          botao:string, rodape:string, cor?:string}} args
 */
function montarHtmlEmail({ marca, saudacao, chamada, link, botao, rodape, cor = '#2c66e9' }) {
  const c = escaparHtml(cor);
  return `<!doctype html>
<html lang="pt-BR"><body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2430;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;">
  <tr><td style="padding:32px 28px 8px;">
    <p style="margin:0 0 4px;font-size:18px;font-weight:600;color:${c};">${escaparHtml(marca)}</p>
    <p style="margin:16px 0 0;font-size:15px;line-height:22px;">${escaparHtml(saudacao)}</p>
    <p style="margin:12px 0 0;font-size:15px;line-height:22px;">${escaparHtml(chamada)}</p>
  </td></tr>
  <tr><td style="padding:24px 28px;">
    <a href="${escaparHtml(link)}" style="display:inline-block;padding:12px 24px;background:${c};color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:8px;">${escaparHtml(botao)}</a>
  </td></tr>
  <tr><td style="padding:0 28px 28px;">
    <p style="margin:0;font-size:13px;line-height:20px;color:#5b6472;">Se o botão não abrir, copie este endereço no navegador:<br>
      <a href="${escaparHtml(link)}" style="color:${c};word-break:break-all;">${escaparHtml(link)}</a>
    </p>
    <p style="margin:16px 0 0;font-size:13px;line-height:20px;color:#5b6472;">${escaparHtml(rodape)}</p>
  </td></tr>
</table>
</body></html>`;
}

module.exports = { escaparHtml, montarHtmlEmail };
