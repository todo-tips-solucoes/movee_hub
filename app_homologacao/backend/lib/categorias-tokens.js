'use strict';
/**
 * categorias-tokens.js — validação ÚNICA dos tokens das listas de categorias
 * (adiantamento e campanha). Espelha o banco (0131): `hub_adiantamento_familias()`.
 *  - `modo:todas` (no máx. 1): as demais entradas viram EXCEÇÕES. Só o adiantamento aceita.
 *  - `familia:<x>` com x em FAMILIAS. Outro `modo:*`/`familia:*` é inválido (fail-closed).
 *  - qualquer outra string é nome exato de categoria (sem trim/upper).
 */
const FAMILIAS = ['familia:promocao', 'familia:missoes', 'familia:indicador'];
const MODO_TODAS = 'modo:todas';

const tam = (s) => Array.from(s).length;

/** @returns {string[]|null} lista sem repetição, ou null se inválida. */
function lerCategorias(v, { min = 0, max = 1000, maxNome = Infinity, permiteModo = false } = {}) {
  if (!Array.isArray(v) || v.length < min || v.length > max) return null;
  const out = [];
  for (const item of v) {
    if (typeof item !== 'string' || tam(item) < 1 || tam(item) > maxNome) return null;
    if (item.startsWith('modo:') && !(permiteModo && item === MODO_TODAS)) return null;
    if (item.startsWith('familia:') && !FAMILIAS.includes(item)) return null;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

module.exports = { FAMILIAS, MODO_TODAS, lerCategorias };
