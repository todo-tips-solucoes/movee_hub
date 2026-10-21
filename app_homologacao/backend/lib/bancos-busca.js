'use strict';

/**
 * Busca de banco pelo nome que o motorista conhece (Nubank, PicPay...), tolerante
 * a acento. Camada SOBRE a fixture COMPE: a fixture não muda (FR-003).
 * Segurança: o termo é só comparado com startsWith/includes — nunca vira chave
 * de objeto, RegExp nem log.
 */
const { normalizarNome } = require('./hub-motoristas-dto');

// Fonte única dos apelidos. Chaves já normalizadas; a ordem dos códigos é a ordem
// de exibição (o banco que recebe repasse primeiro).
const APELIDOS_BANCOS = {
  nubank: ['260'],
  'mercado pago': ['323'],
  picpay: ['380', '079', '469'],
  inter: ['077'],
  c6: ['336', '626'],
};

const MAX_TERMO = 60;

function normalizarTermo(texto) {
  const t = normalizarNome(String(texto == null ? '' : texto).slice(0, MAX_TERMO))
    .replace(/\s+/g, ' ')
    .trim();
  // U+00B4 (´) sobrevive ao NFD: sem letra/dígito, o termo não filtra nada.
  return /[\p{L}\p{N}]/u.test(t) ? t : '';
}

function buscarBancos(todos, termo, limite = 20) {
  const t = normalizarTermo(termo);
  if (!t) return todos.slice(0, limite);

  const porCodigo = new Map(todos.map((b) => [b.codigo, b]));
  const vistos = new Set();
  const saida = [];
  const add = (b) => {
    if (b && !vistos.has(b.codigo)) { vistos.add(b.codigo); saida.push(b); }
  };

  todos.forEach((b) => { if (b.codigo.startsWith(t)) add(b); });
  Object.keys(APELIDOS_BANCOS).forEach((apelido) => {
    if (apelido.startsWith(t)) APELIDOS_BANCOS[apelido].forEach((c) => add(porCodigo.get(c)));
  });
  const nomes = todos.map((b) => [b, normalizarNome(b.nome)]);
  nomes.forEach(([b, n]) => { if (n.startsWith(t)) add(b); });
  nomes.forEach(([b, n]) => { if (n.includes(t)) add(b); });

  return saida.slice(0, limite);
}

module.exports = { APELIDOS_BANCOS, normalizarTermo, buscarBancos };
