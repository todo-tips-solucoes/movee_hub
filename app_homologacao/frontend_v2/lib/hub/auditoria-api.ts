// hub-auditoria-admin (S9) FASE 5.1 task 5.1.2 — chamadas HTTP para
// `/api/v1/auditoria`.
//
// Mesmo molde de `lib/hub/faturamento-api.ts`: `request<T>()` local (fetch
// nativo + `credentials: 'include'`), `query()` para querystring filtrando
// vazio/undefined, classe de erro própria. Este contrato usa SEMPRE a chave
// `erro` (nunca `error`).
//
// Ref: docs/specs/hub-auditoria-admin/contracts/auditoria-api.md.

import { parseAuditoriaListResponse, type AuditoriaListResponse } from './auditoria-dto';

const HUB_API_BASE = '/api/v1';

const MENSAGENS_CODIGO: Record<string, string> = {
  NAO_AUTENTICADO: 'Sua sessão expirou. Faça login novamente.',
  PERMISSAO_NEGADA: 'Você não tem permissão para esta ação.',
  MODULO_DESABILITADO: 'O módulo de auditoria está desabilitado para esta entidade.',
  PERIODO_INVALIDO: 'Período informado é inválido (data final anterior à inicial).',
  PARAMETRO_INVALIDO: 'Um dos filtros informados é inválido.',
  SERVICO_INDISPONIVEL: 'Serviço de auditoria indisponível. Tente novamente em instantes.',
};

export class AuditoriaApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly codigo?: string
  ) {
    super(message);
    this.name = 'AuditoriaApiError';
  }
}

function mensagemAmigavel(body: Record<string, unknown>, status: number): string {
  const codigo = typeof body.erro === 'string' ? body.erro : undefined;
  if (codigo && MENSAGENS_CODIGO[codigo]) return MENSAGENS_CODIGO[codigo];
  return `Erro ${status}. Tente novamente.`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${HUB_API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const body: unknown = await res.json().catch(() => ({}));
  const bodyObj = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (!res.ok) {
    const codigo = typeof bodyObj.erro === 'string' ? bodyObj.erro : undefined;
    throw new AuditoriaApiError(res.status, mensagemAmigavel(bodyObj, res.status), codigo);
  }
  return body as T;
}

function query<T extends object>(params: T): string {
  const qs = Object.entries(params as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return qs ? `?${qs}` : '';
}

export interface AuditoriaFiltros {
  acao?: string;
  usuarioId?: number;
  recurso?: string;
  de?: string;
  ate?: string;
  /** SÓ admin_plataforma — outros valores fora do próprio escopo → 403. */
  entidadeId?: number;
}

export interface ListarAuditoriaQuery extends AuditoriaFiltros {
  page?: number;
  pageSize?: number;
}

/** `GET /auditoria` — lista paginada, mais recentes primeiro (FR-001/FR-002/FR-003). */
export async function listarAuditoria(filtros: ListarAuditoriaQuery = {}): Promise<AuditoriaListResponse> {
  const raw = await request<unknown>(`/auditoria${query(filtros)}`);
  return parseAuditoriaListResponse(raw);
}
