/**
 * hub-performance-dto.js — helpers PUROS (sem I/O) de borda de API para o
 * módulo Performance (S7, tasks.md 2.1/3.1): mapper snake_case -> camelCase
 * da lista de turnos, parsing/validação de filtros e paginação, mapeamento
 * do resumo (cards/agrupado) das RPCs `hub_performance_totais`/`_agrupado`.
 *
 * Extraído para arquivo próprio (não inline em routes/hub-performance.js)
 * para ser testável isoladamente sem PostgREST/DB real (node --test), mesmo
 * padrão de lib/hub-faturamento-dto.js (S6) — feature-irmã mais próxima.
 *
 * Ref: contracts/performance-api.md, data-model.md, research.md Decision 2/3/4/12.
 */

'use strict';

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;
const JANELA_PADRAO_DIAS = 30;

const REGEX_DATA = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` de uma Date, em UTC (evita drift de timezone do host). */
function formatarDataISO(data) {
  return data.toISOString().slice(0, 10);
}

/** `true` se `str` é uma data `YYYY-MM-DD` sintaticamente válida E
 * semanticamente real (rejeita `2026-02-30`). */
function dataValida(str) {
  if (typeof str !== 'string' || !REGEX_DATA.test(str)) return false;
  const [ano, mes, dia] = str.split('-').map(Number);
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  return d.getUTCFullYear() === ano && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia;
}

/**
 * Parseia/valida os filtros comuns a `GET /performance` e
 * `GET /performance/resumo` (contracts/performance-api.md).
 *
 * - `de`/`ate`: default = hoje-30dias / hoje (`YYYY-MM-DD`, UTC), filtra
 *   `data_periodo` — "data do turno" (Cenário 5), MUST ser datas válidas
 *   (senão `DATA_INVALIDA`, incluindo `de > ate`).
 * - `periodo`: igualdade exata com a coluna `periodo` (texto livre, 16
 *   turnos documentados + qualquer valor fora do domínio — Edge Case).
 * - `subpraca`: igualdade exata.
 * - `entregadorId`: inteiro positivo; ausente = sem filtro.
 *
 * @param {object} query - `req.query`
 * @param {() => Date} [agora] - injeção de tempo p/ testes determinísticos
 * @returns {{ok:true, de:string, ate:string, periodo:string|null,
 *   subpraca:string|null, entregadorId:number|null}
 *   | {ok:false, erro:'DATA_INVALIDA'|'ENTREGADOR_ID_INVALIDO'}}
 */
function parseFiltros(query, agora = () => new Date()) {
  const q = query && typeof query === 'object' ? query : {};

  let de = typeof q.de === 'string' && q.de ? q.de : null;
  let ate = typeof q.ate === 'string' && q.ate ? q.ate : null;
  if (de !== null && !dataValida(de)) return { ok: false, erro: 'DATA_INVALIDA' };
  if (ate !== null && !dataValida(ate)) return { ok: false, erro: 'DATA_INVALIDA' };

  if (de === null || ate === null) {
    const fim = agora();
    const inicio = new Date(fim.getTime() - JANELA_PADRAO_DIAS * 24 * 60 * 60 * 1000);
    if (de === null) de = formatarDataISO(inicio);
    if (ate === null) ate = formatarDataISO(fim);
  }

  if (de !== null && ate !== null && de > ate) {
    return { ok: false, erro: 'DATA_INVALIDA' };
  }

  const periodo = typeof q.periodo === 'string' && q.periodo ? q.periodo : null;
  const subpraca = typeof q.subpraca === 'string' && q.subpraca ? q.subpraca : null;

  let entregadorId = null;
  if (q.entregadorId !== undefined && q.entregadorId !== null && q.entregadorId !== '') {
    const parsed = Number(q.entregadorId);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return { ok: false, erro: 'ENTREGADOR_ID_INVALIDO' };
    }
    entregadorId = parsed;
  }

  return { ok: true, de, ate, periodo, subpraca, entregadorId };
}

/**
 * Parseia `page`/`pageSize` da query em paginação Range PostgREST
 * (0-indexed, inclusive) — mesmo padrão de hub-faturamento-dto.js.
 * @param {object} query - `req.query`
 * @returns {{page:number, pageSize:number, from:number, to:number}}
 */
function parsePaginacao(query) {
  const pageParsed = parseInt(query && query.page, 10);
  const page = Number.isFinite(pageParsed) && pageParsed >= 1 ? pageParsed : 1;

  const pageSizeParsed = parseInt(query && query.pageSize, 10);
  const pageSize = Number.isFinite(pageSizeParsed) && pageSizeParsed >= 1
    ? Math.min(pageSizeParsed, PAGE_SIZE_MAX)
    : PAGE_SIZE_DEFAULT;

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  return { page, pageSize, from, to };
}

/**
 * Mapeia 1 linha `PerformanceTurno` (PostgREST, já com `entregador:Entregador(nome)`
 * embutido no `select`) para o shape de item de lista do contrato
 * (camelCase). `entregadorId`/`entregadorNome` SEMPRE presentes (nunca
 * `null` — Decision 4: `entregador_id` é `NOT NULL` desde a origem, sem
 * bucket "sem entregador" equivalente ao "agregados/bônus" do faturamento).
 * `taxas` é `text` fixo (`NULL` -> `"0.00"`, Decision 7);
 * `tempoDisponivelPct` é `number|null` da coluna gerada
 * `tempo_disponivel_periodo_pct` (0050): % do PERÍODO em que a pessoa esteve
 * online nesta linha. Não é mais o `tempo_disponivel_pct` cru — aquele é o
 * `escalado` da origem, que mede sobre o tempo escalado e não é somável entre
 * as praças de um mesmo turno. O nome do campo do contrato não muda: a
 * pergunta que ele responde é a mesma, a conta é que estava errada.
 * @param {object} row
 * @returns {object}
 */
function mapPerformanceListItem(row) {
  return {
    id: row.id,
    dataPeriodo: row.data_periodo,
    periodo: row.periodo,
    entregadorId: row.entregador_id,
    entregadorNome: row.entregador ? row.entregador.nome : null,
    subpraca: row.subpraca,
    praca: row.praca,
    corridasOfertadas: row.corridas_ofertadas,
    corridasAceitas: row.corridas_aceitas,
    corridasRejeitadas: row.corridas_rejeitadas,
    corridasCompletadas: row.corridas_completadas,
    corridasCanceladas: row.corridas_canceladas,
    pedidosConcluidos: row.pedidos_concluidos,
    tempoDisponivelPct: row.tempo_disponivel_periodo_pct === null
      || row.tempo_disponivel_periodo_pct === undefined
      ? null
      : Number(row.tempo_disponivel_periodo_pct),
    taxas: formatarTaxasReais(row.taxas_centavos),
  };
}

/** `taxas_centavos` (int, nullable) -> `text` fixo 2 casas (`NULL` -> `"0.00"`). */
function formatarTaxasReais(taxasCentavos) {
  const centavos = taxasCentavos === null || taxasCentavos === undefined ? 0 : taxasCentavos;
  return (centavos / 100).toFixed(2);
}

const GROUP_BY_VALIDOS = ['dia', 'periodo', 'entregador'];

/** `true` se `valor` é um dos 3 valores aceitos de `groupBy`
 * (contracts/performance-api.md "GET /performance/resumo" — Decision 12,
 * literal `periodo`, não `turno`). */
function groupByValido(valor) {
  return GROUP_BY_VALIDOS.includes(valor);
}

/**
 * Mapeia a linha única retornada por `hub_performance_totais` (RPC, 5
 * campos já como `int`/`text`/`text`/`text`/`text`) para o shape de cards
 * do contrato (FR-003). `row` ausente/undefined (defensivo — a RPC sempre
 * retorna 1 linha, mesmo com filtro vazio) -> shape zerado (FR-011).
 * @param {{corridas_completadas:number, taxa_aceitacao:string|null,
 *   taxa_conclusao:string|null, tempo_disponivel_medio:string|null,
 *   taxas_reais:string}|undefined} row
 * @returns {{corridasCompletadas:number, taxaAceitacao:string|null,
 *   taxaConclusao:string|null, tempoDisponivelMedio:string|null, taxasReais:string}}
 */
function mapResumoCards(row) {
  if (!row) {
    return {
      corridasCompletadas: 0,
      taxaAceitacao: null,
      taxaConclusao: null,
      tempoDisponivelMedio: null,
      taxasReais: '0.00',
    };
  }
  return {
    corridasCompletadas: row.corridas_completadas,
    taxaAceitacao: row.taxa_aceitacao,
    taxaConclusao: row.taxa_conclusao,
    tempoDisponivelMedio: row.tempo_disponivel_medio,
    taxasReais: row.taxas_reais,
  };
}

/**
 * Mapeia as linhas de `hub_performance_agrupado` (RPC) para o shape de
 * `grupos` do contrato (FR-004), resolvendo `rotulo`:
 * - `groupBy` ∈ {`dia`,`periodo`} -> `rotulo === chave` (a própria
 *   data/período, sem lookup).
 * - `groupBy === 'entregador'` (chave = `entregador_id::text`) -> nome via
 *   `nomeMap` (join `Entregador.nome` feito pelo caller, resolvido só para
 *   os ids REALMENTE presentes no resultado — mesmo padrão de
 *   `hub-faturamento-dto.js`).
 * @param {Array<{chave:string, quantidade:number, corridas_completadas:number,
 *   taxa_aceitacao:string|null, taxa_conclusao:string|null,
 *   tempo_disponivel_medio:string|null, taxas_reais:string}>} rows
 * @param {'dia'|'periodo'|'entregador'} groupBy
 * @param {Map<string,string>} [nomeMap] - só usado quando `groupBy==='entregador'`
 * @returns {Array<object>}
 */
function mapResumoAgrupado(rows, groupBy, nomeMap = new Map()) {
  return (rows || []).map((row) => {
    const rotulo = groupBy === 'entregador' ? (nomeMap.get(row.chave) || row.chave) : row.chave;
    return {
      chave: row.chave,
      rotulo,
      quantidade: row.quantidade,
      corridasCompletadas: row.corridas_completadas,
      taxaAceitacao: row.taxa_aceitacao,
      taxaConclusao: row.taxa_conclusao,
      tempoDisponivelMedio: row.tempo_disponivel_medio,
      taxasReais: row.taxas_reais,
    };
  });
}

module.exports = {
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  JANELA_PADRAO_DIAS,
  dataValida,
  parseFiltros,
  parsePaginacao,
  mapPerformanceListItem,
  formatarTaxasReais,
  groupByValido,
  mapResumoCards,
  mapResumoAgrupado,
};
