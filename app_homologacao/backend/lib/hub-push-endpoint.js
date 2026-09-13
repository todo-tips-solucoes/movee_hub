/**
 * hub-push-endpoint.js — validação do endpoint/chaves de uma inscrição Web
 * Push e allowlist anti-SSRF de hosts (FASE 2, tasks.md 2.2).
 *
 * O backend faz POST ao `endpoint` que o navegador manda na inscrição
 * (web-push); sem validação isso é SSRF a partir da rede interna, onde
 * estão o PostgREST e o banco (owasp-security achado S2/S6,
 * research.md Decision 10).
 *
 * Regras (contracts/motorista-push.md `PUT /motorista/push/inscricao`):
 * - `endpoint`: URL parseável, `https:`, sem userinfo, sem porta explícita,
 *   até 2.000 caracteres, hostname na allowlist;
 * - `p256dh`: base64url, decodifica para 65 bytes com prefixo `0x04`
 *   (ponto EC não-comprimido);
 *   `auth`: base64url, decodifica para 16 bytes (segredo de autenticação).
 *
 * Allowlist (research.md Decision 10, achado S6): casamento exato ou por
 * sufixo com fronteira de ponto sobre `URL.hostname` em minúsculas.
 * Override só com `ENVIO_ALLOWLIST` definida (ambiente isolado de
 * teste/homolog, para o `push-mock`) — `PUSH_HOSTS_PERMITIDOS` sozinha, em
 * produção, é ignorada (não pode virar bypass da allowlist real). Distinto
 * de `lib/envio-gate.js` (gate de saída do fluxo legado de envio em
 * massa/validação de NFS-e) — reusado como camada adicional no worker de
 * envio (FASE 5), não duplicado aqui.
 *
 * Extraído para arquivo próprio para ser testável isoladamente (node
 * --test), mesmo padrão de lib/hub-avisos-dto.js.
 *
 * Ref: contracts/motorista-push.md, research.md Decision 10.
 */

'use strict';

const ENDPOINT_MAX_CHARS = 2000;
const P256DH_BYTES = 65;
const P256DH_PREFIXO = 0x04;
const AUTH_BYTES = 16;

// Allowlist inicial [PROPOSTA — a validar com endpoints reais observados em
// Chrome/Android, Firefox e Safari/iOS] — research.md Decision 10.
const ALLOWLIST_PADRAO = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  '*.push.apple.com',
  '*.notify.windows.com',
];

const REGEX_BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Allowlist efetiva desta instância: default, ou `PUSH_HOSTS_PERMITIDOS`
 * (CSV) SE `ENVIO_ALLOWLIST` também estiver definida (ambiente
 * teste/homolog isolado — em produção nenhuma das duas é setada, e
 * `PUSH_HOSTS_PERMITIDOS` sozinha nunca substitui a lista real).
 * @param {object} [env] - default `process.env` (injetável em teste)
 * @returns {string[]}
 */
function carregarAllowlist(env) {
  const e = env || process.env;
  if (
    e.ENVIO_ALLOWLIST !== undefined
    && typeof e.PUSH_HOSTS_PERMITIDOS === 'string'
    && e.PUSH_HOSTS_PERMITIDOS.trim() !== ''
  ) {
    return e.PUSH_HOSTS_PERMITIDOS.split(',').map((h) => h.trim()).filter(Boolean);
  }
  return ALLOWLIST_PADRAO.slice();
}

/** Remove o prefixo de documentação `*.` de uma entrada da allowlist. */
function normalizarEntradaAllowlist(entrada) {
  const e = String(entrada || '').trim().toLowerCase();
  return e.startsWith('*.') ? e.slice(2) : e;
}

/**
 * `true` se `hostname` casa com alguma entrada da allowlist — exato, ou por
 * sufixo com fronteira de ponto (`sub.push.apple.com` casa com
 * `*.push.apple.com`; `evil-push.apple.com` NÃO casa — sem o ponto de
 * fronteira, é só coincidência textual).
 * @param {string} hostname
 * @param {string[]} allowlist
 * @returns {boolean}
 */
function hostPermitido(hostname, allowlist) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  return (allowlist || []).some((entradaBruta) => {
    const base = normalizarEntradaAllowlist(entradaBruta);
    if (!base) return false;
    return host === base || host.endsWith(`.${base}`);
  });
}

/** Decodifica base64url; `null` se a string não for base64url puro ou vier vazia. */
function decodificarBase64Url(str) {
  if (typeof str !== 'string' || str === '' || !REGEX_BASE64URL.test(str)) return null;
  try {
    return Buffer.from(str, 'base64url');
  } catch (e) {
    return null;
  }
}

/**
 * Valida a forma da URL do endpoint (sem checar allowlist).
 * @param {*} endpointCru
 * @returns {{ok:true, url:URL}|{ok:false, erro:'DADOS_INVALIDOS', motivo:'endpoint'}}
 */
function validarEndpointUrl(endpointCru) {
  if (typeof endpointCru !== 'string' || !endpointCru || endpointCru.length > ENDPOINT_MAX_CHARS) {
    return { ok: false, erro: 'DADOS_INVALIDOS', motivo: 'endpoint' };
  }
  let url;
  try {
    url = new URL(endpointCru);
  } catch (e) {
    return { ok: false, erro: 'DADOS_INVALIDOS', motivo: 'endpoint' };
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    return { ok: false, erro: 'DADOS_INVALIDOS', motivo: 'endpoint' };
  }
  return { ok: true, url };
}

/**
 * Valida `{ endpoint, keys: { p256dh, auth } }` de
 * `PUT /motorista/push/inscricao` — forma dos 3 campos + allowlist do host.
 * @param {object} corpoCru
 * @param {object} [opts]
 * @param {string[]} [opts.allowlist] - allowlist já resolvida (prioridade sobre `opts.env`)
 * @param {object} [opts.env] - default `process.env`, usado se `allowlist` não for passada
 * @returns {{ok:true, endpoint:string, p256dh:string, auth:string}
 *   | {ok:false, erro:'DADOS_INVALIDOS', motivo:'endpoint'|'p256dh'|'auth'}
 *   | {ok:false, erro:'ENDPOINT_NAO_PERMITIDO'}}
 */
function validarInscricaoPush(corpoCru, opts) {
  const corpo = corpoCru && typeof corpoCru === 'object' ? corpoCru : {};
  const keys = corpo.keys && typeof corpo.keys === 'object' ? corpo.keys : {};

  const endpointResult = validarEndpointUrl(corpo.endpoint);
  if (!endpointResult.ok) return endpointResult;

  const p256dhBuf = decodificarBase64Url(keys.p256dh);
  if (!p256dhBuf || p256dhBuf.length !== P256DH_BYTES || p256dhBuf[0] !== P256DH_PREFIXO) {
    return { ok: false, erro: 'DADOS_INVALIDOS', motivo: 'p256dh' };
  }

  const authBuf = decodificarBase64Url(keys.auth);
  if (!authBuf || authBuf.length !== AUTH_BYTES) {
    return { ok: false, erro: 'DADOS_INVALIDOS', motivo: 'auth' };
  }

  const o = opts || {};
  const allowlist = o.allowlist || carregarAllowlist(o.env);
  if (!hostPermitido(endpointResult.url.hostname, allowlist)) {
    return { ok: false, erro: 'ENDPOINT_NAO_PERMITIDO' };
  }

  return { ok: true, endpoint: corpo.endpoint, p256dh: keys.p256dh, auth: keys.auth };
}

module.exports = {
  ALLOWLIST_PADRAO,
  carregarAllowlist,
  hostPermitido,
  validarEndpointUrl,
  validarInscricaoPush,
  ENDPOINT_MAX_CHARS,
  P256DH_BYTES,
  AUTH_BYTES,
};
