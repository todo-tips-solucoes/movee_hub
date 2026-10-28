'use strict';
// Quem o disparo em lote pode alcancar. Chave unica "ha nota a emitir" = EnvioMassa.valor > 0 — a mesma do app do
// motorista (routes/motorista.js VALOR_EMITIVEL) e do lote do repasse. Sem isto o WhatsApp mandava "emita NF de R$ 0,00"
// para um movimento so-gorjeta que o app esconde. `ids` so RESTRINGE (nunca amplia).
const { toNumberBR } = require('./numero-br');

const valorEmissivel = (n) => Number.isFinite(n) && n > 0;

function selecionarAlvoDisparo(data, ids) {
  const selecionados = ids && ids.length ? new Set(ids) : null;
  return (data || []).filter((item) => {
    if (selecionados && !selecionados.has(item.id)) return false;
    return valorEmissivel(toNumberBR(item.valor));
  });
}

// Regra de ENTRADA (import/correcao): recusa so quando nao ha nada a pagar nem a emitir; valor 0 + gorjeta e planilha legitima.
const linhaSemNada = (valor, gorjeta) => !valorEmissivel(valor) && !(Number(gorjeta) > 0);

module.exports = { selecionarAlvoDisparo, valorEmissivel, linhaSemNada };
