// hub-auditoria-admin (S9) FASE 5.2 task 5.2.2 — chamadas HTTP para
// `/api/v1/usuarios` e `/api/v1/usuarios/:id/vinculos`.
//
// Molde compartilhado em `lib/hub/api.ts` (`criarRequest`/`query`), chave
// `erro` sempre.
//
// Ref: docs/specs/hub-auditoria-admin/contracts/usuarios-api.md.

import { HubApiError, criarRequest, mensagemPorCodigo, codigoDoErro, query } from './api';
import {
  parseUsuarioCriadoResponse,
  parseUsuarioEditadoResponse,
  parseUsuarioListResponse,
  parseVinculoResponse,
  type UsuarioCriado,
  type UsuarioEditado,
  type UsuarioListResponse,
  type UsuarioVinculo,
} from './usuarios-dto';

/** Mesma regra do servidor (routes/hub-usuarios.js#isStrongPassword) —
 * espelhada aqui para validação client-side (nunca substitui a validação
 * server-side, que é quem de fato garante SENHA_FRACA). */
export function isStrongPassword(senha: string): boolean {
  return typeof senha === 'string' && senha.length >= 6 && /[A-Z]/.test(senha) && /\d/.test(senha);
}

const MENSAGENS_CODIGO: Record<string, string> = {
  NAO_AUTENTICADO: 'Sua sessão expirou. Faça login novamente.',
  PERMISSAO_NEGADA: 'Você não tem permissão para esta ação.',
  MODULO_DESABILITADO: 'O módulo de usuários está desabilitado para esta entidade.',
  DADOS_INVALIDOS: 'Dados informados são inválidos.',
  SENHA_FRACA: 'A senha não atende aos requisitos mínimos (6+ caracteres, 1 maiúscula, 1 número).',
  EMAIL_JA_CADASTRADO: 'Este e-mail já está cadastrado.',
  VINCULO_JA_EXISTE: 'Este usuário já possui vínculo com esta entidade — edite o vínculo existente.',
  PAPEL_NAO_ENCONTRADO: 'Papel selecionado não existe no catálogo.',
  USUARIO_NAO_ENCONTRADO: 'Usuário não encontrado no seu escopo.',
  ERRO_SERVIDOR: 'Erro no servidor. Tente novamente em instantes.',
};

export class UsuariosApiError extends HubApiError {
  readonly name = 'UsuariosApiError';
}

const request = criarRequest(
  (status, body) =>
    new UsuariosApiError(status, mensagemPorCodigo(MENSAGENS_CODIGO, body, status), codigoDoErro(body))
);

export interface ListarUsuariosQuery {
  busca?: string;
  entidadeId?: number;
  page?: number;
  pageSize?: number;
}

/** `GET /usuarios`. */
export async function listarUsuarios(filtros: ListarUsuariosQuery = {}): Promise<UsuarioListResponse> {
  const raw = await request<unknown>(`/usuarios${query(filtros)}`);
  return parseUsuarioListResponse(raw);
}

export interface CriarUsuarioPayload {
  nome: string;
  email: string;
  senha: string;
  vinculo: { entidadeId: number; papelId: number };
}

/** `POST /usuarios` — cria usuário + 1º vínculo em um passo (SC-008). */
export async function criarUsuario(payload: CriarUsuarioPayload): Promise<UsuarioCriado> {
  const raw = await request<unknown>('/usuarios', { method: 'POST', body: JSON.stringify(payload) });
  return parseUsuarioCriadoResponse(raw);
}

export interface EditarUsuarioPayload {
  nome?: string;
  ativo?: boolean;
  senha?: string;
}

/** `PUT /usuarios/:id` — edita nome/ativo/senha. `ativo:false` é a ÚNICA
 * forma de "desativar" — não existe DELETE (CHK033). */
export async function editarUsuario(usuarioId: number, payload: EditarUsuarioPayload): Promise<UsuarioEditado> {
  const raw = await request<unknown>(`/usuarios/${usuarioId}`, { method: 'PUT', body: JSON.stringify(payload) });
  return parseUsuarioEditadoResponse(raw);
}

/** `POST /usuarios/:id/vinculos` — novo vínculo a usuário existente. */
export async function criarVinculo(
  usuarioId: number,
  payload: { entidadeId: number; papelId: number }
): Promise<UsuarioVinculo> {
  const raw = await request<unknown>(`/usuarios/${usuarioId}/vinculos`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return parseVinculoResponse(raw);
}

/** `PUT /usuarios/:id/vinculos/:vinculoId` — troca papelId e/ou ativo
 * (desativação de vínculo = `ativo:false`, nunca DELETE). */
export async function editarVinculo(
  usuarioId: number,
  vinculoId: number,
  payload: { papelId?: number; ativo?: boolean }
): Promise<UsuarioVinculo> {
  const raw = await request<unknown>(`/usuarios/${usuarioId}/vinculos/${vinculoId}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  return parseVinculoResponse(raw);
}
