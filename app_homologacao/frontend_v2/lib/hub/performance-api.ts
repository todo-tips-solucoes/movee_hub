// hub-performance (S7) FASE 5 task 5.1 — chamadas HTTP para
// `/api/v1/performance*`.
//
// Molde compartilhado em `lib/hub/api.ts` (`criarRequest`/`query`). Este
// contrato usa SEMPRE a chave `erro` (nunca `error`) —
// contracts/performance-api.md.
//
// Ref: docs/specs/hub-performance/contracts/performance-api.md.

import { HUB_API_BASE, HubApiError, criarRequest, mensagemPorCodigo, codigoDoErro, query } from './api';
import {
  parseAreasResponse,
  parsePerformanceListResponse,
  parsePerformanceResumoAgrupado,
  parsePerformanceResumoCards,
  type PerformanceGroupBy,
  type PerformanceListResponse,
  type PerformanceResumoAgrupado,
  type PerformanceResumoCards,
} from './performance-dto';
import { parseEntregadorBuscaResponse, type EntregadorBuscaItem } from './entregador-busca-dto';

const MENSAGENS_CODIGO: Record<string, string> = {
  NAO_AUTENTICADO: 'Sua sessão expirou. Faça login novamente.',
  ENTIDADE_NAO_SELECIONADA: 'Selecione uma entidade antes de continuar.',
  PERMISSAO_NEGADA: 'Você não tem permissão para esta ação.',
  DATA_INVALIDA: 'Período informado é inválido.',
  ENTREGADOR_ID_INVALIDO: 'Identificador de entregador inválido.',
  GROUP_BY_INVALIDO: 'Agrupamento inválido.',
  ERRO_SERVIDOR: 'Erro no servidor. Tente novamente em instantes.',
};

export class PerformanceApiError extends HubApiError {
  readonly name = 'PerformanceApiError';
}

const mensagemAmigavel = (body: Record<string, unknown>, status: number) =>
  mensagemPorCodigo(MENSAGENS_CODIGO, body, status);

const request = criarRequest(
  (status, body) =>
    new PerformanceApiError(status, mensagemPorCodigo(MENSAGENS_CODIGO, body, status), codigoDoErro(body))
);

export interface PerformanceFiltros {
  de?: string;
  ate?: string;
  periodo?: string;
  subpraca?: string;
  entregadorId?: number;
}

export interface ListarPerformanceQuery extends PerformanceFiltros {
  page?: number;
  pageSize?: number;
}

export async function listarPerformance(filtros: ListarPerformanceQuery = {}): Promise<PerformanceListResponse> {
  const raw = await request<unknown>(`/performance${query(filtros)}`);
  return parsePerformanceListResponse(raw);
}

/** Subpraças distintas visíveis à entidade ativa — opções do filtro "Subpraça". */
export async function listarAreasPerformance(): Promise<string[]> {
  const raw = await request<unknown>('/performance/areas');
  return parseAreasResponse(raw);
}

/** `GET /performance/entregadores?busca=...` — busca de entregador por nome
 * (hub-motorista-canonico FASE 2/WS-B, contracts/api-motorista-canonico.md
 * §WS-B), consumido por `EntregadorCombobox`. Espelho de
 * `faturamento-api.ts#buscarEntregadoresFaturamento`. */
export async function buscarEntregadoresPerformance(busca: string): Promise<EntregadorBuscaItem[]> {
  const raw = await request<unknown>(`/performance/entregadores${query({ busca })}`);
  return parseEntregadorBuscaResponse(raw);
}

/** `GET /performance/resumo` sem `groupBy` — cards (FR-003). */
export async function obterPerformanceResumo(filtros: PerformanceFiltros = {}): Promise<PerformanceResumoCards> {
  const raw = await request<unknown>(`/performance/resumo${query(filtros)}`);
  return parsePerformanceResumoCards(raw);
}

/** `GET /performance/resumo?groupBy=...` — agregados por dia/período/
 * entregador (FR-004). Não consumido por `page.tsx` nesta fase (só
 * cards+lista), mas parte do contrato do client (tasks.md 5.1.2). */
export async function obterPerformanceResumoAgrupado(
  groupBy: PerformanceGroupBy,
  filtros: PerformanceFiltros = {}
): Promise<PerformanceResumoAgrupado> {
  const raw = await request<unknown>(`/performance/resumo${query({ ...filtros, groupBy })}`);
  return parsePerformanceResumoAgrupado(raw);
}

/** Dispara o download do CSV (`?format=csv`) — mesmo padrão de
 * `faturamento-api.ts#baixarFaturamentoCsv`. Requer
 * `performance.exportar` (checado inline pelo backend — 403 se ausente,
 * mesmo com `performance.listar`). */
export async function baixarPerformanceCsv(filtros: PerformanceFiltros = {}): Promise<void> {
  const res = await fetch(`${HUB_API_BASE}/performance${query({ ...filtros, format: 'csv' })}`, {
    credentials: 'include',
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    const bodyObj = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    throw new PerformanceApiError(res.status, mensagemAmigavel(bodyObj, res.status));
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition');
  const match = disposition?.match(/filename="?([^"]+)"?/);
  const filename = match ? match[1] : 'performance.csv';
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}
