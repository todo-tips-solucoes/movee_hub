// hub-importacoes (S4) — FASE 6 task 6.4: tipos + parse/validação de shape
// para o contrato `/api/v1/importacoes*`.
//
// Diferença importante em relação a `lib/hub/me-dto.ts`: o backend de
// `/me` devolve snake_case (hub-me.js) e o DTO faz a tradução para
// camelCase. Aqui NÃO há tradução de case — `routes/hub-importacoes.js`
// já mapeia para camelCase no próprio backend via
// `lib/hub-importacoes-dto.js` (`mapImportacaoListItem`/`mapImportacaoDetalhe`/
// `mapErroItem`) ANTES de responder (ver contracts/importacoes-api.md).
// O papel deste arquivo é (a) espelhar os tipos do contrato em TS e (b)
// validar defensivamente o SHAPE da resposta no fetch (6.4.2) — nunca
// confiar cegamente que a rede devolveu exatamente o que o contrato promete.
//
// Ref: docs/specs/hub-importacoes/contracts/importacoes-api.md,
// docs/specs/hub-importacoes/plan.md §Convenções de Borda.

export type TipoImportacao = 'faturamento' | 'performance';

export const TIPOS_IMPORTACAO: TipoImportacao[] = ['faturamento', 'performance'];

export type StatusImportacao =
  | 'pending'
  | 'validating'
  | 'processing'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancelled';

/** Estados em que a UI faz polling (contract §GET /importacoes/:id). */
export const STATUS_EM_ANDAMENTO = new Set<StatusImportacao>(['pending', 'validating', 'processing']);

/** Estados a partir dos quais `POST /:id/reprocessar` é aceito (§contrato). */
export const STATUS_REPROCESSAVEL = new Set<StatusImportacao>(['failed', 'cancelled']);

/** Estados a partir dos quais `POST /:id/cancelar` é aceito (§contrato). */
export const STATUS_CANCELAVEL = new Set<StatusImportacao>(['pending', 'validating', 'processing']);

export const STATUS_LABELS: Record<StatusImportacao, string> = {
  pending: 'Pendente',
  validating: 'Validando',
  processing: 'Processando',
  completed: 'Concluída',
  completed_with_errors: 'Concluída com erros',
  failed: 'Falhou',
  cancelled: 'Cancelada',
};

export const TIPO_LABELS: Record<TipoImportacao, string> = {
  faturamento: 'Faturamento',
  performance: 'Performance',
};

// ────────────────────────────────────────────────────────────────────────────
// GET /importacoes — histórico paginado
// ────────────────────────────────────────────────────────────────────────────

export interface ImportacaoListItem {
  id: number;
  tipo: TipoImportacao;
  status: StatusImportacao;
  nomeArquivo: string | null;
  totalLinhas: number | null;
  linhasValidas: number | null;
  linhasInvalidas: number | null;
  dataReferencia: string | null;
  criadoPor: number | null;
  iniciadoEm: string | null;
  concluidoEm: string | null;
  duracaoSegundos: number | null;
  /** Derivado (dec-032/CHK013) — `pending` esperando o lock de outra
   * importação do mesmo `(id_empresa,tipo)` terminar. */
  aguardandoLock: boolean;
}

export interface ImportacaoListResponse {
  items: ImportacaoListItem[];
  total: number;
  page: number;
  pageSize: number;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function isNumberOrNull(v: unknown): v is number | null {
  return v === null || typeof v === 'number';
}
function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

/**
 * Valida defensivamente 1 item de listagem (6.4.2/6.4.3). Lança
 * `TypeError` em shape claramente incompatível — o caller (6.4.2, fetch)
 * decide se filtra o item ou propaga o erro; nunca deixa passar silencioso
 * um item com `id`/`tipo`/`status` ausente (campos usados como chave/rota).
 */
export function parseImportacaoListItem(raw: unknown): ImportacaoListItem {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Item de importação inválido: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'number' || !isString(r.tipo) || !isString(r.status)) {
    throw new TypeError('Item de importação inválido: id/tipo/status ausentes');
  }
  return {
    id: r.id,
    tipo: r.tipo as TipoImportacao,
    status: r.status as StatusImportacao,
    nomeArquivo: isStringOrNull(r.nomeArquivo) ? r.nomeArquivo : null,
    totalLinhas: isNumberOrNull(r.totalLinhas) ? r.totalLinhas : null,
    linhasValidas: isNumberOrNull(r.linhasValidas) ? r.linhasValidas : null,
    linhasInvalidas: isNumberOrNull(r.linhasInvalidas) ? r.linhasInvalidas : null,
    dataReferencia: isStringOrNull(r.dataReferencia) ? r.dataReferencia : null,
    criadoPor: isNumberOrNull(r.criadoPor) ? r.criadoPor : null,
    iniciadoEm: isStringOrNull(r.iniciadoEm) ? r.iniciadoEm : null,
    concluidoEm: isStringOrNull(r.concluidoEm) ? r.concluidoEm : null,
    duracaoSegundos: isNumberOrNull(r.duracaoSegundos) ? r.duracaoSegundos : null,
    aguardandoLock: r.aguardandoLock === true,
  };
}

export function parseImportacaoListResponse(raw: unknown): ImportacaoListResponse {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Resposta de histórico inválida: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.items)) {
    throw new TypeError('Resposta de histórico inválida: items não é array');
  }
  return {
    items: r.items.map(parseImportacaoListItem),
    total: typeof r.total === 'number' ? r.total : 0,
    page: typeof r.page === 'number' ? r.page : 1,
    pageSize: typeof r.pageSize === 'number' ? r.pageSize : r.items.length,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /importacoes/:id — detalhe + progresso (polling)
// ────────────────────────────────────────────────────────────────────────────

export interface ImportacaoDetalhe {
  id: number;
  tipo: TipoImportacao;
  status: StatusImportacao;
  contadores: {
    total: number | null;
    validas: number | null;
    invalidas: number | null;
  };
  dataReferencia: string | null;
  iniciadoEm: string | null;
  concluidoEm: string | null;
  duracaoSegundos: number | null;
  erroResumo: string | null;
}

export function parseImportacaoDetalhe(raw: unknown): ImportacaoDetalhe {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Detalhe de importação inválido: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'number' || !isString(r.tipo) || !isString(r.status)) {
    throw new TypeError('Detalhe de importação inválido: id/tipo/status ausentes');
  }
  const contadoresRaw = (r.contadores && typeof r.contadores === 'object' ? r.contadores : {}) as Record<
    string,
    unknown
  >;
  return {
    id: r.id,
    tipo: r.tipo as TipoImportacao,
    status: r.status as StatusImportacao,
    contadores: {
      total: isNumberOrNull(contadoresRaw.total) ? contadoresRaw.total : null,
      validas: isNumberOrNull(contadoresRaw.validas) ? contadoresRaw.validas : null,
      invalidas: isNumberOrNull(contadoresRaw.invalidas) ? contadoresRaw.invalidas : null,
    },
    dataReferencia: isStringOrNull(r.dataReferencia) ? r.dataReferencia : null,
    iniciadoEm: isStringOrNull(r.iniciadoEm) ? r.iniciadoEm : null,
    concluidoEm: isStringOrNull(r.concluidoEm) ? r.concluidoEm : null,
    duracaoSegundos: isNumberOrNull(r.duracaoSegundos) ? r.duracaoSegundos : null,
    erroResumo: isStringOrNull(r.erroResumo) ? r.erroResumo : null,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /importacoes/:id/erros — erros paginados
// ────────────────────────────────────────────────────────────────────────────

export interface ImportacaoErroItem {
  numeroLinha: number;
  campo: string | null;
  motivo: string | null;
  /** Já vem mascarado do backend (LGPD) — nunca renderizar outro campo bruto. */
  valorMascarado: string | null;
}

export interface ImportacaoErrosResponse {
  items: ImportacaoErroItem[];
  total: number;
  page: number;
  pageSize: number;
}

export function parseImportacaoErroItem(raw: unknown): ImportacaoErroItem {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Item de erro inválido: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.numeroLinha !== 'number') {
    throw new TypeError('Item de erro inválido: numeroLinha ausente');
  }
  return {
    numeroLinha: r.numeroLinha,
    campo: isStringOrNull(r.campo) ? r.campo : null,
    motivo: isStringOrNull(r.motivo) ? r.motivo : null,
    valorMascarado: isStringOrNull(r.valorMascarado) ? r.valorMascarado : null,
  };
}

export function parseImportacaoErrosResponse(raw: unknown): ImportacaoErrosResponse {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Resposta de erros inválida: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.items)) {
    throw new TypeError('Resposta de erros inválida: items não é array');
  }
  return {
    items: r.items.map(parseImportacaoErroItem),
    total: typeof r.total === 'number' ? r.total : 0,
    page: typeof r.page === 'number' ? r.page : 1,
    pageSize: typeof r.pageSize === 'number' ? r.pageSize : r.items.length,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Validação client-side de upload (6.3.2 — espelha 3.1 do backend)
// ────────────────────────────────────────────────────────────────────────────

export const EXTENSOES_PERMITIDAS = ['.csv', '.zip'];
export const TAMANHO_MAXIMO_BYTES = 20 * 1024 * 1024; // 20 MB — contract §POST /importacoes

export function extensaoDoArquivo(nomeArquivo: string): string {
  const idx = nomeArquivo.lastIndexOf('.');
  return idx === -1 ? '' : nomeArquivo.slice(idx).toLowerCase();
}

export type ValidacaoArquivoResultado =
  | { valido: true }
  | { valido: false; motivo: 'extensao_invalida' | 'tamanho_excedido' | 'arquivo_vazio' };

/** Espelha as 3 primeiras checagens do backend (3.1.1-3.1.3) client-side,
 * ANTES do POST — feedback imediato sem round-trip de rede. O backend
 * PERMANECE a fonte da verdade (defesa em profundidade); esta validação é
 * só UX. */
export function validarArquivoImportacao(file: { name: string; size: number }): ValidacaoArquivoResultado {
  if (file.size === 0) return { valido: false, motivo: 'arquivo_vazio' };
  if (file.size > TAMANHO_MAXIMO_BYTES) return { valido: false, motivo: 'tamanho_excedido' };
  const ext = extensaoDoArquivo(file.name);
  if (!EXTENSOES_PERMITIDAS.includes(ext)) return { valido: false, motivo: 'extensao_invalida' };
  return { valido: true };
}
