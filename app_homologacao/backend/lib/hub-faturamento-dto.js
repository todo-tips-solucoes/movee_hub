/**
 * hub-faturamento-dto.js — helpers PUROS (sem I/O) de borda de API para o
 * módulo Faturamento (S6, tasks.md 3.1/4.1): mapper snake_case -> camelCase
 * da lista de lançamentos, parsing/validação de filtros e paginação.
 *
 * Extraído para arquivo próprio (não inline em routes/hub-faturamento.js)
 * para ser testável isoladamente sem PostgREST/DB real (node --test), mesmo
 * padrão de lib/hub-importacoes-dto.js / lib/hub-motoristas-dto.js.
 *
 * Ref: contracts/faturamento-api.md, data-model.md, research.md Decision 7.
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
 * Parseia/valida os filtros comuns a `GET /faturamento` e
 * `GET /faturamento/resumo` (contracts/faturamento-api.md).
 *
 * - `de`/`ate`: default = hoje-30dias / hoje (`YYYY-MM-DD`, UTC); se
 *   informados, MUST ser datas válidas (senão `DATA_INVALIDA`).
 * - `entregadorId`: inteiro positivo; ausente = sem filtro.
 * - `comEntregador`: `'true'|'false'` (string da query) -> boolean|null.
 * - Contraditório (FR-002/contrato): `entregadorId` presente E
 *   `comEntregador === 'false'` -> `FILTRO_CONTRADITORIO` (um entregador
 *   específico nunca é um lançamento sem entregador).
 *
 * @param {object} query - `req.query`
 * @param {() => Date} [agora] - injeção de tempo p/ testes determinísticos
 * @returns {{ok:true, de:string, ate:string, categoria:string|null,
 *   entregadorId:number|null, subpraca:string|null, comEntregador:boolean|null}
 *   | {ok:false, erro:'DATA_INVALIDA'|'ENTREGADOR_ID_INVALIDO'|'FILTRO_CONTRADITORIO'}}
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

  const categoria = typeof q.categoria === 'string' && q.categoria ? q.categoria : null;
  const subpraca = typeof q.subpraca === 'string' && q.subpraca ? q.subpraca : null;

  let entregadorId = null;
  if (q.entregadorId !== undefined && q.entregadorId !== null && q.entregadorId !== '') {
    const parsed = Number(q.entregadorId);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return { ok: false, erro: 'ENTREGADOR_ID_INVALIDO' };
    }
    entregadorId = parsed;
  }

  let comEntregador = null;
  if (q.comEntregador === 'true') comEntregador = true;
  else if (q.comEntregador === 'false') comEntregador = false;

  if (entregadorId !== null && comEntregador === false) {
    return { ok: false, erro: 'FILTRO_CONTRADITORIO' };
  }

  return { ok: true, de, ate, categoria, entregadorId, subpraca, comEntregador };
}

/**
 * Parseia `page`/`pageSize` da query em paginação Range PostgREST
 * (0-indexed, inclusive) — mesmo padrão de
 * hub-importacoes-dto.js/hub-motoristas-dto.js#parsePaginacao.
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
 * Mapeia 1 linha `FaturamentoLancamento` (PostgREST, já com `valor::text` e
 * `entregador:Entregador(nome)` embutidos no `select`) para o shape de item
 * de lista do contrato (camelCase). `comEntregador` é derivado
 * (`entregador_id !== null`) — mesma convenção de `aguardandoLock` em
 * `hub-importacoes-dto.js`.
 * @param {object} row
 * @returns {object}
 */
function mapFaturamentoListItem(row) {
  const comEntregador = row.entregador_id !== null && row.entregador_id !== undefined;
  return {
    id: row.id,
    dataReferencia: row.data_referencia,
    dataLancamento: row.data_lancamento,
    dataRepasse: row.data_repasse,
    categoria: row.descricao,
    valor: row.valor,
    entregadorId: comEntregador ? row.entregador_id : null,
    entregadorNome: comEntregador && row.entregador ? row.entregador.nome : null,
    subpraca: row.subpraca,
    praca: row.praca,
    periodo: row.periodo,
    comEntregador,
  };
}

module.exports = {
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  JANELA_PADRAO_DIAS,
  dataValida,
  parseFiltros,
  parsePaginacao,
  mapFaturamentoListItem,
};
