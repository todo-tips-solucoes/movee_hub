// Envio de e-mail pelo Resend — usado pela recuperação de senha do app do
// motorista (2026-09-25).
//
// POR QUE RESEND E NÃO SMTP: o VPSTodo só deixa sair 587+STARTTLS (25 e 465 são
// filtradas), e um alerta que falha calado parece "sem falha". O Resend é API
// HTTPS, então não esbarra nesse filtro.
//
// A credencial vive em arquivo, fora do git, montado no serviço — mesmo padrão
// das chaves VAPID do push (`VAPID_KEYS_FILE`), que já roda em produção.

const fs = require('node:fs');

const CAMINHO_PADRAO = process.env.RESEND_CONFIG_FILE || '/var/lib/hub_secrets/resend.producao.json';
let cacheConfig;

/** Lê a config uma vez e guarda. Erro aqui NÃO derruba o processo: o envio
 *  falha e quem chamou decide — recuperação de senha indisponível é ruim, mas
 *  backend fora do ar é pior. */
function lerConfig(caminho = CAMINHO_PADRAO) {
  if (cacheConfig !== undefined) return cacheConfig;
  try {
    const bruto = JSON.parse(fs.readFileSync(caminho, 'utf8'));
    cacheConfig = bruto && bruto.apiKey && bruto.remetente ? bruto : null;
  } catch {
    cacheConfig = null;
  }
  return cacheConfig;
}

/** Só para teste: permite trocar a config sem tocar no disco. */
function _definirConfigParaTeste(config) {
  cacheConfig = config;
}

/**
 * Envia um e-mail. Devolve `{ ok, id?, erro? }` — NUNCA lança, porque quem
 * chama está no meio de um fluxo que não pode quebrar por causa do provedor.
 *
 * `fetchImpl` é injetável só para teste — nunca receber de input de cliente.
 */
async function enviarEmail({ para, assunto, texto, html }, fetchImpl = fetch) {
  const cfg = lerConfig();
  if (!cfg) return { ok: false, erro: 'CONFIG_AUSENTE' };
  if (!para || !assunto) return { ok: false, erro: 'DADOS_INVALIDOS' };

  try {
    const resp = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: cfg.remetente,
        to: [para],
        ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}),
        subject: assunto,
        ...(texto ? { text: texto } : {}),
        ...(html ? { html } : {}),
      }),
    });
    const corpo = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      // O erro do provedor vai para o log do servidor, nunca para o cliente:
      // ele pode conter o endereço de destino.
      console.error('[resend] envio recusado:', resp.status, corpo && corpo.message);
      return { ok: false, erro: 'RECUSADO', status: resp.status };
    }
    return { ok: true, id: corpo.id || null };
  } catch (e) {
    console.error('[resend] falha de rede no envio:', e.message);
    return { ok: false, erro: 'REDE' };
  }
}

module.exports = { enviarEmail, lerConfig, _definirConfigParaTeste, CAMINHO_PADRAO };
