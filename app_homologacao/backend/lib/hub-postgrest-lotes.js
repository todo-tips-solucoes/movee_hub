// repasse-saldo-minimo (F1) — lib/hub-postgrest-lotes.js
//
// Helper genérico para buscar `campoId=in.(...)` no PostgREST do hub em lotes
// de até `tamanhoLote` ids, agregando os resultados. Um `in.()` grande já
// estourou o header do PostgREST em produção (PR #50,
// `upsertMotoristasFromLote` em server.js:1560) — mesma cautela aqui.
//
// Reusa `hubPostgrestRequest` (lib/hub-postgrest.js) — sem cliente HTTP novo
// (spec.md FR-001..FR-005; research.md Decision 1).
'use strict';

const { hubPostgrestRequest } = require('./hub-postgrest');

/**
 * @param {string} caminho - recurso PostgREST, com `select`/filtros extras já
 *   presentes se necessário (ex.: `Entregador?select=id,id_externo`).
 * @param {Array<string|number>} ids - ids a buscar; duplicados e
 *   `null`/`undefined` são ignorados antes do chunking.
 * @param {{campoId: string, tamanhoLote?: number, claims?: object}} opts -
 *   `claims` é repassado a `hubPostgrestRequest` (necessário quando a tabela
 *   tem RLS por escopo, ex. `Entregador` — migration 0015).
 * @returns {Promise<any[]>} linhas agregadas de todos os lotes (`[]` se
 *   nenhum id válido em `ids`).
 *
 * Falha total, nunca parcial: se qualquer lote rejeitar, esta função rejeita
 * imediatamente — nenhum resultado de lotes já buscados é devolvido. A rota
 * chamadora decide o formato do erro (ex.: `502 { erro: 'ERRO_SERVIDOR' }`).
 */
async function buscarEmLotes(caminho, ids, { campoId, tamanhoLote = 100, claims = {} } = {}) {
  if (!campoId) throw new Error('buscarEmLotes: opts.campoId é obrigatório');

  const unicos = [...new Set((ids || []).filter((id) => id !== null && id !== undefined))];
  if (unicos.length === 0) return [];

  const separador = caminho.includes('?') ? '&' : '?';
  const resultado = [];
  for (let i = 0; i < unicos.length; i += tamanhoLote) {
    const fatia = unicos.slice(i, i + tamanhoLote);
    const parte = await hubPostgrestRequest(`${caminho}${separador}${campoId}=in.(${fatia.join(',')})`, 'GET', null, claims);
    resultado.push(...(parte || []));
  }
  return resultado;
}

module.exports = { buscarEmLotes };
