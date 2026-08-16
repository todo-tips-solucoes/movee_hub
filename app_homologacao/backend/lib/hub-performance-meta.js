// impeccable r24 parte 2 — lógica pura das metas de performance.
//
// Aqui mora a única coisa desta feature que é fácil de errar em silêncio: a
// UNIDADE. A API de performance não usa uma escala só
// (contracts/performance-api.md, research.md Decision 7):
//
//   taxaAceitacao / taxaConclusao  -> FRAÇÃO 0..1     ("0.8333")
//   tempoDisponivelPct / Medio     -> PERCENTUAL 0..100 ("87.42")
//
// As metas são gravadas SEMPRE como fração 0..1 (migration 0048, com CHECK).
// Comparar o `tempo_disponivel` sem dividir por 100 faria 87,42 parecer
// 8742% e reprovaria — ou aprovaria — a operação inteira sem ninguém notar.
// É por isso que a conversão está isolada numa função com teste, e não
// espalhada nos chamadores.

const INDICADORES = Object.freeze(['aceitacao', 'conclusao', 'tempo_disponivel']);

/** Indicadores cuja LEITURA vem em 0..100 e precisa virar fração. */
const INDICADORES_EM_PERCENTUAL = Object.freeze(['tempo_disponivel']);

/**
 * Converte o valor que a API de performance reporta para a MESMA unidade das
 * metas (fração 0..1).
 *
 * @param {string|number|null} valorApi
 * @param {string} indicador
 * @returns {number|null} fração 0..1, ou null quando não há valor (o hub nunca
 *   transforma "não sei" em 0 — mesma gramática de `formatFracaoPct`).
 */
function normalizarLeitura(valorApi, indicador) {
  if (valorApi === null || valorApi === undefined || valorApi === '') return null;
  const num = typeof valorApi === 'string' ? Number.parseFloat(valorApi) : valorApi;
  if (!Number.isFinite(num)) return null;
  return INDICADORES_EM_PERCENTUAL.includes(indicador) ? num / 100 : num;
}

/**
 * Valida uma meta vinda do cliente. Devolve `{ ok: true, meta }` ou
 * `{ ok: false, erro }` — nunca lança, porque a rota traduz o erro em 400 com
 * mensagem de negócio (distinguir negócio de infra é regra do projeto).
 */
function validarMeta(bruto) {
  if (!bruto || typeof bruto !== 'object') return { ok: false, erro: 'META_INVALIDA' };

  const praca = typeof bruto.praca === 'string' ? bruto.praca.trim() : '';
  const periodo = typeof bruto.periodo === 'string' ? bruto.periodo.trim() : '';
  const indicador = typeof bruto.indicador === 'string' ? bruto.indicador : '';

  if (!praca) return { ok: false, erro: 'PRACA_OBRIGATORIA' };
  if (!periodo) return { ok: false, erro: 'PERIODO_OBRIGATORIO' };
  if (!INDICADORES.includes(indicador)) return { ok: false, erro: 'INDICADOR_INVALIDO' };

  const valor = typeof bruto.valor === 'string' ? Number.parseFloat(bruto.valor) : bruto.valor;
  if (!Number.isFinite(valor)) return { ok: false, erro: 'VALOR_INVALIDO' };
  // A fronteira que impede o erro por fator 100 chegar ao banco. O CHECK da
  // 0048 é a última linha de defesa; esta é a que produz mensagem legível.
  if (valor < 0 || valor > 1) return { ok: false, erro: 'VALOR_FORA_DA_FAIXA' };

  return { ok: true, meta: { praca, periodo, indicador, valor } };
}

/**
 * Casa um registro de turno com a meta do seu cruzamento praça × turno.
 *
 * @param {object} registro - item de `GET /performance` (camelCase do DTO)
 * @param {Map<string, number>} metasPorChave - `chaveMeta()` -> valor (fração)
 * @returns {{indicador: string, valor: number, meta: number, abaixo: boolean}[]}
 *   Só os indicadores que TÊM meta definida e leitura disponível. Sem meta não
 *   há julgamento — a tela não inventa patamar.
 */
function avaliarRegistro(registro, metasPorChave) {
  const leituras = [
    ['aceitacao', razaoInteira(registro.corridasAceitas, registro.corridasOfertadas)],
    ['conclusao', razaoInteira(registro.corridasCompletadas, registro.corridasAceitas)],
    ['tempo_disponivel', normalizarLeitura(registro.tempoDisponivelPct, 'tempo_disponivel')],
  ];

  const resultado = [];
  for (const [indicador, valor] of leituras) {
    if (valor === null) continue;
    const meta = metasPorChave.get(chaveMeta(registro.praca, registro.periodo, indicador));
    if (meta === undefined) continue;
    resultado.push({ indicador, valor, meta, abaixo: valor < meta });
  }
  return resultado;
}

/** Razão entre contadores inteiros; sem denominador não há razão (nunca 0). */
function razaoInteira(parte, todo) {
  if (parte === null || parte === undefined || todo === null || todo === undefined) return null;
  if (!(todo > 0)) return null;
  return parte / todo;
}

/**
 * Chave do cruzamento. `praca`/`periodo` são texto livre vindo da planilha de
 * origem, então a comparação normaliza caixa e espaços nas pontas — "SAO
 * PAULO" e "Sao Paulo " são a mesma praça para efeito de meta. Acento NÃO é
 * removido: praças diferentes podem se distinguir por ele, e achatar isso
 * fundiria duas configurações legítimas numa só.
 */
function chaveMeta(praca, periodo, indicador) {
  const p = typeof praca === 'string' ? praca.trim().toLowerCase() : '';
  const t = typeof periodo === 'string' ? periodo.trim().toLowerCase() : '';
  return `${p}|${t}|${indicador}`;
}

module.exports = {
  INDICADORES,
  normalizarLeitura,
  validarMeta,
  avaliarRegistro,
  razaoInteira,
  chaveMeta,
};
