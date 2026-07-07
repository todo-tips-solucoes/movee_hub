/**
 * hub-import-hash.js — hash_linha determinístico (tasks.md 2.4). Ref:
 * research.md Decision 6 — idempotência é o requisito central (US2).
 *
 * sha256 da linha JÁ NORMALIZADA (não da linha bruta do CSV): como os
 * valores de entrada (`hub-import-normalizer.js`) já passaram por
 * trim/parse/decimal canônico, o hash naturalmente satisfaz "linhas com
 * whitespace/case de origem diferentes mas semanticamente iguais produzem o
 * MESMO hash" (2.4.3) — a canonicalização (uppercase de texto, decimal
 * .toFixed(2) fixo, null->"") acontece de novo aqui como segunda camada,
 * indepentende de qualquer decisão futura do normalizer.
 */

'use strict';

const crypto = require('crypto');

/** Canonicaliza 1 valor para a string que entra no hash. */
function canonicalizarValor(valor) {
  if (valor === null || valor === undefined) return '';
  if (typeof valor === 'number') {
    return Number.isInteger(valor) ? String(valor) : valor.toFixed(2);
  }
  if (typeof valor === 'boolean') return valor ? '1' : '0';
  return String(valor).trim().toUpperCase();
}

/**
 * @param {Record<string, any>} valores - objeto `valores` retornado por
 *   normalizarLinhaFaturamento/normalizarLinhaPerformance
 * @param {string[]} campos - lista ORDENADA de chaves a incluir no hash
 *   (CAMPOS_HASH_FATURAMENTO/CAMPOS_HASH_PERFORMANCE de
 *   hub-import-normalizer.js) — a ordem é parte do contrato de estabilidade
 *   do hash; nunca reordenar em produção sem plano de migração.
 * @returns {string} sha256 hex (64 chars, casa com `char(64) hash_linha`)
 */
function hashLinha(valores, campos) {
  const partes = campos.map((campo) => canonicalizarValor(valores[campo]));
  const base = partes.join('|');
  return crypto.createHash('sha256').update(base, 'utf8').digest('hex');
}

module.exports = { hashLinha, canonicalizarValor };
