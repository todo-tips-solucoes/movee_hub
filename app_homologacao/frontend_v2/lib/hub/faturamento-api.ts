// hub-faturamento (S6) FASE 6 task 6.1 — chamadas HTTP para
// `/api/v1/faturamento*`.
//
// Molde compartilhado em `lib/hub/api.ts` (`criarRequest`/`query`). Este
// contrato usa SEMPRE a chave `erro` (nunca `error`) —
// contracts/faturamento-api.md.
//
// Ref: docs/specs/hub-faturamento/contracts/faturamento-api.md.

import { HUB_API_BASE, HubApiError, criarRequest, mensagemPorCodigo, codigoDoErro, query } from './api';
import {
  parseAreasResponse,
  parseFaturamentoListResponse,
  parseFaturamentoResumoAgrupado,
  parseFaturamentoResumoCards,
  type FaturamentoGroupBy,
  type FaturamentoListResponse,
  type FaturamentoResumoAgrupado,
  type FaturamentoResumoCards,
} from './faturamento-dto';
import { parseEntregadorBuscaResponse, type EntregadorBuscaItem } from './entregador-busca-dto';

const MENSAGENS_CODIGO: Record<string, string> = {
  NAO_AUTENTICADO: 'Sua sessão expirou. Faça login novamente.',
  ENTIDADE_NAO_SELECIONADA: 'Selecione uma entidade antes de continuar.',
  PERMISSAO_NEGADA: 'Você não tem permissão para esta ação.',
  DATA_INVALIDA: 'Período informado é inválido.',
  ENTREGADOR_ID_INVALIDO: 'Identificador de entregador inválido.',
  FILTRO_CONTRADITORIO: 'Filtro contraditório: um entregador específico nunca é um lançamento sem entregador.',
  GROUP_BY_INVALIDO: 'Agrupamento inválido.',
  ERRO_SERVIDOR: 'Erro no servidor. Tente novamente em instantes.',
};

export class FaturamentoApiError extends HubApiError {
  readonly name = 'FaturamentoApiError';
}

const mensagemAmigavel = (body: Record<string, unknown>, status: number) =>
  mensagemPorCodigo(MENSAGENS_CODIGO, body, status);

const request = criarRequest(
  (status, body) =>
    new FaturamentoApiError(status, mensagemPorCodigo(MENSAGENS_CODIGO, body, status), codigoDoErro(body))
);

export interface FaturamentoFiltros {
  de?: string;
  ate?: string;
  categoria?: string;
  entregadorId?: number;
  subpraca?: string;
  comEntregador?: boolean;
}

export interface ListarFaturamentoQuery extends FaturamentoFiltros {
  page?: number;
  pageSize?: number;
}

export async function listarFaturamento(filtros: ListarFaturamentoQuery = {}): Promise<FaturamentoListResponse> {
  const raw = await request<unknown>(`/faturamento${query(filtros)}`);
  return parseFaturamentoListResponse(raw);
}

/** Subpraças distintas visíveis à entidade ativa — opções do filtro "Subpraça". */
export async function listarAreasFaturamento(): Promise<string[]> {
  const raw = await request<unknown>('/faturamento/areas');
  return parseAreasResponse(raw);
}

/** `GET /faturamento/entregadores?busca=...` — busca de entregador por nome
 * (hub-motorista-canonico FASE 2/WS-B, contracts/api-motorista-canonico.md
 * §WS-B), consumido por `EntregadorCombobox`. `busca` já deve ter >= 3
 * caracteres (o combobox nem dispara a chamada antes disso — FR-006). */
export async function buscarEntregadoresFaturamento(busca: string): Promise<EntregadorBuscaItem[]> {
  const raw = await request<unknown>(`/faturamento/entregadores${query({ busca })}`);
  return parseEntregadorBuscaResponse(raw);
}

/** `GET /faturamento/resumo` sem `groupBy` — cards (FR-003). */
export async function obterFaturamentoResumo(filtros: FaturamentoFiltros = {}): Promise<FaturamentoResumoCards> {
  const raw = await request<unknown>(`/faturamento/resumo${query(filtros)}`);
  return parseFaturamentoResumoCards(raw);
}

/** `GET /faturamento/resumo?groupBy=...` — agregados por dia/categoria/
 * entregador (FR-004). */
export async function obterFaturamentoResumoAgrupado(
  groupBy: FaturamentoGroupBy,
  filtros: FaturamentoFiltros = {}
): Promise<FaturamentoResumoAgrupado> {
  const raw = await request<unknown>(`/faturamento/resumo${query({ ...filtros, groupBy })}`);
  return parseFaturamentoResumoAgrupado(raw);
}

/** Dispara o download do CSV (`?format=csv`) — mesmo padrão de
 * `importacoes-api.ts#baixarErrosCsv`. Requer `faturamento.exportar`
 * (checado inline pelo backend — 403 se ausente, mesmo com
 * `faturamento.listar`). */
export async function baixarFaturamentoCsv(filtros: FaturamentoFiltros = {}): Promise<void> {
  const res = await fetch(`${HUB_API_BASE}/faturamento${query({ ...filtros, format: 'csv' })}`, {
    credentials: 'include',
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    const bodyObj = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    throw new FaturamentoApiError(res.status, mensagemAmigavel(bodyObj, res.status));
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition');
  const match = disposition?.match(/filename="?([^"]+)"?/);
  const filename = match ? match[1] : 'faturamento.csv';
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}
