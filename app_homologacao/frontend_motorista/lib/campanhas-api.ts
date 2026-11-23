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

export type TipoCampanha = 'nota' | 'extrato';

export interface CampanhaItem {
  id: number;
  /** Ausente em backend antigo = 'nota'. */
  tipo?: TipoCampanha;
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
  tipo?: TipoCampanha;
  /** Só no extrato: o mínimo conta turnos trabalhados ou válidos. */
  minTurnosBase?: 'trabalhados' | 'validos';
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

/** Extrato (X2/E7): ranking só com posição + nome abreviado; o valor é só o do próprio motorista. */
export interface LinhaTopExtrato {
  posicao: number;
  nomeAbreviado: string;
}

export interface MinhaLinhaExtrato {
  situacao: SituacaoMotorista;
  posicao: number | null;
  posicaoAnterior: number | null;
  turnos: number;
  turnosValidos: number;
  valorCentavos: number;
  premio: { tipo: 'objeto' | 'dinheiro'; descricao: string } | null;
  entregueEm: string | null;
}

export interface ExtratoTela {
  campanha: CampanhaDados & { tipo: 'extrato' };
  premios: PremioFaixa[];
  eu: MinhaLinhaExtrato | null;
  lider: null;
  top10: LinhaTopExtrato[];
  totalClassificados: number;
}

export interface MotivoTurno {
  criterio: Indicador;
  /** Fração 0..1 (aceitação/conclusão/tempo) ou inteiro (pedidos); null = sem leitura. */
  lido: number | null;
  minimo: number;
}

export interface TurnoExtrato {
  data: string;
  turno: string;
  valido: boolean;
  temValor: boolean;
  valorCentavos: number;
  motivos: MotivoTurno[];
}

export function ehExtrato(t: CampanhaTela | ExtratoTela): t is ExtratoTela {
  return t.campanha.tipo === 'extrato';
}

export async function listarCampanhas(): Promise<CampanhaItem[]> {
  const r = await api.get<{ itens: CampanhaItem[] }>('/motorista/campanhas');
  return r.itens;
}

export function buscarCampanha(id: number | string): Promise<CampanhaTela | ExtratoTela> {
  return api.get<CampanhaTela | ExtratoTela>(`/motorista/campanhas/${encodeURIComponent(String(id))}`);
}

/** URL da foto do prêmio (binário; o cookie httpOnly segue no `<img>`). */
export function urlFotoPremio(campanhaId: number, premioId: number): string {
  return `/api/motorista/campanhas/${campanhaId}/premios/${premioId}/foto`;
}

/** Turnos do próprio motorista no extrato (sob demanda; até 300, mais recentes primeiro). */
export async function buscarTurnos(id: number | string): Promise<TurnoExtrato[]> {
  const r = await api.get<{ itens: TurnoExtrato[] }>(`/motorista/campanhas/${encodeURIComponent(String(id))}/turnos`);
  return r.itens ?? [];
}
