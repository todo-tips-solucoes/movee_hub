/**
 * Campanhas do motorista — cliente tipado de `GET /motorista/campanhas` e
 * `GET /motorista/campanhas/:id` (contrato: docs/plans/campanhas-motorista/CONTRATOS.md §7).
 * Identidade só pela sessão (cookie); nenhum parâmetro de motorista.
 */

import { api } from './api-client.ts';

export type Indicador = 'aceitacao' | 'conclusao' | 'tempo' | 'pedidos';

export type SituacaoCampanha =
  | 'agendada'
  | 'em_andamento'
  | 'apurando'
  | 'encerrada'
  | 'cancelada'
  | 'rascunho';

export type SituacaoMotorista = 'classificado' | 'abaixo_corte' | 'sem_minimo' | 'sem_modal';

export interface CampanhaItem {
  id: number;
  nome: string;
  situacao: SituacaoCampanha;
  dataInicio: string;
  dataFim: string;
  minhaPosicao: number | null;
  total: number;
  minhaSituacao: SituacaoMotorista | null;
  naZonaPremio: boolean;
}

export interface Pesos {
  aceitacao: number;
  conclusao: number;
  tempo: number;
  pedidos: number;
}

/** Taxas em fração 0..1; `pedidos` é contagem; `null` = sem corte. */
export interface Cortes {
  aceitacao: number | null;
  conclusao: number | null;
  tempo: number | null;
  pedidos: number | null;
}

export interface CampanhaDados {
  id: number;
  nome: string;
  descricao: string;
  situacao: SituacaoCampanha;
  dataInicio: string;
  dataFim: string;
  pracas: string[] | null;
  turnos: string[] | null;
  modais: string[] | null;
  minTurnos: number;
  pesos: Pesos;
  cortes: Cortes;
  dadosAte: string | null;
  fechadaEm: string | null;
}

export interface PremioFaixa {
  id: number;
  posicaoDe: number;
  posicaoAte: number;
  tipo: 'objeto' | 'dinheiro';
  descricao: string;
  valorCentavos: number | null;
  temFoto: boolean;
}

export interface MinhaLinha {
  situacao: SituacaoMotorista;
  posicao: number | null;
  posicaoAnterior: number | null;
  nota: number | null;
  turnos: number;
  /** Taxas em fração 0..1; pedidos em contagem; nulo = sem denominador. */
  leituras: Record<Indicador, number | null>;
  notas: Record<Indicador, number | null>;
  motivoCorte: Indicador[];
  notaHipotetica: number | null;
  posicaoHipotetica: number | null;
  ofertadas: number;
  aceitas: number;
  completadas: number;
  acima: { nome: string; nota: number } | null;
  premio: { tipo: 'objeto' | 'dinheiro'; descricao: string } | null;
  entregueEm: string | null;
}

export interface LinhaTop {
  posicao: number;
  nome: string;
  nota: number;
  souEu: boolean;
}

export interface CampanhaTela {
  campanha: CampanhaDados;
  premios: PremioFaixa[];
  eu: MinhaLinha | null;
  lider: { pedidos: number } | null;
  top10: LinhaTop[];
  totalClassificados: number;
}

export async function listarCampanhas(): Promise<CampanhaItem[]> {
  const r = await api.get<{ itens: CampanhaItem[] }>('/motorista/campanhas');
  return r.itens;
}

export function buscarCampanha(id: number | string): Promise<CampanhaTela> {
  return api.get<CampanhaTela>(`/motorista/campanhas/${encodeURIComponent(String(id))}`);
}

/** URL da foto do prêmio (binário; o cookie httpOnly segue no `<img>`). */
export function urlFotoPremio(campanhaId: number, premioId: number): string {
  return `/api/motorista/campanhas/${campanhaId}/premios/${premioId}/foto`;
}
