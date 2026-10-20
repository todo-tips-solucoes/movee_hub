// corrigir-movimento (FR-012): parser numerico BR unico, extraido de server.js sem mudar comportamento.
'use strict';

function toNumberBR(input) {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  const raw = String(input ?? '').trim();
  if (!raw) return NaN;

  const cleaned = raw.replace(/[^\d.,-]/g, '').replace(/\s+/g, '');
  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');

  let normalized = cleaned;
  if (hasComma && hasDot) {
    normalized = cleaned.replace(/\./g, '').replace(',', '.'); // ponto = milhar, vírgula = decimal
  } else if (hasComma) {
    normalized = cleaned.replace(',', '.'); // vírgula como decimal
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : NaN;
}

module.exports = { toNumberBR };
