/**
 * hub-ordenacao.js — ordenação vinda do cliente, validada por allowlist
 * (impeccable rodada 16, h7=2).
 *
 * Existe por uma razão de segurança antes de qualquer razão de UX: o `order`
 * do PostgREST é interpolado na URL da requisição, então repassar um valor do
 * cliente sem validar entrega ao usuário controle sobre a query — ele poderia
 * ordenar por coluna não exposta no `select` (vazando existência de campo) ou
 * injetar operadores. Aqui a coluna só passa se estiver na allowlist da rota,
 * e a direção só pode ser `asc`/`desc`.
 *
 * Entrada inválida NUNCA é erro 400: cai no padrão da rota. Uma lista que
 * responde 400 porque a URL trazia `ordenarPor=inexistente` transforma um
 * link velho colado no chat em tela quebrada — e a ordem é preferência de
 * exibição, não parte do pedido.
 */

'use strict';

const DIRECOES = ['asc', 'desc'];

/**
 * @param {object} query          req.query
 * @param {string[]} permitidas   colunas que a rota aceita ordenar
 * @param {{coluna: string, direcao: string}} padrao  usado quando falta ou é inválido
 * @returns {{coluna: string, direcao: 'asc'|'desc'}}
 */
function parseOrdenacao(query, permitidas, padrao) {
  const coluna = query && typeof query.ordenarPor === 'string' ? query.ordenarPor : null;
  const direcao = query && typeof query.direcao === 'string' ? query.direcao.toLowerCase() : null;

  const colunaValida = coluna && permitidas.includes(coluna) ? coluna : padrao.coluna;
  // A direção só é considerada quando a COLUNA veio válida: `direcao=desc`
  // sozinho inverteria silenciosamente a ordem padrão da tela, que não foi o
  // que ninguém pediu.
  const direcaoValida =
    coluna && permitidas.includes(coluna) && DIRECOES.includes(direcao) ? direcao : padrao.direcao;

  return { coluna: colunaValida, direcao: direcaoValida };
}

/**
 * Fragmento `order=` do PostgREST. `nullslast` sempre: ausência de valor não é
 * "o menor" nem "o maior" — a linha sem data não deve encabeçar o decrescente
 * fingindo ser a mais recente (mesma decisão da ordenação client-side em
 * `frontend_v2/lib/utils.ts`).
 */
function ordenacaoParaPostgrest({ coluna, direcao }) {
  return `order=${coluna}.${direcao}.nullslast`;
}

module.exports = { parseOrdenacao, ordenacaoParaPostgrest };
