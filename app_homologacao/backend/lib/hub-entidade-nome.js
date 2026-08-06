/**
 * Nome de exibição das entidades do hub.
 *
 * A "entidade" do hub é uma referência LÓGICA a `Empresa` do legado (sem FK —
 * ver 0022_empresa_grupo_movee.sql: "a entidade de origem mora fora do banco
 * do hub"; em homolog/test a tabela é o espelho da 0033, em produção é a
 * própria `Empresa` do chatmasterveloz). `Empresa` tem GRANT de SELECT sem
 * RLS para o role da app, então uma busca batched por id resolve os nomes.
 *
 * O nome é decoração de UX (crítica impeccable #2, P1 "entidades sem nome"):
 * falha na busca degrada para mapa vazio e a borda devolve `nome: null` — a
 * UI cai no fallback "Empresa #id", nunca um 500.
 */

'use strict';

const { hubPostgrestRequest } = require('./hub-postgrest');

/**
 * Busca `nome_empresa` para um conjunto de ids de entidade em 1 request.
 * @param {number[]} ids - ids de empresa (duplicatas e não-inteiros ignorados)
 * @param {object} [claims] - claims do request corrente (assinatura do JWT por requisição)
 * @returns {Promise<Map<number, string>>} id -> nome (vazio em falha)
 */
async function buscarNomesEntidades(ids, claims) {
  const unicos = [...new Set((ids || []).filter((n) => Number.isInteger(n)))];
  if (unicos.length === 0) return new Map();
  try {
    const linhas = await hubPostgrestRequest(
      `Empresa?id=in.(${unicos.join(',')})&select=id,nome_empresa`,
      'GET',
      null,
      claims
    );
    return new Map((linhas || []).map((e) => [e.id, e.nome_empresa || null]));
  } catch (e) {
    console.warn('[hub-entidade-nome] falha ao buscar nomes de entidades:', e.message);
    return new Map();
  }
}

module.exports = { buscarNomesEntidades };
