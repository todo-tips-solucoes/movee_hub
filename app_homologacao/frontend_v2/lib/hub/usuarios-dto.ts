// hub-auditoria-admin (S9) FASE 5.2 task 5.2.1 — tipos + parse/validação de
// shape para o contrato `/api/v1/usuarios`.
//
// Mesmo padrão de `lib/hub/faturamento-dto.ts`: NÃO há tradução de
// snake_case↔camelCase aqui — `routes/hub-usuarios.js` já mapeia para
// camelCase antes de responder. Este arquivo (a) espelha os tipos do
// contrato em TS e (b) valida defensivamente o SHAPE da resposta no fetch.
//
// Ref: docs/specs/hub-auditoria-admin/contracts/usuarios-api.md,
// docs/specs/hub-auditoria-admin/plan.md §Convenções de Borda.

function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function isNumberOrNull(v: unknown): v is number | null {
  return v === null || typeof v === 'number';
}
function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

// ────────────────────────────────────────────────────────────────────────────
// Vínculo (usado em GET /usuarios, POST /usuarios, POST/PUT vinculos)
// ────────────────────────────────────────────────────────────────────────────

export interface UsuarioVinculo {
  id: number;
  entidadeId: number;
  /** Nome de exibição da entidade — null quando o backend não resolveu. */
  entidadeNome: string | null;
  papelId: number | null;
  papel: string | null;
  ativo: boolean;
}

function parseUsuarioVinculo(raw: unknown): UsuarioVinculo {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    id: typeof r.id === 'number' ? r.id : 0,
    entidadeId: typeof r.entidadeId === 'number' ? r.entidadeId : 0,
    entidadeNome: isStringOrNull(r.entidadeNome) ? r.entidadeNome : null,
    papelId: isNumberOrNull(r.papelId) ? r.papelId : null,
    papel: isStringOrNull(r.papel) ? r.papel : null,
    ativo: r.ativo === true,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /usuarios — lista paginada
// ────────────────────────────────────────────────────────────────────────────

export interface UsuarioListItem {
  id: number;
  nome: string;
  email: string;
  ativo: boolean;
  vinculos: UsuarioVinculo[];
}

export interface UsuarioListResponse {
  usuarios: UsuarioListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export function parseUsuarioListItem(raw: unknown): UsuarioListItem {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Item de usuário inválido: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'number' || !isString(r.nome)) {
    throw new TypeError('Item de usuário inválido: id/nome ausentes');
  }
  return {
    id: r.id,
    nome: r.nome,
    email: isString(r.email) ? r.email : '',
    ativo: r.ativo === true,
    vinculos: Array.isArray(r.vinculos) ? r.vinculos.map(parseUsuarioVinculo) : [],
  };
}

export function parseUsuarioListResponse(raw: unknown): UsuarioListResponse {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Resposta de usuários inválida: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.usuarios)) {
    throw new TypeError('Resposta de usuários inválida: usuarios não é array');
  }
  return {
    usuarios: r.usuarios.map(parseUsuarioListItem),
    total: typeof r.total === 'number' ? r.total : 0,
    page: typeof r.page === 'number' ? r.page : 1,
    pageSize: typeof r.pageSize === 'number' ? r.pageSize : r.usuarios.length,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// POST /usuarios — resposta { usuario: {...} }
// ────────────────────────────────────────────────────────────────────────────

export interface UsuarioCriado {
  id: number;
  nome: string;
  email: string;
  vinculos: UsuarioVinculo[];
}

export function parseUsuarioCriadoResponse(raw: unknown): UsuarioCriado {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const u = (r.usuario && typeof r.usuario === 'object' ? r.usuario : {}) as Record<string, unknown>;
  return {
    id: typeof u.id === 'number' ? u.id : 0,
    nome: isString(u.nome) ? u.nome : '',
    email: isString(u.email) ? u.email : '',
    vinculos: Array.isArray(u.vinculos) ? u.vinculos.map(parseUsuarioVinculo) : [],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// PUT /usuarios/:id — resposta { usuario: {...} } (sem vinculos)
// ────────────────────────────────────────────────────────────────────────────

export interface UsuarioEditado {
  id: number;
  nome: string;
  email: string;
  ativo: boolean;
}

export function parseUsuarioEditadoResponse(raw: unknown): UsuarioEditado {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const u = (r.usuario && typeof r.usuario === 'object' ? r.usuario : {}) as Record<string, unknown>;
  return {
    id: typeof u.id === 'number' ? u.id : 0,
    nome: isString(u.nome) ? u.nome : '',
    email: isString(u.email) ? u.email : '',
    ativo: u.ativo === true,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// POST /usuarios/:id/vinculos — resposta { vinculo: {...} }
// PUT /usuarios/:id/vinculos/:vinculoId — resposta { vinculo: {...} }
// ────────────────────────────────────────────────────────────────────────────

export function parseVinculoResponse(raw: unknown): UsuarioVinculo {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return parseUsuarioVinculo(r.vinculo);
}
