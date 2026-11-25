// campanhas do motorista (W3a) — tipos + parse defensivo do contrato
// `/api/v1/hub/campanhas*` (docs/plans/campanhas-motorista/CONTRATOS.md §7).
// O backend responde em camelCase; aqui só espelhamos o contrato e validamos o
// SHAPE (mesmo molde de `avisos-dto.ts`).

import type { CategoriaProducao } from './adiantamentos-api';
import { INDICADORES_META } from './performance-metas-api';

export type SituacaoCampanha =
  | 'rascunho'
  | 'agendada'
  | 'em_andamento'
  | 'apurando'
  | 'encerrada'
  | 'cancelada';

export const SITUACOES: SituacaoCampanha[] = [
  'rascunho',
  'agendada',
  'em_andamento',
  'apurando',
  'encerrada',
  'cancelada',
];

export const SITUACAO_LABELS: Record<SituacaoCampanha, string> = {
  rascunho: 'Rascunho',
  agendada: 'Agendada',
  em_andamento: 'Em andamento',
  apurando: 'Apurando',
  encerrada: 'Encerrada',
  cancelada: 'Cancelada',
};

export type TipoCampanha = 'nota' | 'extrato';
export const TIPO_CAMPANHA_LABELS: Record<TipoCampanha, string> = { nota: 'Nota ponderada', extrato: 'Melhor extrato' };
export type MinTurnosBase = 'trabalhados' | 'validos';

export type IndicadorCampanha = 'aceitacao' | 'conclusao' | 'tempo' | 'pedidos';
export const INDICADORES_CAMPANHA: IndicadorCampanha[] = ['aceitacao', 'conclusao', 'tempo', 'pedidos'];

const rotuloMeta = (id: 'aceitacao' | 'conclusao') => INDICADORES_META.find((i) => i.id === id)!.rotulo;

/** Rótulos IGUAIS aos da tela Performance (sem segundo vocabulário). Aceitação
 * e conclusão vêm de `INDICADORES_META`; "Tempo disponível" e "Pedidos
 * concluídos" não têm constante única (a Performance os escreve inline, com
 * "médio do turno" no card), então ficam aqui como prefixo comum. */
export const ROTULO_INDICADOR_CAMPANHA: Record<IndicadorCampanha, string> = {
  aceitacao: rotuloMeta('aceitacao'),
  conclusao: rotuloMeta('conclusao'),
  tempo: 'Tempo disponível',
  pedidos: 'Pedidos concluídos',
};

export type TipoPremio = 'objeto' | 'dinheiro';
export const TIPO_PREMIO_LABELS: Record<TipoPremio, string> = { objeto: 'Objeto', dinheiro: 'Dinheiro' };

export type Pesos = Record<IndicadorCampanha, number>;
/** Taxas em fração 0..1; `pedidos` é contagem. `null` = sem corte. */
export type Cortes = Record<IndicadorCampanha, number | null>;

export interface Contagem {
  classificado: number;
  abaixoCorte: number;
  semMinimo: number;
  semModal: number;
  /** Extrato: somas sobre classificado + sem_minimo (0 na nota). */
  turnos: number;
  turnosValidos: number;
  valorCentavos: number;
}

export interface CampanhaItem {
  id: number;
  nome: string;
  situacao: SituacaoCampanha;
  dataInicio: string;
  dataFim: string;
  pracas: string[] | null;
  turnos: string[] | null;
  modais: string[] | null;
  minTurnos: number;
  tipo: TipoCampanha;
  /** Só no extrato: nomes exatos ou tokens de família (`familia:promocao`). */
  categorias: string[] | null;
  minTurnosBase: MinTurnosBase;
  pesos: Pesos;
  contagem: Contagem;
  premiosPendentes: number;
  dadosAte: string | null;
  /** Interruptor de visibilidade no app do motorista (padrão: oculta). */
  visivelApp: boolean;
}

export interface PremioDetalhe {
  id: number;
  posicaoDe: number;
  posicaoAte: number;
  tipo: TipoPremio;
  descricao: string;
  valorCentavos: number | null;
  temFoto: boolean;
}

export interface CampanhaDetalhe extends CampanhaItem {
  descricao: string;
  cortes: Cortes;
  premios: PremioDetalhe[];
  avisar: boolean;
  criadaPor: string | null;
  criadaEm: string | null;
  lancadaPor: string | null;
  lancadaEm: string | null;
  canceladaEm: string | null;
  motivoCancelamento: string | null;
  fechadaEm: string | null;
  notaCorteTop10: number | null;
}

export type SituacaoRanking = 'classificado' | 'abaixo_corte' | 'sem_minimo' | 'sem_modal';

export interface LinhaRanking {
  posicao: number | null;
  entregadorId: number;
  nome: string;
  modal: string | null;
  situacao: SituacaoRanking;
  /** Turnos trabalhados. */
  turnos: number;
  /** Só no extrato. */
  turnosValidos: number | null;
  valorCentavos: number | null;
  aceitacao: number | null;
  conclusao: number | null;
  tempo: number | null;
  pedidos: number | null;
  nota: number | null;
  notaHipotetica: number | null;
  posicaoHipotetica: number | null;
  motivoCorte: string[];
  posicaoAnterior: number | null;
}

export interface RankingResposta {
  itens: LinhaRanking[];
  contagem: Contagem;
  pagina: number;
  porPagina: number;
}

export interface Vencedor {
  posicao: number;
  nome: string;
  nota: number | null;
  premio: { tipo: TipoPremio; descricao: string; valorCentavos: number | null };
  entregueEm: string | null;
  entreguePor: string | null;
  observacao: string | null;
  exportadoEm: string | null;
  semCnpj: boolean;
}

export interface OpcoesCampanha {
  pracas: string[];
  turnos: string[];
  modais: string[];
  /** Fração 0..1 dos turnos do público com pedidos informado; null = sem dado. */
  coberturaPedidos: number | null;
  alcance: { rodaram: number; semModal: number };
}

// ── helpers de shape ────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function obj(raw: unknown, onde: string): Obj {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError(`${onde} inválido: shape não é objeto`);
  }
  return raw as Obj;
}
const num = (v: unknown, padrao = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : padrao);
const numOuNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown, padrao = ''): string => (typeof v === 'string' ? v : padrao);
const strOuNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const listaOuNull = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
const lista = (v: unknown): string[] => listaOuNull(v) ?? [];

function parseIndicadores<T>(raw: unknown, ler: (v: unknown) => T): Record<IndicadorCampanha, T> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Obj;
  return {
    aceitacao: ler(r.aceitacao),
    conclusao: ler(r.conclusao),
    tempo: ler(r.tempo),
    pedidos: ler(r.pedidos),
  };
}

function parseContagem(raw: unknown): Contagem {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Obj;
  return {
    classificado: num(r.classificado),
    abaixoCorte: num(r.abaixoCorte),
    semMinimo: num(r.semMinimo),
    semModal: num(r.semModal),
    turnos: num(r.turnos),
    turnosValidos: num(r.turnosValidos),
    valorCentavos: num(r.valorCentavos),
  };
}

function parseSituacao(v: unknown): SituacaoCampanha {
  if (typeof v === 'string' && (SITUACOES as string[]).includes(v)) return v as SituacaoCampanha;
  throw new TypeError('Campanha inválida: situação desconhecida');
}

export function parseCampanhaItem(raw: unknown): CampanhaItem {
  const r = obj(raw, 'Item de campanha');
  if (typeof r.id !== 'number' || typeof r.nome !== 'string') {
    throw new TypeError('Item de campanha inválido: id/nome ausentes');
  }
  return {
    id: r.id,
    nome: r.nome,
    situacao: parseSituacao(r.situacao),
    dataInicio: str(r.dataInicio),
    dataFim: str(r.dataFim),
    pracas: listaOuNull(r.pracas),
    turnos: listaOuNull(r.turnos),
    modais: listaOuNull(r.modais),
    minTurnos: num(r.minTurnos, 1),
    tipo: r.tipo === 'extrato' ? 'extrato' : 'nota',
    categorias: listaOuNull(r.categorias),
    minTurnosBase: r.minTurnosBase === 'validos' ? 'validos' : 'trabalhados',
    pesos: parseIndicadores(r.pesos, (v) => num(v)),
    contagem: parseContagem(r.contagem),
    premiosPendentes: num(r.premiosPendentes),
    dadosAte: strOuNull(r.dadosAte),
    visivelApp: r.visivelApp === true,
  };
}

export function parseCampanhaLista(raw: unknown): CampanhaItem[] {
  const r = obj(raw, 'Lista de campanhas');
  if (!Array.isArray(r.itens)) throw new TypeError('Lista de campanhas inválida: itens não é array');
  return r.itens.map(parseCampanhaItem);
}

function parsePremio(raw: unknown): PremioDetalhe {
  const r = obj(raw, 'Prêmio');
  return {
    id: num(r.id),
    posicaoDe: num(r.posicaoDe),
    posicaoAte: num(r.posicaoAte),
    tipo: r.tipo === 'dinheiro' ? 'dinheiro' : 'objeto',
    descricao: str(r.descricao),
    valorCentavos: numOuNull(r.valorCentavos),
    temFoto: r.temFoto === true,
  };
}

export function parseCampanhaDetalhe(raw: unknown): CampanhaDetalhe {
  const r = obj(raw, 'Detalhe de campanha');
  return {
    ...parseCampanhaItem(r),
    descricao: str(r.descricao),
    cortes: parseIndicadores(r.cortes, numOuNull),
    premios: Array.isArray(r.premios) ? r.premios.map(parsePremio) : [],
    avisar: r.avisar === true,
    criadaPor: strOuNull(r.criadaPor),
    criadaEm: strOuNull(r.criadaEm),
    lancadaPor: strOuNull(r.lancadaPor),
    lancadaEm: strOuNull(r.lancadaEm),
    canceladaEm: strOuNull(r.canceladaEm),
    motivoCancelamento: strOuNull(r.motivoCancelamento),
    fechadaEm: strOuNull(r.fechadaEm),
    notaCorteTop10: numOuNull(r.notaCorteTop10),
  };
}

const SITUACOES_RANKING: SituacaoRanking[] = ['classificado', 'abaixo_corte', 'sem_minimo', 'sem_modal'];

function parseLinha(raw: unknown): LinhaRanking {
  const r = obj(raw, 'Linha do ranking');
  const situacao = SITUACOES_RANKING.includes(r.situacao as SituacaoRanking)
    ? (r.situacao as SituacaoRanking)
    : 'classificado';
  return {
    posicao: numOuNull(r.posicao),
    entregadorId: num(r.entregadorId),
    nome: str(r.nome),
    modal: strOuNull(r.modal),
    situacao,
    turnos: num(r.turnos),
    turnosValidos: numOuNull(r.turnosValidos),
    valorCentavos: numOuNull(r.valorCentavos),
    aceitacao: numOuNull(r.aceitacao),
    conclusao: numOuNull(r.conclusao),
    tempo: numOuNull(r.tempo),
    pedidos: numOuNull(r.pedidos),
    nota: numOuNull(r.nota),
    notaHipotetica: numOuNull(r.notaHipotetica),
    posicaoHipotetica: numOuNull(r.posicaoHipotetica),
    motivoCorte: lista(r.motivoCorte),
    posicaoAnterior: numOuNull(r.posicaoAnterior),
  };
}

export function parseRanking(raw: unknown): RankingResposta {
  const r = obj(raw, 'Ranking');
  if (!Array.isArray(r.itens)) throw new TypeError('Ranking inválido: itens não é array');
  return {
    itens: r.itens.map(parseLinha),
    contagem: parseContagem(r.contagem),
    pagina: num(r.pagina, 1),
    porPagina: num(r.porPagina, 50),
  };
}

function parseVencedor(raw: unknown): Vencedor {
  const r = obj(raw, 'Vencedor');
  const p = (r.premio && typeof r.premio === 'object' ? r.premio : {}) as Obj;
  return {
    posicao: num(r.posicao),
    nome: str(r.nome),
    nota: numOuNull(r.nota),
    premio: {
      tipo: p.tipo === 'dinheiro' ? 'dinheiro' : 'objeto',
      descricao: str(p.descricao),
      valorCentavos: numOuNull(p.valorCentavos),
    },
    entregueEm: strOuNull(r.entregueEm),
    entreguePor: strOuNull(r.entreguePor),
    observacao: strOuNull(r.observacao),
    exportadoEm: strOuNull(r.exportadoEm),
    semCnpj: r.semCnpj === true,
  };
}

export function parseVencedores(raw: unknown): Vencedor[] {
  const r = obj(raw, 'Vencedores');
  if (!Array.isArray(r.itens)) throw new TypeError('Vencedores inválido: itens não é array');
  return r.itens.map(parseVencedor);
}

export function parseOpcoes(raw: unknown): OpcoesCampanha {
  const r = obj(raw, 'Opções de campanha');
  const a = (r.alcance && typeof r.alcance === 'object' ? r.alcance : {}) as Obj;
  return {
    pracas: lista(r.pracas),
    turnos: lista(r.turnos),
    modais: lista(r.modais),
    coberturaPedidos: numOuNull(r.coberturaPedidos),
    alcance: { rodaram: num(a.rodaram), semModal: num(a.semModal) },
  };
}

/** Mesma forma da rota de categorias do adiantamento (`CategoriaProducao`); o backend
 * pode mandar `semMotoristaIdentificado` em camel ou snake — aceita os dois. */
export function parseCategorias(raw: unknown): CategoriaProducao[] {
  const r = obj(raw, 'Categorias');
  if (!Array.isArray(r.itens)) throw new TypeError('Categorias inválidas: itens não é array');
  return r.itens.map((x) => {
    const c = obj(x, 'Categoria');
    return {
      descricao: str(c.descricao),
      lancamentos: num(c.lancamentos),
      semMotoristaIdentificado: (c.semMotoristaIdentificado ?? c.sem_motorista_identificado) === true,
      familia: strOuNull(c.familia),
      primeira: strOuNull(c.primeira),
    };
  });
}

export function parseIdCriado(raw: unknown): number {
  const r = obj(raw, 'Resposta de campanha');
  if (typeof r.id !== 'number') throw new TypeError('Resposta de campanha inválida: id ausente');
  return r.id;
}

/** Dias de calendário restantes (>= 0) de `hoje` (YYYY-MM-DD) até `fim`. */
export function diasAte(fim: string, hoje: string): number {
  const d = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  return Math.max(0, Math.round((d(fim) - d(hoje)) / 86_400_000));
}
