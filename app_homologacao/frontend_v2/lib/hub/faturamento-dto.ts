// hub-faturamento (S6) FASE 6 task 6.1 — tipos + parse/validação de shape
// para o contrato `/api/v1/faturamento*`.
//
// Mesmo padrão de `lib/hub/motoristas-dto.ts`: NÃO há tradução de
// snake_case↔camelCase aqui — `routes/hub-faturamento.js` já mapeia para
// camelCase no próprio backend via `lib/hub-faturamento-dto.js` ANTES de
// responder (contracts/faturamento-api.md). Este arquivo (a) espelha os
// tipos do contrato em TS e (b) valida defensivamente o SHAPE da resposta
// no fetch — nunca confiar cegamente que a rede devolveu exatamente o que
// o contrato promete.
//
// `valor`/`total`/`totalGeral` são **string decimal** (research.md
// Decision 7) — NUNCA converter para `number`/somar no cliente. O
// backend já soma tudo via RPC/agregação; o frontend só formata para
// exibição (`formatBRL` aceita string).
//
// Ref: docs/specs/hub-faturamento/contracts/faturamento-api.md,
// docs/specs/hub-faturamento/plan.md §Convenções de Borda.

function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

// ────────────────────────────────────────────────────────────────────────────
// GET /faturamento — lista paginada
// ────────────────────────────────────────────────────────────────────────────

export interface FaturamentoListItem {
  id: number;
  dataReferencia: string;
  dataLancamento: string | null;
  dataRepasse: string | null;
  categoria: string | null;
  /** String decimal (ex.: "61.50") — nunca somar no cliente. */
  valor: string;
  entregadorId: number | null;
  entregadorNome: string | null;
  subpraca: string | null;
  praca: string | null;
  periodo: string | null;
  comEntregador: boolean;
}

export interface FaturamentoListResponse {
  items: FaturamentoListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export function parseFaturamentoListItem(raw: unknown): FaturamentoListItem {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Item de faturamento inválido: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'number' || !isString(r.dataReferencia)) {
    throw new TypeError('Item de faturamento inválido: id/dataReferencia ausentes');
  }
  return {
    id: r.id,
    dataReferencia: r.dataReferencia,
    dataLancamento: isStringOrNull(r.dataLancamento) ? r.dataLancamento : null,
    dataRepasse: isStringOrNull(r.dataRepasse) ? r.dataRepasse : null,
    categoria: isStringOrNull(r.categoria) ? r.categoria : null,
    valor: isString(r.valor) ? r.valor : '0.00',
    entregadorId: typeof r.entregadorId === 'number' ? r.entregadorId : null,
    entregadorNome: isStringOrNull(r.entregadorNome) ? r.entregadorNome : null,
    subpraca: isStringOrNull(r.subpraca) ? r.subpraca : null,
    praca: isStringOrNull(r.praca) ? r.praca : null,
    periodo: isStringOrNull(r.periodo) ? r.periodo : null,
    comEntregador: r.comEntregador === true,
  };
}

export function parseFaturamentoListResponse(raw: unknown): FaturamentoListResponse {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Resposta de lista de faturamento inválida: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.items)) {
    throw new TypeError('Resposta de lista de faturamento inválida: items não é array');
  }
  return {
    items: r.items.map(parseFaturamentoListItem),
    total: typeof r.total === 'number' ? r.total : 0,
    page: typeof r.page === 'number' ? r.page : 1,
    pageSize: typeof r.pageSize === 'number' ? r.pageSize : r.items.length,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /faturamento/resumo — sem groupBy (cards, FR-003)
// ────────────────────────────────────────────────────────────────────────────

export interface FaturamentoResumoCards {
  /** String decimal — nunca somar/converter no cliente. */
  totalGeral: string;
  /** `null` quando não há nenhum lançamento no filtro (FR-012) ou quando
   * há empate — dec-014: o backend resolve o desempate alfabético, o
   * frontend só exibe o que veio. */
  categoriaMaiorValor: string | null;
  entregadoresDistintos: number;
}

export function parseFaturamentoResumoCards(raw: unknown): FaturamentoResumoCards {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    totalGeral: isString(r.totalGeral) ? r.totalGeral : '0.00',
    categoriaMaiorValor: isStringOrNull(r.categoriaMaiorValor) ? r.categoriaMaiorValor : null,
    entregadoresDistintos: typeof r.entregadoresDistintos === 'number' ? r.entregadoresDistintos : 0,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /faturamento/resumo — com groupBy (agrupado, FR-004)
// ────────────────────────────────────────────────────────────────────────────

export type FaturamentoGroupBy = 'dia' | 'categoria' | 'entregador';

/** Chave literal do bucket agregados/bônus — dec-010/CHAVE_AGREGADOS_BONUS
 * no backend. Lançamentos sem `entregadorId` (FR-005) sempre caem aqui. */
export const CHAVE_AGREGADOS_BONUS = 'agregados_bonus';

export interface FaturamentoResumoGrupo {
  chave: string;
  rotulo: string;
  /** String decimal — nunca somar/converter no cliente. */
  total: string;
  quantidade: number;
}

export interface FaturamentoResumoAgrupado {
  groupBy: FaturamentoGroupBy;
  grupos: FaturamentoResumoGrupo[];
}

function parseFaturamentoResumoGrupo(raw: unknown): FaturamentoResumoGrupo {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    chave: isString(r.chave) ? r.chave : '',
    rotulo: isString(r.rotulo) ? r.rotulo : '',
    total: isString(r.total) ? r.total : '0.00',
    quantidade: typeof r.quantidade === 'number' ? r.quantidade : 0,
  };
}

const GROUP_BY_VALIDOS: FaturamentoGroupBy[] = ['dia', 'categoria', 'entregador'];

export function parseFaturamentoResumoAgrupado(raw: unknown): FaturamentoResumoAgrupado {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Resposta de resumo agrupado inválida: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.grupos)) {
    throw new TypeError('Resposta de resumo agrupado inválida: grupos não é array');
  }
  const groupBy = isString(r.groupBy) && GROUP_BY_VALIDOS.includes(r.groupBy as FaturamentoGroupBy)
    ? (r.groupBy as FaturamentoGroupBy)
    : 'categoria';
  return {
    groupBy,
    grupos: r.grupos.map(parseFaturamentoResumoGrupo),
  };
}
