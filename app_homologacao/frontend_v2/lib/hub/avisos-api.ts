// hub-avisos (push-motorista, FASE 7 — tasks.md 7.1.1): chamadas HTTP para
// `/api/v1/avisos*`. Mesmo molde de lib/hub/importacoes-api.ts.
//
// Ref: docs/specs/envioMassa_homologacao/contracts/hub-avisos.md.

import { HubApiError, criarRequest, mensagemPorCodigo, query } from './api';
import {
  parseAvisoAlcance,
  parseAvisoCriado,
  parseAvisoDetalhe,
  parseAvisoListResponse,
  parseAvisosCobertura,
  parseEmpresasDestinoResponse,
  parseMotoristasDestinoResponse,
  type AvisoAlcance,
  type AvisoCriado,
  type AvisoDetalhe,
  type AvisoListResponse,
  type AvisosCobertura,
  type EmpresaDestino,
  type ModoDestinatarios,
  type MotoristaDestino,
} from './avisos-dto';

/** Mensagens legíveis para os 9 códigos próprios do módulo + os 4 comuns ao
 * hub (contracts/hub-avisos.md §Convenções — nunca expor o código bruto). */
const MENSAGENS_CODIGO: Record<string, string> = {
  NAO_AUTENTICADO: 'Sua sessão expirou. Faça login novamente.',
  ENTIDADE_NAO_SELECIONADA: 'Selecione uma entidade antes de continuar.',
  PERMISSAO_NEGADA: 'Você não tem permissão para esta ação.',
  ERRO_SERVIDOR: 'Erro no servidor. Tente novamente em instantes.',
  MODULO_DESABILITADO: 'O módulo de avisos está desabilitado para esta empresa.',
  FORA_DO_GRUPO_MOVEE: 'Este recurso é exclusivo do grupo Movee.',
  DADOS_INVALIDOS: 'Dados inválidos. Confira os campos e tente novamente.',
  CONTEUDO_EXCEDE_LIMITE: 'Título ou mensagem excede o limite de caracteres.',
  DESTINATARIOS_FORA_DO_ESCOPO: 'Um ou mais destinatários estão fora do escopo permitido.',
  SEM_INSCRICOES_ATIVAS: 'Nenhum motorista está com notificações ativas no momento.',
  LIMITE_EXCEDIDO: 'Limite temporário atingido (disparos ou consultas de alcance). Tente novamente em alguns minutos.',
  PUSH_INDISPONIVEL: 'Serviço de notificações indisponível no momento.',
  AVISO_NAO_ENCONTRADO: 'Aviso não encontrado.',
};

/** `motivo` de `400 DADOS_INVALIDOS` (lib/hub-avisos-dto.js#validarAviso, backend). */
const MENSAGENS_MOTIVO: Record<string, string> = {
  titulo: 'Informe um título válido (1 a 60 caracteres).',
  corpo: 'Informe uma mensagem válida (1 a 180 caracteres).',
  modo: 'Selecione um modo de destinatários válido.',
  ids: 'Selecione ao menos um destinatário válido.',
  chave: 'Falha interna ao identificar o disparo. Tente novamente.',
};

export class AvisoApiError extends HubApiError {
  constructor(
    status: number,
    message: string,
    codigo?: string,
    public readonly motivo?: string
  ) {
    super(status, message, codigo);
    this.name = 'AvisoApiError';
  }
}

function mensagemAmigavel(body: Record<string, unknown>, status: number): string {
  const motivo = typeof body.motivo === 'string' ? body.motivo : undefined;
  if (motivo && MENSAGENS_MOTIVO[motivo]) return MENSAGENS_MOTIVO[motivo];
  return mensagemPorCodigo(MENSAGENS_CODIGO, body, status);
}

const request = criarRequest(
  (status, body) =>
    new AvisoApiError(
      status,
      mensagemAmigavel(body, status),
      typeof body.erro === 'string' ? body.erro : undefined,
      typeof body.motivo === 'string' ? body.motivo : undefined
    )
);

// ────────────────────────────────────────────────────────────────────────────
// as 7 chamadas do contrato (tasks.md 7.1.1)
// ────────────────────────────────────────────────────────────────────────────

export interface ListarAvisosQuery {
  page?: number;
  pageSize?: number;
}

export async function listarAvisos(filtros: ListarAvisosQuery = {}): Promise<AvisoListResponse> {
  const raw = await request<unknown>(`/avisos${query(filtros)}`);
  return parseAvisoListResponse(raw);
}

export async function obterAviso(id: number): Promise<AvisoDetalhe> {
  const raw = await request<unknown>(`/avisos/${id}`);
  return parseAvisoDetalhe(raw);
}

export async function obterAlcance(params: { modo: ModoDestinatarios; ids?: number[] }): Promise<AvisoAlcance> {
  const raw = await request<unknown>(
    `/avisos/alcance${query({ modo: params.modo, ids: params.ids && params.ids.length ? params.ids.join(',') : undefined })}`
  );
  return parseAvisoAlcance(raw);
}

export interface NovoAvisoInput {
  titulo: string;
  corpo: string;
  modoDestinatarios: ModoDestinatarios;
  destinatariosIds: number[];
  chaveIdempotencia: string;
}

export async function dispararAviso(input: NovoAvisoInput): Promise<AvisoCriado> {
  const raw = await request<unknown>('/avisos', { method: 'POST', body: JSON.stringify(input) });
  return parseAvisoCriado(raw);
}

export async function listarEmpresasDestino(): Promise<EmpresaDestino[]> {
  const raw = await request<unknown>('/avisos/destinatarios/empresas');
  return parseEmpresasDestinoResponse(raw).empresas;
}

export async function buscarMotoristasDestino(busca: string): Promise<MotoristaDestino[]> {
  const raw = await request<unknown>(`/avisos/destinatarios/motoristas${query({ busca })}`);
  return parseMotoristasDestinoResponse(raw).motoristas;
}

export async function obterCobertura(): Promise<AvisosCobertura> {
  const raw = await request<unknown>('/avisos/cobertura');
  return parseAvisosCobertura(raw);
}
