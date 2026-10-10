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
  USUARIO_INATIVO: 'Usuário desativado — reative antes de reenviar o convite.',
  EMAIL_NAO_ENVIADO: 'O e-mail não pôde ser enviado agora. Tente de novo em instantes.',
  LOTE_GRANDE: 'Selecione no máximo 50 usuários por envio.',
  LIMITE_EXCEDIDO: 'Muitos envios em lote em pouco tempo. Aguarde alguns minutos e tente de novo.',
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
  /** Omitida pela tela desde 2026-09-29: sem senha, o servidor envia um
   *  convite por e-mail com link para a pessoa criar a própria senha. */
  senha?: string;
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

/** `POST /usuarios/:id/convite` — reenvia o link de criar senha. Emite um
 *  token NOVO: o link anterior deixa de valer. */
export async function reenviarConvite(usuarioId: number): Promise<void> {
  await request<unknown>(`/usuarios/${usuarioId}/convite`, { method: 'POST' });
}

/** Teto por requisição — espelha LOTE_MAX do servidor (cada reenvio é um e-mail). */
export const LOTE_CONVITES_MAX = 50;

export interface ConviteLoteItem {
  usuarioId: number;
  status: 'enviado' | 'pulado';
  motivo?: string;
}

export interface ConviteLoteResultado {
  enviados: number;
  pulados: number;
  resultado: ConviteLoteItem[];
}

/** `POST /usuarios/convites` — reenvia o link para vários de uma vez. Cada
 *  alvo recebe token NOVO (o link anterior morre). Alvos recusados vêm no
 *  relatório como `pulado`, a resposta é 200. */
export async function reenviarConvitesEmLote(usuarioIds: number[]): Promise<ConviteLoteResultado> {
  const raw = await request<ConviteLoteResultado>('/usuarios/convites', {
    method: 'POST',
    body: JSON.stringify({ usuarioIds }),
  });
  return {
    enviados: Number(raw.enviados) || 0,
    pulados: Number(raw.pulados) || 0,
    resultado: Array.isArray(raw.resultado) ? raw.resultado : [],
  };
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
