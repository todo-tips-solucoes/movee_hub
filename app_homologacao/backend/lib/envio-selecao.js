'use strict';

/**
 * Disparo por seleção — interpretação do campo `ids` do corpo de
 * POST /start-process (impeccable rodada 6).
 *
 * Vive aqui, e não inline na rota, porque `server.js` chama `app.listen()` no
 * import e por isso não é importável por teste (ver
 * tests/hub-envio-massa-permission-unit.test.js). Como esta é a fronteira de
 * confiança de um caminho que envia mensagem para motorista real, ela precisa
 * de verificação executável — mesma razão de `lib/envio-gate.js` existir.
 *
 * Três casos, e a diferença entre eles importa:
 *
 *   - campo AUSENTE  -> `ids: null`, dispara o movimento aberto inteiro. É o
 *                       comportamento histórico da rota, preservado.
 *   - lista VÁLIDA   -> dispara só para aqueles registros.
 *   - lista VAZIA    -> RECUSADA (400), e não tratada como "ausente". O
 *                       frontend omite o campo quando não há seleção; um `[]`
 *                       chegando aqui é bug de quem chama, e o resultado
 *                       seguro de um bug é não disparar nada — jamais expandir
 *                       silenciosamente para o movimento todo, que é
 *                       exatamente o acidente que o disparo por seleção
 *                       existe para evitar.
 *
 * O escopo multi-tenant NÃO passa por aqui: continua resolvido a partir do
 * token na rota (constitution §I-III). Estes IDs apenas restringem dentro do
 * que a empresa já podia disparar.
 */
function parseIdsSelecionados(body) {
  const ids = body && body.ids;

  if (ids === undefined || ids === null) {
    return { ok: true, ids: null };
  }

  if (!Array.isArray(ids)) {
    return { ok: false, erro: 'Lista de registros inválida: esperado um array de IDs.' };
  }

  if (ids.length === 0) {
    return { ok: false, erro: 'Nenhum registro selecionado para o disparo.' };
  }

  if (!ids.every((v) => Number.isInteger(v) && v > 0)) {
    return { ok: false, erro: 'Lista de registros inválida: IDs devem ser inteiros positivos.' };
  }

  return { ok: true, ids };
}

module.exports = { parseIdsSelecionados };
