// hub-auditoria-admin (S9) FASE 5.1 task 5.1.2 — chamadas HTTP para
// `/api/v1/auditoria`.
//
// Molde compartilhado em `lib/hub/api.ts` (`criarRequest`/`query`). Este
// contrato usa SEMPRE a chave `erro` (nunca `error`).
//
// Ref: docs/specs/hub-auditoria-admin/contracts/auditoria-api.md.

import { HubApiError, criarRequest, mensagemPorCodigo, codigoDoErro, query } from './api';
import { parseAuditoriaListResponse, type AuditoriaListResponse } from './auditoria-dto';

const MENSAGENS_CODIGO: Record<string, string> = {
  NAO_AUTENTICADO: 'Sua sessão expirou. Faça login novamente.',
  PERMISSAO_NEGADA: 'Você não tem permissão para esta ação.',
  MODULO_DESABILITADO: 'O módulo de auditoria está desabilitado para esta entidade.',
  PERIODO_INVALIDO: 'Período informado é inválido (data final anterior à inicial).',
  PARAMETRO_INVALIDO: 'Um dos filtros informados é inválido.',
  SERVICO_INDISPONIVEL: 'Serviço de auditoria indisponível. Tente novamente em instantes.',
};

export class AuditoriaApiError extends HubApiError {
  readonly name = 'AuditoriaApiError';
}

const request = criarRequest(
  (status, body) =>
    new AuditoriaApiError(status, mensagemPorCodigo(MENSAGENS_CODIGO, body, status), codigoDoErro(body))
);

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
