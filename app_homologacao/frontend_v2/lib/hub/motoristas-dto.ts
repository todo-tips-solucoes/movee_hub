// hub-motoristas (S5) FASE 7 — tipos + parse/validação de shape para o
// contrato `/api/v1/motoristas*`.
//
// Mesmo padrão de `lib/hub/importacoes-dto.ts`: NÃO há tradução de
// snake_case↔camelCase aqui — `routes/hub-motoristas.js` já mapeia para
// camelCase no próprio backend via `lib/hub-motoristas-dto.js` ANTES de
// responder (contracts/motoristas-api.md). Este arquivo (a) espelha os
// tipos do contrato em TS e (b) valida defensivamente o SHAPE da resposta
// no fetch — nunca confiar cegamente que a rede devolveu exatamente o que
// o contrato promete.
//
// Ref: docs/specs/hub-motoristas/contracts/motoristas-api.md,
// docs/specs/hub-motoristas/plan.md §Convenções de Borda.

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
// GET /motoristas — lista paginada
// ────────────────────────────────────────────────────────────────────────────

export interface MotoristaListItem {
  id: number;
  nome: string;
  ativo: boolean;
  comVinculo: boolean;
  areas: string[];
}

export interface MotoristaListResponse {
  items: MotoristaListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export function parseMotoristaListItem(raw: unknown): MotoristaListItem {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Item de motorista inválido: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'number' || !isString(r.nome)) {
    throw new TypeError('Item de motorista inválido: id/nome ausentes');
  }
  return {
    id: r.id,
    nome: r.nome,
    ativo: r.ativo === true,
    comVinculo: r.comVinculo === true,
    areas: Array.isArray(r.areas) ? r.areas.filter(isString) : [],
  };
}

export function parseMotoristaListResponse(raw: unknown): MotoristaListResponse {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Resposta de lista de motoristas inválida: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.items)) {
    throw new TypeError('Resposta de lista de motoristas inválida: items não é array');
  }
  return {
    items: r.items.map(parseMotoristaListItem),
    total: typeof r.total === 'number' ? r.total : 0,
    page: typeof r.page === 'number' ? r.page : 1,
    pageSize: typeof r.pageSize === 'number' ? r.pageSize : r.items.length,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /motoristas/:id — detalhe
// ────────────────────────────────────────────────────────────────────────────

export interface MotoristaArea {
  subpraca: string;
  dataMaisRecente: string | null;
}

export interface MotoristaResumo {
  totalFaturamento: number;
  totalPerformance: number;
  dataMaisRecente: string | null;
}

export interface MotoristaVinculo {
  contaMotoristaId: number;
  nome: string;
  cnpjPrestadorMascarado: string;
}

export interface MotoristaDetalhe {
  id: number;
  nome: string;
  ativo: boolean;
  nomeEditadoManualmente: boolean;
  areas: MotoristaArea[];
  resumo: MotoristaResumo;
  vinculo: MotoristaVinculo | null;
}

function parseVinculo(raw: unknown): MotoristaVinculo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.contaMotoristaId !== 'number' || !isString(r.nome)) return null;
  return {
    contaMotoristaId: r.contaMotoristaId,
    nome: r.nome,
    cnpjPrestadorMascarado: isString(r.cnpjPrestadorMascarado) ? r.cnpjPrestadorMascarado : '',
  };
}

function parseArea(raw: unknown): MotoristaArea {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    subpraca: isString(r.subpraca) ? r.subpraca : '',
    dataMaisRecente: isStringOrNull(r.dataMaisRecente) ? r.dataMaisRecente : null,
  };
}

export function parseMotoristaDetalhe(raw: unknown): MotoristaDetalhe {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Detalhe de motorista inválido: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'number' || !isString(r.nome)) {
    throw new TypeError('Detalhe de motorista inválido: id/nome ausentes');
  }
  const resumoRaw = (r.resumo && typeof r.resumo === 'object' ? r.resumo : {}) as Record<string, unknown>;
  return {
    id: r.id,
    nome: r.nome,
    ativo: r.ativo === true,
    nomeEditadoManualmente: r.nomeEditadoManualmente === true,
    areas: Array.isArray(r.areas) ? r.areas.map(parseArea) : [],
    resumo: {
      totalFaturamento: isNumberOrNull(resumoRaw.totalFaturamento) ? (resumoRaw.totalFaturamento ?? 0) : 0,
      totalPerformance: isNumberOrNull(resumoRaw.totalPerformance) ? (resumoRaw.totalPerformance ?? 0) : 0,
      dataMaisRecente: isStringOrNull(resumoRaw.dataMaisRecente) ? resumoRaw.dataMaisRecente : null,
    },
    vinculo: parseVinculo(r.vinculo),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /motoristas/:id/sugestoes — candidatos automáticos
// ────────────────────────────────────────────────────────────────────────────

export interface MotoristaJaVinculadoA {
  entregadorId: number;
  nome: string;
}

export interface ContaCandidata {
  contaMotoristaId: number;
  nome: string;
  cnpjPrestadorMascarado: string;
  /** Só presente em /sugestoes (corte por similaridade); ausente em
   * /contas-elegiveis (busca manual, sem corte). */
  similaridade?: number;
  jaVinculadoA: MotoristaJaVinculadoA | null;
}

export interface SugestoesResponse {
  items: ContaCandidata[];
  entidadeElegivel: boolean;
}

function parseJaVinculadoA(raw: unknown): MotoristaJaVinculadoA | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.entregadorId !== 'number' || !isString(r.nome)) return null;
  return { entregadorId: r.entregadorId, nome: r.nome };
}

export function parseContaCandidata(raw: unknown): ContaCandidata {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Conta candidata inválida: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.contaMotoristaId !== 'number' || !isString(r.nome)) {
    throw new TypeError('Conta candidata inválida: contaMotoristaId/nome ausentes');
  }
  return {
    contaMotoristaId: r.contaMotoristaId,
    nome: r.nome,
    cnpjPrestadorMascarado: isString(r.cnpjPrestadorMascarado) ? r.cnpjPrestadorMascarado : '',
    similaridade: typeof r.similaridade === 'number' ? r.similaridade : undefined,
    jaVinculadoA: parseJaVinculadoA(r.jaVinculadoA),
  };
}

export function parseSugestoesResponse(raw: unknown): SugestoesResponse {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Resposta de sugestões inválida: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.items)) {
    throw new TypeError('Resposta de sugestões inválida: items não é array');
  }
  return {
    items: r.items.map(parseContaCandidata),
    entidadeElegivel: r.entidadeElegivel === true,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /motoristas/contas-elegiveis — busca manual
// ────────────────────────────────────────────────────────────────────────────

export interface ContasElegiveisResponse {
  items: ContaCandidata[];
  total: number;
  page: number;
  pageSize: number;
  entidadeElegivel: boolean;
}

export function parseContasElegiveisResponse(raw: unknown): ContasElegiveisResponse {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Resposta de contas elegíveis inválida: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.items)) {
    throw new TypeError('Resposta de contas elegíveis inválida: items não é array');
  }
  return {
    items: r.items.map(parseContaCandidata),
    total: typeof r.total === 'number' ? r.total : 0,
    page: typeof r.page === 'number' ? r.page : 1,
    pageSize: typeof r.pageSize === 'number' ? r.pageSize : r.items.length,
    entidadeElegivel: r.entidadeElegivel === true,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// POST /motoristas/:id/vinculo — resposta de sucesso
// ────────────────────────────────────────────────────────────────────────────

export interface VincularResponse {
  id: number;
  vinculo: MotoristaVinculo;
}

export function parseVincularResponse(raw: unknown): VincularResponse {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Resposta de vínculo inválida: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  const vinculo = parseVinculo(r.vinculo);
  if (typeof r.id !== 'number' || !vinculo) {
    throw new TypeError('Resposta de vínculo inválida: id/vinculo ausentes');
  }
  return { id: r.id, vinculo };
}

// ────────────────────────────────────────────────────────────────────────────
// Origem do vínculo (auditoria — aditivo/opcional, Decision 9)
// ────────────────────────────────────────────────────────────────────────────

export type OrigemVinculo = 'sugestao' | 'busca_manual';
