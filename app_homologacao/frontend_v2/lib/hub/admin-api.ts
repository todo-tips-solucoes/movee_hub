// hub-auditoria-admin (S9) FASE 5.3/5.4 task 5.3.2 — chamadas HTTP para
// `/api/v1/papeis` e `/api/v1/admin` (módulos por entidade). Um único
// arquivo cobre os dois contratos (plan.md §Project Structure).
//
// Molde compartilhado em `lib/hub/api.ts` (`criarRequest`), chave `erro`
// sempre. Não usa `query()` — todos os paths daqui são fixos.
//
// Ref: docs/specs/hub-auditoria-admin/contracts/papeis-api.md,
// docs/specs/hub-auditoria-admin/contracts/admin-modulos-api.md.

import { HubApiError, criarRequest, mensagemPorCodigo, codigoDoErro } from './api';
import {
  parseModulosCatalogoResponse,
  parseModulosEntidadeResponse,
  parsePapeisMatrizResponse,
  parseToggleModuloEntidadeResponse,
  parseTogglePapelPermissaoResponse,
  type ModulosCatalogoResponse,
  type ModulosEntidadeResponse,
  type PapeisMatrizResponse,
  type ToggleModuloEntidadeResponse,
  type TogglePapelPermissaoResponse,
} from './admin-dto';

const MENSAGENS_CODIGO: Record<string, string> = {
  NAO_AUTENTICADO: 'Sua sessão expirou. Faça login novamente.',
  PERMISSAO_NEGADA: 'Você não tem permissão para esta ação.',
  MODULO_DESABILITADO: 'Este módulo está desabilitado para a entidade selecionada.',
  DADOS_INVALIDOS: 'Dados informados são inválidos.',
  PAPEL_NAO_ENCONTRADO: 'Papel não encontrado.',
  PERMISSAO_NAO_ENCONTRADA: 'Permissão não encontrada.',
  ENTIDADE_NAO_ENCONTRADA: 'Entidade não encontrada.',
  MODULO_NAO_ENCONTRADO: 'Módulo não encontrado.',
  OPERACAO_BLOQUEADA:
    'Operação bloqueada: isso removeria a última via de administração recuperável sem acesso direto ao banco.',
  ERRO_SERVIDOR: 'Erro no servidor. Tente novamente em instantes.',
};

export class AdminApiError extends HubApiError {
  readonly name = 'AdminApiError';
}

const request = criarRequest(
  (status, body) =>
    new AdminApiError(status, mensagemPorCodigo(MENSAGENS_CODIGO, body, status), codigoDoErro(body))
);

// ────────────────────────────────────────────────────────────────────────────
// /api/v1/papeis — matriz papel × permissão
// ────────────────────────────────────────────────────────────────────────────

/** `GET /papeis` — leitura acessível a admin_entidade (read-only, `podeEditar:false`). */
export async function listarPapeisMatriz(): Promise<PapeisMatrizResponse> {
  const raw = await request<unknown>('/papeis');
  return parsePapeisMatrizResponse(raw);
}

/** `PUT /papeis/:papelId/permissoes/:permissaoId` — toggle de célula (exclusivo admin_plataforma). */
export async function alternarPapelPermissao(
  papelId: number,
  permissaoId: number,
  ativo: boolean
): Promise<TogglePapelPermissaoResponse> {
  const raw = await request<unknown>(`/papeis/${papelId}/permissoes/${permissaoId}`, {
    method: 'PUT',
    body: JSON.stringify({ ativo }),
  });
  return parseTogglePapelPermissaoResponse(raw);
}

// ────────────────────────────────────────────────────────────────────────────
// /api/v1/admin — módulos por entidade (exclusivo admin_plataforma, FR-017)
// ────────────────────────────────────────────────────────────────────────────

/** `GET /admin/modulos` — catálogo completo da plataforma. */
export async function listarModulosCatalogo(): Promise<ModulosCatalogoResponse> {
  const raw = await request<unknown>('/admin/modulos');
  return parseModulosCatalogoResponse(raw);
}

/** `GET /admin/entidades/:id/modulos` — estado de habilitação para a entidade `id`. */
export async function listarModulosDaEntidade(entidadeId: number): Promise<ModulosEntidadeResponse> {
  const raw = await request<unknown>(`/admin/entidades/${entidadeId}/modulos`);
  return parseModulosEntidadeResponse(raw);
}

/** `PUT /admin/entidades/:id/modulos/:codigo` — habilita/desabilita módulo (FR-007). */
export async function alternarModuloEntidade(
  entidadeId: number,
  codigo: string,
  habilitado: boolean
): Promise<ToggleModuloEntidadeResponse> {
  const raw = await request<unknown>(`/admin/entidades/${entidadeId}/modulos/${encodeURIComponent(codigo)}`, {
    method: 'PUT',
    body: JSON.stringify({ habilitado }),
  });
  return parseToggleModuloEntidadeResponse(raw);
}
