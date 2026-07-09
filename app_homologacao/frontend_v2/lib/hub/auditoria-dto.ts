// hub-auditoria-admin (S9) FASE 5.1 task 5.1.1 — tipos + parse/validação de
// shape para o contrato `/api/v1/auditoria` (evoluído FASE 3).
//
// Mesmo padrão de `lib/hub/faturamento-dto.ts`: NÃO há tradução de
// snake_case↔camelCase aqui — `routes/hub-me.js` já mapeia para camelCase
// no próprio backend (mapper "linha 371-376", contracts/auditoria-api.md
// "Response 200") ANTES de responder. Este arquivo (a) espelha os tipos do
// contrato em TS e (b) valida defensivamente o SHAPE da resposta no fetch —
// nunca confiar cegamente que a rede devolveu exatamente o que o contrato
// promete.
//
// `detalhes` chega scrubbed por construção no backend
// (`lib/hub-auditoria.js#scrubDetalhes`, FR-004/SC-006) — este DTO NÃO
// re-serializa nem tenta "limpar" o campo de novo; só preserva o objeto
// como veio (ou `{}` se ausente/shape inesperado).
//
// Ref: docs/specs/hub-auditoria-admin/contracts/auditoria-api.md,
// docs/specs/hub-auditoria-admin/plan.md §Convenções de Borda.

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
// GET /auditoria — lista paginada (mais recentes primeiro)
// ────────────────────────────────────────────────────────────────────────────

export interface AuditoriaEvento {
  id: number;
  /** `null` = evento global (visível só para admin_plataforma sem `entidadeId`). */
  entidadeId: number | null;
  usuarioId: number | null;
  acao: string;
  recurso: string;
  /** String por contrato — pode carregar id composto (ex.: `"12:34"`). */
  recursoId: string | null;
  /** Já scrubbed pelo backend (FR-004) — nunca re-serializar/expor bruto. */
  detalhes: Record<string, unknown>;
  ip: string | null;
  criadoEm: string;
}

export interface AuditoriaListResponse {
  eventos: AuditoriaEvento[];
  total: number;
  page: number;
  pageSize: number;
}

export function parseAuditoriaEvento(raw: unknown): AuditoriaEvento {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Evento de auditoria inválido: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'number' || !isString(r.acao) || !isString(r.criadoEm)) {
    throw new TypeError('Evento de auditoria inválido: id/acao/criadoEm ausentes');
  }
  const detalhes =
    r.detalhes && typeof r.detalhes === 'object' && !Array.isArray(r.detalhes)
      ? (r.detalhes as Record<string, unknown>)
      : {};
  return {
    id: r.id,
    entidadeId: isNumberOrNull(r.entidadeId) ? r.entidadeId : null,
    usuarioId: isNumberOrNull(r.usuarioId) ? r.usuarioId : null,
    acao: r.acao,
    recurso: isString(r.recurso) ? r.recurso : '',
    recursoId: isStringOrNull(r.recursoId) ? r.recursoId : null,
    detalhes,
    ip: isStringOrNull(r.ip) ? r.ip : null,
    criadoEm: r.criadoEm,
  };
}

export function parseAuditoriaListResponse(raw: unknown): AuditoriaListResponse {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Resposta de auditoria inválida: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.eventos)) {
    throw new TypeError('Resposta de auditoria inválida: eventos não é array');
  }
  return {
    eventos: r.eventos.map(parseAuditoriaEvento),
    total: typeof r.total === 'number' ? r.total : 0,
    page: typeof r.page === 'number' ? r.page : 1,
    pageSize: typeof r.pageSize === 'number' ? r.pageSize : r.eventos.length,
  };
}
