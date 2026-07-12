// hub-motoristas (S5) FASE 7 — chamadas HTTP para `/api/v1/motoristas*`.
//
// Mesmo molde de `lib/hub/importacoes-api.ts`: `request<T>()` local (fetch
// nativo + `credentials: 'include'`), `query()` para querystring filtrando
// vazio/undefined, classe de erro própria. Diferença: este contrato usa
// SEMPRE a chave `erro` (nunca `error`) — contracts/motoristas-api.md.
//
// Ref: docs/specs/hub-motoristas/contracts/motoristas-api.md.

import {
  parseAreasResponse,
  parseContasElegiveisResponse,
  parseCriarMotoristaResponse,
  parseMotoristaDetalhe,
  parseMotoristaListResponse,
  parseSugestoesResponse,
  parseVincularResponse,
  type ContasElegiveisResponse,
  type CriarMotoristaResponse,
  type MotoristaDetalhe,
  type MotoristaListResponse,
  type OrigemVinculo,
  type SugestoesResponse,
  type VincularResponse,
} from './motoristas-dto';

const HUB_API_BASE = '/api/v1';

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
};

export class MotoristaApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly codigo?: string,
    public readonly motivo?: string,
    public readonly vinculadaA?: { entregadorId: number; nome: string }
  ) {
    super(message);
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${HUB_API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (res.status === 204) {
    return undefined as T;
  }
  const body: unknown = await res.json().catch(() => ({}));
  const bodyObj = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (!res.ok) {
    const codigo = typeof bodyObj.erro === 'string' ? bodyObj.erro : undefined;
    throw new MotoristaApiError(
      res.status,
      mensagemAmigavel(bodyObj, res.status),
      codigo,
      typeof bodyObj.motivo === 'string' ? bodyObj.motivo : undefined,
      parseVinculadaA(bodyObj)
    );
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

export interface ListarMotoristasQuery {
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

export async function obterMotorista(id: number): Promise<MotoristaDetalhe> {
  const raw = await request<unknown>(`/motoristas/${id}`);
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
