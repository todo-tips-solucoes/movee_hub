// hub-auditoria-admin (S9) FASE 5.3/5.4 task 5.3.1 — tipos + parse/validação
// de shape para os contratos `/api/v1/papeis` (matriz papel×permissão) e
// `/api/v1/admin` (módulos por entidade). Um único arquivo cobre os dois
// contratos — mesma decisão de `plan.md` §Project Structure
// ("lib/hub/admin-api.ts/admin-dto.ts cobrindo papéis+módulos").
//
// Mesmo padrão de `lib/hub/faturamento-dto.ts`: NÃO há tradução de
// snake_case↔camelCase aqui — os backends `routes/hub-papeis.js` e
// `routes/hub-admin.js` já mapeiam para camelCase antes de responder. Este
// arquivo (a) espelha os tipos dos contratos em TS e (b) valida
// defensivamente o SHAPE da resposta no fetch.
//
// Ref: docs/specs/hub-auditoria-admin/contracts/papeis-api.md,
// docs/specs/hub-auditoria-admin/contracts/admin-modulos-api.md.

function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

// ────────────────────────────────────────────────────────────────────────────
// GET /papeis — matriz papel × permissão (FR-010)
// ────────────────────────────────────────────────────────────────────────────

export interface PapelCatalogo {
  id: number;
  nome: string;
  escopo: string;
  isSistema: boolean;
}

export interface PermissaoCatalogo {
  id: number;
  codigo: string;
  modulo: string | null;
}

export interface MatrizCelula {
  papelId: number;
  permissaoId: number;
}

export interface PapeisMatrizResponse {
  papeis: PapelCatalogo[];
  permissoes: PermissaoCatalogo[];
  matriz: MatrizCelula[];
  /** `true` somente para admin_plataforma com `admin.gerenciar` (FR-010/dec-008). */
  podeEditar: boolean;
}

function parsePapelCatalogo(raw: unknown): PapelCatalogo {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    id: typeof r.id === 'number' ? r.id : 0,
    nome: isString(r.nome) ? r.nome : '',
    escopo: isString(r.escopo) ? r.escopo : '',
    isSistema: r.isSistema === true,
  };
}

function parsePermissaoCatalogo(raw: unknown): PermissaoCatalogo {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    id: typeof r.id === 'number' ? r.id : 0,
    codigo: isString(r.codigo) ? r.codigo : '',
    modulo: isStringOrNull(r.modulo) ? r.modulo : null,
  };
}

function parseMatrizCelula(raw: unknown): MatrizCelula {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    papelId: typeof r.papelId === 'number' ? r.papelId : 0,
    permissaoId: typeof r.permissaoId === 'number' ? r.permissaoId : 0,
  };
}

export function parsePapeisMatrizResponse(raw: unknown): PapeisMatrizResponse {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Resposta de papéis inválida: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.papeis) || !Array.isArray(r.permissoes) || !Array.isArray(r.matriz)) {
    throw new TypeError('Resposta de papéis inválida: papeis/permissoes/matriz não são array');
  }
  return {
    papeis: r.papeis.map(parsePapelCatalogo),
    permissoes: r.permissoes.map(parsePermissaoCatalogo),
    matriz: r.matriz.map(parseMatrizCelula),
    podeEditar: r.podeEditar === true,
  };
}

export interface TogglePapelPermissaoResponse {
  papelId: number;
  permissaoId: number;
  ativo: boolean;
}

export function parseTogglePapelPermissaoResponse(raw: unknown): TogglePapelPermissaoResponse {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    papelId: typeof r.papelId === 'number' ? r.papelId : 0,
    permissaoId: typeof r.permissaoId === 'number' ? r.permissaoId : 0,
    ativo: r.ativo === true,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /admin/modulos — catálogo de módulos da plataforma
// ────────────────────────────────────────────────────────────────────────────

export interface ModuloCatalogo {
  id: number;
  codigo: string;
  nome: string;
  ordem: number;
  ativo: boolean;
}

function parseModuloCatalogo(raw: unknown): ModuloCatalogo {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    id: typeof r.id === 'number' ? r.id : 0,
    codigo: isString(r.codigo) ? r.codigo : '',
    nome: isString(r.nome) ? r.nome : '',
    ordem: typeof r.ordem === 'number' ? r.ordem : 0,
    ativo: r.ativo === true,
  };
}

export interface ModulosCatalogoResponse {
  modulos: ModuloCatalogo[];
}

export function parseModulosCatalogoResponse(raw: unknown): ModulosCatalogoResponse {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    modulos: Array.isArray(r.modulos) ? r.modulos.map(parseModuloCatalogo) : [],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /admin/entidades/:id/modulos — estado de habilitação por entidade
// ────────────────────────────────────────────────────────────────────────────

export interface ModuloEntidadeItem {
  moduloId: number;
  codigo: string;
  nome: string;
  habilitado: boolean;
}

function parseModuloEntidadeItem(raw: unknown): ModuloEntidadeItem {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    moduloId: typeof r.moduloId === 'number' ? r.moduloId : 0,
    codigo: isString(r.codigo) ? r.codigo : '',
    nome: isString(r.nome) ? r.nome : '',
    habilitado: r.habilitado === true,
  };
}

export interface ModulosEntidadeResponse {
  entidadeId: number;
  modulos: ModuloEntidadeItem[];
}

export function parseModulosEntidadeResponse(raw: unknown): ModulosEntidadeResponse {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Resposta de módulos por entidade inválida: shape não é objeto');
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.modulos)) {
    throw new TypeError('Resposta de módulos por entidade inválida: modulos não é array');
  }
  return {
    entidadeId: typeof r.entidadeId === 'number' ? r.entidadeId : 0,
    modulos: r.modulos.map(parseModuloEntidadeItem),
  };
}

export interface ToggleModuloEntidadeResponse {
  entidadeId: number;
  codigo: string;
  habilitado: boolean;
}

export function parseToggleModuloEntidadeResponse(raw: unknown): ToggleModuloEntidadeResponse {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    entidadeId: typeof r.entidadeId === 'number' ? r.entidadeId : 0,
    codigo: isString(r.codigo) ? r.codigo : '',
    habilitado: r.habilitado === true,
  };
}
