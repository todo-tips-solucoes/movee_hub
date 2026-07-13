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
  /** uuid canônico (planilha de origem) — visível/copiável (FR-016). */
  idExterno: string;
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
    idExterno: isString(r.idExterno) ? r.idExterno : '',
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
  /** FASE 5 (task 5.5) — estado da CREDENCIAL de acesso ao app
   * (ContaMotorista.ativo), independente de `MotoristaDetalhe.ativo`
   * (situação do próprio motorista/Entregador — FR-015/FR-018). */
  ativo: boolean;
}

// FASE 6 (tasks.md 6.4/6.5) — histórico read-only de atividades
// correlacionadas por uuid (faturamento/performance/validação de NF),
// paginação técnica offset/limit (dec-046).
export type TipoAtividade = 'faturamento' | 'performance' | 'validacao_nf';

export interface Atividade {
  tipo: TipoAtividade;
  data: string | null;
  descricao: string | null;
  valor: number | null;
}

export interface AtividadesPaginadas {
  items: Atividade[];
  total: number;
  offset: number;
  limit: number;
}

export interface MotoristaDetalhe {
  id: number;
  nome: string;
  /** uuid canônico (planilha de origem) — visível/copiável (FR-016). */
  idExterno: string;
  ativo: boolean;
  nomeEditadoManualmente: boolean;
  areas: MotoristaArea[];
  resumo: MotoristaResumo;
  vinculo: MotoristaVinculo | null;
  atividades: AtividadesPaginadas;
}

function parseVinculo(raw: unknown): MotoristaVinculo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.contaMotoristaId !== 'number' || !isString(r.nome)) return null;
  return {
    contaMotoristaId: r.contaMotoristaId,
    nome: r.nome,
    cnpjPrestadorMascarado: isString(r.cnpjPrestadorMascarado) ? r.cnpjPrestadorMascarado : '',
    ativo: r.ativo === true,
  };
}

function parseArea(raw: unknown): MotoristaArea {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    subpraca: isString(r.subpraca) ? r.subpraca : '',
    dataMaisRecente: isStringOrNull(r.dataMaisRecente) ? r.dataMaisRecente : null,
  };
}

const TIPOS_ATIVIDADE: TipoAtividade[] = ['faturamento', 'performance', 'validacao_nf'];

function parseAtividade(raw: unknown): Atividade | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const tipo = isString(r.tipo) && (TIPOS_ATIVIDADE as string[]).includes(r.tipo) ? (r.tipo as TipoAtividade) : null;
  if (!tipo) return null;
  return {
    tipo,
    data: isStringOrNull(r.data) ? r.data : null,
    descricao: isStringOrNull(r.descricao) ? r.descricao : null,
    valor: isNumberOrNull(r.valor) ? r.valor : null,
  };
}

function parseAtividadesPaginadas(raw: unknown): AtividadesPaginadas {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const items = Array.isArray(r.items) ? r.items.map(parseAtividade).filter((a): a is Atividade => a !== null) : [];
  return {
    items,
    total: typeof r.total === 'number' ? r.total : items.length,
    offset: typeof r.offset === 'number' ? r.offset : 0,
    limit: typeof r.limit === 'number' ? r.limit : items.length,
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
    idExterno: isString(r.idExterno) ? r.idExterno : '',
    ativo: r.ativo === true,
    nomeEditadoManualmente: r.nomeEditadoManualmente === true,
    areas: Array.isArray(r.areas) ? r.areas.map(parseArea) : [],
    resumo: {
      totalFaturamento: isNumberOrNull(resumoRaw.totalFaturamento) ? (resumoRaw.totalFaturamento ?? 0) : 0,
      totalPerformance: isNumberOrNull(resumoRaw.totalPerformance) ? (resumoRaw.totalPerformance ?? 0) : 0,
      dataMaisRecente: isStringOrNull(resumoRaw.dataMaisRecente) ? resumoRaw.dataMaisRecente : null,
    },
    vinculo: parseVinculo(r.vinculo),
    atividades: parseAtividadesPaginadas(r.atividades),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /motoristas/areas — subpraças distintas (opções do combobox de filtro)
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
// POST /motoristas — cadastro manual com uuid obrigatório (FASE 4, task 4.1)
// ────────────────────────────────────────────────────────────────────────────

export interface CriarMotoristaResponse {
  id: number;
  idExterno: string;
  nome: string;
  ativo: boolean;
}

export function parseCriarMotoristaResponse(raw: unknown): CriarMotoristaResponse {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Resposta de criação de motorista inválida: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'number' || !isString(r.nome) || !isString(r.idExterno)) {
    throw new TypeError('Resposta de criação de motorista inválida: id/nome/idExterno ausentes');
  }
  return {
    id: r.id,
    idExterno: r.idExterno,
    nome: r.nome,
    ativo: r.ativo === true,
  };
}

// Mesmo formato validado pelo backend (`uuidValido`,
// lib/hub-import-normalizer.js:233) — validação client-side ANTES de
// submeter (task 4.3.1), nunca a única linha de defesa (o backend
// revalida sempre).
const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidValido(valor: string): boolean {
  return REGEX_UUID.test(valor.trim());
}

// ────────────────────────────────────────────────────────────────────────────
// Origem do vínculo (auditoria — aditivo/opcional, Decision 9)
// ────────────────────────────────────────────────────────────────────────────

export type OrigemVinculo = 'sugestao' | 'busca_manual';

// ────────────────────────────────────────────────────────────────────────────
// FASE 5 — Credencial de acesso ao app do motorista (tasks.md 5.1/5.2/5.3;
// contracts/api-motorista-canonico.md §WS-C Credencial).
// ────────────────────────────────────────────────────────────────────────────

export interface CriarCredencialResponse {
  id: number;
  /** Já mascarado pelo backend (LGPD, mesmo padrão de `cnpjPrestadorMascarado`). */
  cnpjPrestador: string;
  ativo: boolean;
  /** Só presente quando a senha foi AUTO-gerada pelo backend (nenhuma
   * `senhaInicial` foi enviada no corpo) — ausente quando o caller já
   * informou a própria senha inicial. */
  senhaTemporaria?: string;
}

export function parseCriarCredencialResponse(raw: unknown): CriarCredencialResponse {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Resposta de criação de credencial inválida: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'number' || !isString(r.cnpjPrestador)) {
    throw new TypeError('Resposta de criação de credencial inválida: id/cnpjPrestador ausentes');
  }
  return {
    id: r.id,
    cnpjPrestador: r.cnpjPrestador,
    ativo: r.ativo === true,
    senhaTemporaria: isString(r.senhaTemporaria) ? r.senhaTemporaria : undefined,
  };
}

export interface ResetCredencialResponse {
  ok: boolean;
  /** Token de definição de nova senha — devolvido UMA ÚNICA vez, expira em
   * 60 minutos, uso único (contracts §POST reset-senha). */
  tokenDefinicao: string;
}

export function parseResetCredencialResponse(raw: unknown): ResetCredencialResponse {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Resposta de redefinição de senha inválida: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (!isString(r.tokenDefinicao)) {
    throw new TypeError('Resposta de redefinição de senha inválida: tokenDefinicao ausente');
  }
  return { ok: r.ok === true, tokenDefinicao: r.tokenDefinicao };
}

export interface AtualizarCredencialResponse {
  id: number;
  ativo: boolean;
}

export function parseAtualizarCredencialResponse(raw: unknown): AtualizarCredencialResponse {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Resposta de atualização de credencial inválida: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'number') {
    throw new TypeError('Resposta de atualização de credencial inválida: id ausente');
  }
  return { id: r.id, ativo: r.ativo === true };
}
