// lib/envio-gate.js — issue #62: gate de saída EXTERNA do fluxo legado de
// envio em massa / validação de NFS-e.
//
// A semântica existe documentada desde a S1 do hub (infra/hub/RUNBOOK.md §4.7
// e .env.hub.*.example) mas nunca era LIDA pelo código — as URLs de produção
// eram hardcoded em server.js (sendMessage/validate-xml-batch). Este módulo
// passa a ser o único ponto de decisão:
//
//   - ENVIO_DRY_RUN=true  → bloqueia ANTES de qualquer chamada externa.
//   - ENVIO_ALLOWLIST     → quando a variável EXISTE (mesmo vazia), somente os
//     hostnames listados (CSV) podem receber chamadas; vazia = bloqueia tudo
//     (fail-closed). Comparação por hostname exato, case-insensitive.
//   - Nenhuma das duas definida (produção hoje) → { bloqueado: false } sempre:
//     comportamento de produção permanece idêntico ao anterior.
//
// `env` é injetável só para teste unitário (default process.env) — nunca
// passar input de cliente aqui.

'use strict';

/**
 * @param {string} url - URL absoluta do destino externo
 * @param {object} [env] - default process.env (injetável em teste)
 * @returns {{bloqueado: boolean, motivo?: string}}
 */
function gateEnvioExterno(url, env) {
  var e = env || process.env;

  if (String(e.ENVIO_DRY_RUN || '').toLowerCase() === 'true') {
    return { bloqueado: true, motivo: 'ENVIO_DRY_RUN=true' };
  }

  if (e.ENVIO_ALLOWLIST !== undefined) {
    var hosts = String(e.ENVIO_ALLOWLIST)
      .split(',')
      .map(function (h) { return h.trim().toLowerCase(); })
      .filter(Boolean);
    var host = null;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch (err) {
      host = null;
    }
    if (!host || hosts.indexOf(host) === -1) {
      return {
        bloqueado: true,
        motivo: 'host fora da ENVIO_ALLOWLIST (' + (host || 'url inválida') + ')',
      };
    }
  }

  return { bloqueado: false };
}

module.exports = { gateEnvioExterno };
