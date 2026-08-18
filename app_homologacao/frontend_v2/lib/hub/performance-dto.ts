// hub-performance (S7) FASE 5 task 5.1 — tipos + parse/validação de shape
// para o contrato `/api/v1/performance*`.
//
// Mesmo padrão de `lib/hub/faturamento-dto.ts`: NÃO há tradução de
// snake_case↔camelCase aqui — `routes/hub-performance.js` já mapeia para
// camelCase no próprio backend via `lib/hub-performance-dto.js` ANTES de
// responder (contracts/performance-api.md). Este arquivo (a) espelha os
// tipos do contrato em TS e (b) valida defensivamente o SHAPE da resposta
// no fetch — nunca confiar cegamente que a rede devolveu exatamente o que
// o contrato promete.
//
// `taxas`/`taxasReais`/`taxaAceitacao`/`taxaConclusao`/`tempoDisponivelMedio`
// são **string decimal** nos agregados (research.md Decision 7) — NUNCA
// converter para `number`/recalcular no cliente; o backend já agrega tudo
// via RPC (`hub_performance_totais`/`hub_performance_agrupado`), o
// frontend só formata para exibição. `null` explícito é um valor de
// negócio válido ("indicador indisponível", SC-009) — NUNCA tratar como
// `0`/`1` calculado incorretamente.
//
// Ref: docs/specs/hub-performance/contracts/performance-api.md,
// docs/specs/hub-performance/data-model.md, docs/specs/hub-performance/research.md.

function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}
function isNumberOrNull(v: unknown): v is number | null {
  return v === null || typeof v === 'number';
}

// ────────────────────────────────────────────────────────────────────────────
// GET /performance — lista paginada
// ────────────────────────────────────────────────────────────────────────────

export interface PerformanceListItem {
  id: number;
  dataPeriodo: string;
  periodo: string | null;
  /** Sempre presente (nunca `null`) — `entregador_id` é `NOT NULL` desde a
   * origem (Decision 4); não há bucket equivalente a "agregados/bônus". */
  entregadorId: number;
  entregadorNome: string | null;
  subpraca: string | null;
  praca: string | null;
  corridasOfertadas: number;
  corridasAceitas: number;
  corridasRejeitadas: number;
  corridasCompletadas: number;
  corridasCanceladas: number;
  pedidosConcluidos: number | null;
  /** Percentual bruto da linha (sem cálculo próprio) — `null` se ausente. */
  tempoDisponivelPct: number | null;
  /** String decimal (ex.: "132.54") — nunca somar/converter no cliente. */
  taxas: string;
}

export interface PerformanceListResponse {
  items: PerformanceListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export function parsePerformanceListItem(raw: unknown): PerformanceListItem {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Item de performance inválido: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'number' || !isString(r.dataPeriodo)) {
    throw new TypeError('Item de performance inválido: id/dataPeriodo ausentes');
  }
  return {
    id: r.id,
    dataPeriodo: r.dataPeriodo,
    periodo: isStringOrNull(r.periodo) ? r.periodo : null,
    entregadorId: typeof r.entregadorId === 'number' ? r.entregadorId : 0,
    entregadorNome: isStringOrNull(r.entregadorNome) ? r.entregadorNome : null,
    subpraca: isStringOrNull(r.subpraca) ? r.subpraca : null,
    praca: isStringOrNull(r.praca) ? r.praca : null,
    corridasOfertadas: typeof r.corridasOfertadas === 'number' ? r.corridasOfertadas : 0,
    corridasAceitas: typeof r.corridasAceitas === 'number' ? r.corridasAceitas : 0,
    corridasRejeitadas: typeof r.corridasRejeitadas === 'number' ? r.corridasRejeitadas : 0,
    corridasCompletadas: typeof r.corridasCompletadas === 'number' ? r.corridasCompletadas : 0,
    corridasCanceladas: typeof r.corridasCanceladas === 'number' ? r.corridasCanceladas : 0,
    pedidosConcluidos: isNumberOrNull(r.pedidosConcluidos) ? r.pedidosConcluidos : null,
    tempoDisponivelPct: isNumberOrNull(r.tempoDisponivelPct) ? r.tempoDisponivelPct : null,
    taxas: isString(r.taxas) ? r.taxas : '0.00',
  };
}

export function parsePerformanceListResponse(raw: unknown): PerformanceListResponse {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Resposta de lista de performance inválida: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.items)) {
    throw new TypeError('Resposta de lista de performance inválida: items não é array');
  }
  return {
    items: r.items.map(parsePerformanceListItem),
    total: typeof r.total === 'number' ? r.total : 0,
    page: typeof r.page === 'number' ? r.page : 1,
    pageSize: typeof r.pageSize === 'number' ? r.pageSize : r.items.length,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /performance?grao=turno — a lista PADRÃO (migration 0051)
//
// A linha do arquivo importado é a fatia de UMA praça dentro do turno, mas a
// meta é cadastrada por praça × TURNO. Listar por linha fazia a tela emitir
// dois vereditos para o mesmo turno de quem roda em duas praças — e o card,
// que sempre agregou por turno, mostrava um terceiro número. Ver
// docs/plans/performance-linha-por-turno.md §2.
//
// Não há `id`: o turno é um agregado, não uma linha gravada. A identidade é
// `chave` = `entregadorId|dataPeriodo|periodo`.
// ────────────────────────────────────────────────────────────────────────────

/** Uma fatia de praça DENTRO do turno — o detalhe, não a unidade. */
export interface PerformancePracaDoTurno {
  subpraca: string | null;
  praca: string | null;
  /** % do PERÍODO nesta praça (0..100). Somável entre as praças do turno —
   *  é isso que faz as fatias fecharem no total do turno. `null` = sem leitura. */
  tempoDisponivelPct: number | null;
  corridasOfertadas: number;
  corridasAceitas: number;
  corridasCompletadas: number;
  /** String decimal — nunca somar/converter no cliente. */
  taxas: string;
}

export interface PerformanceTurnoItem {
  /** `entregadorId|dataPeriodo|periodo` — identidade do turno. */
  chave: string;
  dataPeriodo: string;
  periodo: string | null;
  entregadorId: number;
  entregadorNome: string | null;
  /** Praça PREDOMINANTE do turno (mais tempo online) — a que resolve a meta,
   *  porque a meta é por praça × turno e o veredito é um só. */
  praca: string | null;
  corridasOfertadas: number;
  corridasAceitas: number;
  corridasRejeitadas: number;
  corridasCompletadas: number;
  corridasCanceladas: number;
  pedidosConcluidos: number | null;
  /** % do período no turno inteiro (praças somadas, teto 100). `null` = sem
   *  leitura — NUNCA `0`, que seria uma afirmação sobre o desempenho. */
  tempoDisponivelPct: number | null;
  taxas: string;
  pracas: PerformancePracaDoTurno[];
}

export interface PerformanceTurnoListResponse {
  items: PerformanceTurnoItem[];
  total: number;
  page: number;
  pageSize: number;
}

function parsePracaDoTurno(raw: unknown): PerformancePracaDoTurno {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    subpraca: isStringOrNull(r.subpraca) ? r.subpraca : null,
    praca: isStringOrNull(r.praca) ? r.praca : null,
    tempoDisponivelPct: isNumberOrNull(r.tempoDisponivelPct) ? r.tempoDisponivelPct : null,
    corridasOfertadas: typeof r.corridasOfertadas === 'number' ? r.corridasOfertadas : 0,
    corridasAceitas: typeof r.corridasAceitas === 'number' ? r.corridasAceitas : 0,
    corridasCompletadas: typeof r.corridasCompletadas === 'number' ? r.corridasCompletadas : 0,
    taxas: isString(r.taxas) ? r.taxas : '0.00',
  };
}

export function parsePerformanceTurnoItem(raw: unknown): PerformanceTurnoItem {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Turno de performance inválido: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (!isString(r.chave) || !isString(r.dataPeriodo)) {
    throw new TypeError('Turno de performance inválido: chave/dataPeriodo ausentes');
  }
  return {
    chave: r.chave,
    dataPeriodo: r.dataPeriodo,
    periodo: isStringOrNull(r.periodo) ? r.periodo : null,
    entregadorId: typeof r.entregadorId === 'number' ? r.entregadorId : 0,
    entregadorNome: isStringOrNull(r.entregadorNome) ? r.entregadorNome : null,
    praca: isStringOrNull(r.praca) ? r.praca : null,
    corridasOfertadas: typeof r.corridasOfertadas === 'number' ? r.corridasOfertadas : 0,
    corridasAceitas: typeof r.corridasAceitas === 'number' ? r.corridasAceitas : 0,
    corridasRejeitadas: typeof r.corridasRejeitadas === 'number' ? r.corridasRejeitadas : 0,
    corridasCompletadas: typeof r.corridasCompletadas === 'number' ? r.corridasCompletadas : 0,
    corridasCanceladas: typeof r.corridasCanceladas === 'number' ? r.corridasCanceladas : 0,
    pedidosConcluidos: isNumberOrNull(r.pedidosConcluidos) ? r.pedidosConcluidos : null,
    tempoDisponivelPct: isNumberOrNull(r.tempoDisponivelPct) ? r.tempoDisponivelPct : null,
    taxas: isString(r.taxas) ? r.taxas : '0.00',
    pracas: Array.isArray(r.pracas) ? r.pracas.map(parsePracaDoTurno) : [],
  };
}

export function parsePerformanceTurnoListResponse(raw: unknown): PerformanceTurnoListResponse {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Resposta de turnos de performance inválida: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.items)) {
    throw new TypeError('Resposta de turnos de performance inválida: items não é array');
  }
  return {
    items: r.items.map(parsePerformanceTurnoItem),
    total: typeof r.total === 'number' ? r.total : 0,
    page: typeof r.page === 'number' ? r.page : 1,
    pageSize: typeof r.pageSize === 'number' ? r.pageSize : r.items.length,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /performance/areas — subpraças distintas (opções do combobox de filtro)
// ────────────────────────────────────────────────────────────────────────────

export function parseAreasResponse(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Resposta de áreas inválida: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.areas)) {
    throw new TypeError('Resposta de áreas inválida: areas não é array');
  }
  return r.areas.filter(isString);
}

// ────────────────────────────────────────────────────────────────────────────
// GET /performance/resumo — sem groupBy (cards, FR-003)
// ────────────────────────────────────────────────────────────────────────────

export interface PerformanceResumoCards {
  corridasCompletadas: number;
  /** String decimal (ex.: "0.8333") ou `null` quando `Σofertadas = 0`
   * (SC-009) — "indicador indisponível", NUNCA `0`/`1` calculado. */
  taxaAceitacao: string | null;
  /** String decimal ou `null` quando `Σaceitas = 0` (SC-009). */
  taxaConclusao: string | null;
  /** String decimal ponderada pela duração do turno (dec-011) ou `null`
   * quando não há turno com duração no filtro. */
  tempoDisponivelMedio: string | null;
  /** String decimal — nunca somar/converter no cliente. */
  taxasReais: string;
}

export function parsePerformanceResumoCards(raw: unknown): PerformanceResumoCards {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    corridasCompletadas: typeof r.corridasCompletadas === 'number' ? r.corridasCompletadas : 0,
    taxaAceitacao: isStringOrNull(r.taxaAceitacao) ? r.taxaAceitacao : null,
    taxaConclusao: isStringOrNull(r.taxaConclusao) ? r.taxaConclusao : null,
    tempoDisponivelMedio: isStringOrNull(r.tempoDisponivelMedio) ? r.tempoDisponivelMedio : null,
    taxasReais: isString(r.taxasReais) ? r.taxasReais : '0.00',
  };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /performance/resumo — com groupBy (agrupado, FR-004)
// ────────────────────────────────────────────────────────────────────────────

export type PerformanceGroupBy = 'dia' | 'periodo' | 'entregador';

export interface PerformanceResumoGrupo {
  chave: string;
  rotulo: string;
  quantidade: number;
  corridasCompletadas: number;
  taxaAceitacao: string | null;
  taxaConclusao: string | null;
  tempoDisponivelMedio: string | null;
  taxasReais: string;
}

export interface PerformanceResumoAgrupado {
  groupBy: PerformanceGroupBy;
  grupos: PerformanceResumoGrupo[];
}

function parsePerformanceResumoGrupo(raw: unknown): PerformanceResumoGrupo {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    chave: isString(r.chave) ? r.chave : '',
    rotulo: isString(r.rotulo) ? r.rotulo : '',
    quantidade: typeof r.quantidade === 'number' ? r.quantidade : 0,
    corridasCompletadas: typeof r.corridasCompletadas === 'number' ? r.corridasCompletadas : 0,
    taxaAceitacao: isStringOrNull(r.taxaAceitacao) ? r.taxaAceitacao : null,
    taxaConclusao: isStringOrNull(r.taxaConclusao) ? r.taxaConclusao : null,
    tempoDisponivelMedio: isStringOrNull(r.tempoDisponivelMedio) ? r.tempoDisponivelMedio : null,
    taxasReais: isString(r.taxasReais) ? r.taxasReais : '0.00',
  };
}

const GROUP_BY_VALIDOS: PerformanceGroupBy[] = ['dia', 'periodo', 'entregador'];

export function parsePerformanceResumoAgrupado(raw: unknown): PerformanceResumoAgrupado {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Resposta de resumo agrupado inválida: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.grupos)) {
    throw new TypeError('Resposta de resumo agrupado inválida: grupos não é array');
  }
  const groupBy = isString(r.groupBy) && GROUP_BY_VALIDOS.includes(r.groupBy as PerformanceGroupBy)
    ? (r.groupBy as PerformanceGroupBy)
    : 'dia';
  return {
    groupBy,
    grupos: r.grupos.map(parsePerformanceResumoGrupo),
  };
}
