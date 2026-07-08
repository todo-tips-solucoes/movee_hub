/**
 * hub-csv.js — proteção CSV injection compartilhada (extraída de
 * `hub-importacoes-dto.js`, FR-016/CHK017; research.md Decision 6 de
 * hub-faturamento/S6; tasks.md hub-faturamento 2.1). Módulo PURO (sem I/O),
 * reusado por `hub-importacoes-dto.js` e `hub-faturamento-dto.js` — fonte
 * única da verdade para não divergir por drift entre implementações
 * duplicadas (mesma regra exata em ambos os módulos).
 *
 * Ref: contracts/faturamento-api.md; checklists/requirements.md CHK029
 * (gap fechado nesta extração — ver `escaparCelulaCsvInjection` abaixo:
 * célula que já começa com apóstrofo ou qualquer caractere fora de
 * `= + - @` NUNCA sofre neutralização adicional, por construção, já que só
 * os 4 prefixos perigosos disparam o prefixo `'`).
 */

'use strict';

const PREFIXOS_PERIGOSOS = ['=', '+', '-', '@'];

/** Prefixa `'` quando a célula começa com `= + - @` (fórmula/injeção em
 * Excel/Sheets ao abrir o CSV) — regra exata de CHK017/contrato. NÃO altera
 * células que não começam com esses caracteres — em particular, uma célula
 * que já começa com `'` (apóstrofo) ou qualquer outro caractere neutro
 * passa inalterada, sem dupla neutralização (CHK029). */
function escaparCelulaCsvInjection(valor) {
  if (valor === null || valor === undefined) return '';
  const str = String(valor);
  if (str.length > 0 && PREFIXOS_PERIGOSOS.includes(str[0])) {
    return `'${str}`;
  }
  return str;
}

/** Quoting CSV padrão (RFC 4180): envolve em aspas duplas se a célula contém
 * vírgula, aspas ou quebra de linha; aspas internas viram `""`. Aplicado
 * APÓS a proteção de injeção (a célula já pode ter ganhado o prefixo `'`). */
function quotarCelulaCsv(celula) {
  if (/[",\r\n]/.test(celula)) {
    return `"${celula.replace(/"/g, '""')}"`;
  }
  return celula;
}

module.exports = {
  escaparCelulaCsvInjection,
  quotarCelulaCsv,
};
