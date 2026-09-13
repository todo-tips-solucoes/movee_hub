/**
 * hub-push-log.js — hash de endpoint e log seguro compartilhados por
 * `routes/motorista-push.js` (FASE 3) e `lib/hub-push-worker.js` (FASE 5,
 * tasks.md 5.4.1/5.4.2).
 *
 * Extraído de `routes/motorista-push.js` (onde vivia como função local) para
 * não duplicar a mesma lógica no worker — mesma fórmula de `endpoint_hash`
 * usada pela migration 0061/`PushInscricao.endpoint_hash` e pelo contrato de
 * logs (FR-031, contracts/motorista-push.md §Convenções: "nunca o endpoint
 * completo, nem p256dh/auth ou a chave privada — só os 8 primeiros hex do
 * endpoint_hash").
 */

'use strict';

const crypto = require('crypto');

/** sha256 hex do endpoint (chave de idempotência da inscrição, migration 0061). */
function endpointHash(endpoint) {
  return crypto.createHash('sha256').update(String(endpoint)).digest('hex');
}

/** Log seguro: nunca o endpoint/chaves — só os 8 primeiros hex do hash (FR-031). */
function logErro(contexto, err, hash) {
  const prefixo = typeof hash === 'string' ? hash.slice(0, 8) : 'sem-hash';
  console.error(`[hub-push] ${contexto} (endpoint_hash=${prefixo}):`, err && err.message ? err.message : err);
}

/** Log informativo seguro (mesma regra de redação de `logErro`). */
function logInfo(contexto, hash, extra) {
  const prefixo = typeof hash === 'string' ? hash.slice(0, 8) : 'sem-hash';
  if (extra !== undefined) {
    console.log(`[hub-push] ${contexto} (endpoint_hash=${prefixo}):`, extra);
  } else {
    console.log(`[hub-push] ${contexto} (endpoint_hash=${prefixo})`);
  }
}

module.exports = { endpointHash, logErro, logInfo };
