// hub-motoristas (S5) FASE 7 — chamadas HTTP para `/api/v1/motoristas*`.
//
// Molde compartilhado em `lib/hub/api.ts` (`criarRequest`/`query`). Este
// contrato usa SEMPRE a chave `erro` (nunca `error`) —
// contracts/motoristas-api.md. O erro deste módulo carrega `motivo` e
// `vinculadaA` além do código, então a construção fica aqui.
//
// Ref: docs/specs/hub-motoristas/contracts/motoristas-api.md.

import { HubApiError, criarRequest, codigoDoErro, query } from './api';
import {
  parseAreasResponse,
  parseAtualizarCredencialResponse,
  parseContasElegiveisResponse,
  parseCriarCredencialResponse,
  parseCriarMotoristaResponse,
  parseMotoristaDetalhe,
  parseMotoristaListResponse,
  parseResetCredencialResponse,
  parseSugestoesResponse,
  parseVincularResponse,
  type AtualizarCredencialResponse,
  type ContasElegiveisResponse,
  type CriarCredencialResponse,
  type CriarMotoristaResponse,
  type MotoristaDetalhe,
  type MotoristaListResponse,
  type OrigemVinculo,
  type ResetCredencialResponse,
  type SugestoesResponse,
  type VincularResponse,
} from './motoristas-dto';

const MENSAGENS_MOTIVO: Record<string, string> = {
  entidade_fora_do_grupo: 'Esta entidade não pertence ao grupo elegível para vínculo de motoristas.',
  conta_ja_vinculada: 'Esta conta já está vinculada a outra pessoa entregadora.',
};

const MENSAGENS_CODIGO: Record<string, string> = {
  NAO_AUTENTICADO: 'Sua sessão expirou. Faça login novamente.',
  ENTIDADE_NAO_SELECIONADA: 'Selecione uma entidade antes de continuar.',
  PERMISSAO_NEGADA: 'Você não tem permissão para esta ação.',
  NAO_ENCONTRADO: 'Motorista não encontrado.',
  INVALIDO: 'Dados inválidos.',
  CONFLITO: 'Esta conta já está vinculada a outra pessoa entregadora.',
  ERRO_SERVIDOR: 'Erro no servidor. Tente novamente em instantes.',
  // POST /motoristas (FASE 4, contracts/api-motorista-canonico.md §POST) —
  // única rota deste módulo com códigos de erro em snake_case minúsculo.
  nome_invalido: 'Informe o nome do motorista.',
  uuid_invalido: 'O identificador (uuid) informado está em formato inválido.',
  uuid_duplicado: 'Este identificador (uuid) já pertence a outro motorista desta empresa.',
  // Credencial de acesso ao app do motorista (FASE 5, task 5.5,
  // contracts/api-motorista-canonico.md §WS-C Credencial).
  cnpj_invalido: 'Informe o CNPJ do prestador.',
  senha_invalida: 'A senha informada precisa ter pelo menos 8 caracteres.',
  credencial_existente: 'Este motorista (ou este CNPJ) já tem uma credencial de acesso vinculada.',
  credencial_inexistente: 'Este motorista ainda não tem uma credencial de acesso criada.',
  token_ausente: 'Informe o token de definição de senha.',
  token_invalido: 'Token inválido. Solicite uma nova redefinição de senha.',
  token_expirado: 'Este token expirou. Solicite uma nova redefinição de senha.',
};

export class MotoristaApiError extends HubApiError {
  constructor(
    status: number,
    message: string,
    codigo?: string,
    public readonly motivo?: string,
    public readonly vinculadaA?: { entregadorId: number; nome: string }
  ) {
    super(status, message, codigo);
    this.name = 'MotoristaApiError';
  }
}

function mensagemAmigavel(body: Record<string, unknown>, status: number): string {
  const motivo = typeof body.motivo === 'string' ? body.motivo : undefined;
  if (motivo && MENSAGENS_MOTIVO[motivo]) return MENSAGENS_MOTIVO[motivo];
  const codigo = typeof body.erro === 'string' ? body.erro : undefined;
  if (codigo && MENSAGENS_CODIGO[codigo]) return MENSAGENS_CODIGO[codigo];
  return `Erro ${status}. Tente novamente.`;
}

function parseVinculadaA(body: Record<string, unknown>): { entregadorId: number; nome: string } | undefined {
  const v = body.vinculadaA;
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.entregadorId !== 'number' || typeof r.nome !== 'string') return undefined;
  return { entregadorId: r.entregadorId, nome: r.nome };
}

const request = criarRequest(
  (status, body) =>
    new MotoristaApiError(
      status,
      mensagemAmigavel(body, status),
      codigoDoErro(body),
      typeof body.motivo === 'string' ? body.motivo : undefined,
      parseVinculadaA(body)
    )
);

/** impeccable rodada 16: a ordem é escolhida na tela e validada por allowlist
 *  no backend (`ORDENAVEIS_MOTORISTAS` em `routes/hub-motoristas.js`). Valor
 *  desconhecido não é erro lá — cai no padrão `nome.asc`. */
export type ColunaMotoristas = 'nome' | 'ativo' | 'area';

export interface ListarMotoristasQuery {
  ordenarPor?: ColunaMotoristas | '';
  direcao?: 'asc' | 'desc' | '';
  nome?: string;
  ativo?: boolean;
  area?: string;
  comVinculo?: boolean;
  page?: number;
  pageSize?: number;
}

export async function listarMotoristas(filtros: ListarMotoristasQuery = {}): Promise<MotoristaListResponse> {
  const raw = await request<unknown>(`/motoristas${query(filtros)}`);
  return parseMotoristaListResponse(raw);
}

/** FASE 6 (tasks.md 6.4/6.5) — `offset`/`limit` paginam SÓ a seção
 * "Atividades" (dec-046); ausentes -> default do backend (offset=0/limit=20). */
export interface ObterMotoristaQuery {
  atividadesOffset?: number;
  atividadesLimit?: number;
}

export async function obterMotorista(id: number, filtros: ObterMotoristaQuery = {}): Promise<MotoristaDetalhe> {
  const raw = await request<unknown>(
    `/motoristas/${id}${query({ offset: filtros.atividadesOffset, limit: filtros.atividadesLimit })}`
  );
  return parseMotoristaDetalhe(raw);
}

/** POST /motoristas — cadastro manual com uuid obrigatório (FASE 4, task
 * 4.2). Allowlist estrita do lado do cliente: só `nome`/`idExterno` são
 * enviados — mesmo mandato S2 aplicado no backend
 * (`validarCriacaoMotorista`). */
export interface CriarMotoristaBody {
  nome: string;
  idExterno: string;
}

export async function criarMotorista(body: CriarMotoristaBody): Promise<CriarMotoristaResponse> {
  const raw = await request<unknown>('/motoristas', {
    method: 'POST',
    body: JSON.stringify({ nome: body.nome, idExterno: body.idExterno }),
  });
  return parseCriarMotoristaResponse(raw);
}

/** Subpraças distintas visíveis à entidade ativa — opções do filtro "Área". */
export async function listarAreasMotoristas(): Promise<string[]> {
  const raw = await request<unknown>('/motoristas/areas');
  return parseAreasResponse(raw);
}

export interface EditarMotoristaBody {
  nome?: string;
  ativo?: boolean;
}

export async function editarMotorista(id: number, body: EditarMotoristaBody): Promise<MotoristaDetalhe> {
  const raw = await request<unknown>(`/motoristas/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return parseMotoristaDetalhe(raw);
}

export async function obterSugestoes(id: number): Promise<SugestoesResponse> {
  const raw = await request<unknown>(`/motoristas/${id}/sugestoes`);
  return parseSugestoesResponse(raw);
}

export interface BuscarContasElegiveisQuery {
  entregadorId: number;
  q: string;
  page?: number;
  pageSize?: number;
}

export async function buscarContasElegiveis(filtros: BuscarContasElegiveisQuery): Promise<ContasElegiveisResponse> {
  const raw = await request<unknown>(`/motoristas/contas-elegiveis${query(filtros)}`);
  return parseContasElegiveisResponse(raw);
}

export async function vincularMotorista(
  id: number,
  contaMotoristaId: number,
  origem?: OrigemVinculo
): Promise<VincularResponse> {
  const raw = await request<unknown>(`/motoristas/${id}/vinculo`, {
    method: 'POST',
    body: JSON.stringify({ contaMotoristaId, ...(origem ? { origem } : {}) }),
  });
  return parseVincularResponse(raw);
}

export async function desvincularMotorista(id: number): Promise<void> {
  await request<void>(`/motoristas/${id}/vinculo`, { method: 'DELETE' });
}

// ────────────────────────────────────────────────────────────────────────────
// FASE 5 (task 5.5) — Credencial de acesso ao app do motorista.
// `entregadorId` é sempre o `Entregador.id` (mesmo parâmetro de
// `vincularMotorista`/`desvincularMotorista` acima), NUNCA o
// `contaMotoristaId` — mesmo padrão de todas as rotas `:id/...` deste módulo.
// ────────────────────────────────────────────────────────────────────────────

export interface CriarCredencialBody {
  cnpjPrestador: string;
  /** Opcional — se ausente, o backend gera uma senha temporária de alta
   * entropia e a devolve em `senhaTemporaria` (uma única vez). */
  senhaInicial?: string;
}

export async function criarCredencial(
  entregadorId: number,
  body: CriarCredencialBody
): Promise<CriarCredencialResponse> {
  const raw = await request<unknown>(`/motoristas/${entregadorId}/credencial`, {
    method: 'POST',
    body: JSON.stringify({
      cnpjPrestador: body.cnpjPrestador,
      ...(body.senhaInicial ? { senhaInicial: body.senhaInicial } : {}),
    }),
  });
  return parseCriarCredencialResponse(raw);
}

/** Invalida a senha atual IMEDIATAMENTE e devolve `tokenDefinicao` (60 min,
 * uso único) — ver `definirNovaSenhaCredencial`. */
export async function resetSenhaCredencial(entregadorId: number): Promise<ResetCredencialResponse> {
  const raw = await request<unknown>(`/motoristas/${entregadorId}/credencial/reset-senha`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return parseResetCredencialResponse(raw);
}

export interface DefinirNovaSenhaCredencialBody {
  token: string;
  novaSenha: string;
}

export async function definirNovaSenhaCredencial(
  entregadorId: number,
  body: DefinirNovaSenhaCredencialBody
): Promise<void> {
  await request<unknown>(`/motoristas/${entregadorId}/credencial/reset-senha/definir`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function atualizarCredencial(
  entregadorId: number,
  body: { ativo: boolean }
): Promise<AtualizarCredencialResponse> {
  const raw = await request<unknown>(`/motoristas/${entregadorId}/credencial`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return parseAtualizarCredencialResponse(raw);
}
