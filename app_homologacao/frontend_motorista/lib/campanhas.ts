/**
 * Campanhas do motorista — lógica pura da UI (testável com `node --test`, sem jsdom).
 * Contrato: docs/plans/campanhas-motorista/CONTRATOS.md §7. O servidor entrega os
 * números; aqui só se derivam os textos ("faltam X pontos", "aceite as próximas K").
 */

import type {
  CampanhaItem,
  CampanhaTela,
  Cortes,
  Indicador,
  MinhaLinha,
  Pesos,
} from './campanhas-api.ts';

export const INDICADORES: Indicador[] = ['aceitacao', 'conclusao', 'tempo', 'pedidos'];

// Mesmos rótulos da tela Performance do hub (sem vocabulário novo).
export const ROTULO_INDICADOR: Record<Indicador, string> = {
  aceitacao: 'Taxa de aceitação',
  conclusao: 'Taxa de conclusão',
  tempo: 'Tempo disponível',
  pedidos: 'Pedidos concluídos',
};

/** 1 casa, vírgula decimal: 90.06 → "90,1". */
export function fmt1(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1).replace('.', ',');
}

export function ordinal(n: number): string {
  return `${n}º`;
}

/** Fração 0..1 → "88,2%". */
export function fmtPct(fracao: number): string {
  return `${fmt1(fracao * 100)}%`;
}

/** Corte de taxa (fração) → "80%" (sem casa quando inteiro). */
export function fmtCortePct(fracao: number): string {
  const v = Math.round(fracao * 1000) / 10;
  return `${String(v).replace('.', ',')}%`;
}

/** "2026-11-21..." → "21/11". */
export function ddmm(iso: string | null | undefined): string {
  const m = iso?.match(/^\d{4}-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[1]}` : '';
}

/** Pontos que faltam para passar quem está acima (1 casa; empate → 0). null = ninguém acima. */
export function faltamPontos(eu: Pick<MinhaLinha, 'nota' | 'acima'>): number | null {
  if (!eu.acima || eu.nota == null) return null;
  return Math.max(0, Math.round((eu.acima.nota - eu.nota) * 10) / 10);
}

export function pontosTexto(n: number): string {
  return `${fmt1(n)} ${n === 1 ? 'ponto' : 'pontos'}`;
}

export interface OndeGanhar {
  indicador: Indicador;
  /** Para taxas: % a mais que soma 1 ponto. Para pedidos: nº de pedidos (null se o líder é desconhecido). */
  passo: number | null;
}

/**
 * Indicador com maior ganho possível = peso × (100 − nota), entre os de peso > 0.
 * 1 ponto na nota final = 100/peso pontos na nota do indicador (taxas: % a mais;
 * pedidos: nota é relativa ao líder, então vale lider.pedidos/peso pedidos).
 * Empate: ordem aceitação, conclusão, tempo, pedidos. Sem folga nenhuma → null.
 */
export function ondeGanharMais(
  pesos: Pesos,
  notas: Record<Indicador, number | null>,
  lider: { pedidos: number } | null,
): OndeGanhar | null {
  let melhor: Indicador | null = null;
  let ganho = 0;
  for (const i of INDICADORES) {
    const peso = pesos[i];
    if (!(peso > 0)) continue;
    const g = peso * (100 - (notas[i] ?? 0));
    if (g > ganho) {
      ganho = g;
      melhor = i;
    }
  }
  if (!melhor) return null;
  const peso = pesos[melhor];
  if (melhor === 'pedidos') {
    const n = lider && lider.pedidos > 0 ? Math.max(1, Math.round(lider.pedidos / peso)) : null;
    return { indicador: melhor, passo: n };
  }
  return { indicador: melhor, passo: Math.round(100 / peso) };
}

export function textoOndeGanhar(o: OndeGanhar): string {
  const nome = ROTULO_INDICADOR[o.indicador].toLowerCase();
  if (o.indicador === 'pedidos') {
    return o.passo == null
      ? `${nome}. Mais pedidos concluídos somam pontos na sua nota.`
      : `${nome}. Cada ${o.passo} ${o.passo === 1 ? 'pedido' : 'pedidos'} a mais soma 1 ponto na sua nota.`;
  }
  const texto = o.indicador === 'tempo' ? 'no tempo online' : `na ${nome}`;
  return `${nome}. Cada ${o.passo}% a mais ${texto} soma 1 ponto na sua nota.`;
}

/**
 * Corridas seguidas necessárias para a taxa alcançar o corte `c` (fração):
 * aceitação = ofertadas/aceitas; conclusão = aceitas/completadas.
 * K = ceil((c·base − parte)/(1 − c)). Já no corte (ou c ≥ 1, sem solução) → null.
 * Tempo/pedidos não têm "próximas corridas" → null (a UI mostra só a distância).
 */
export function corridasParaVoltar(
  indicador: Indicador,
  corte: number | null,
  eu: Pick<MinhaLinha, 'ofertadas' | 'aceitas' | 'completadas'>,
): number | null {
  if (corte == null || !(corte < 1)) return null;
  let base: number;
  let parte: number;
  if (indicador === 'aceitacao') {
    base = eu.ofertadas;
    parte = eu.aceitas;
  } else if (indicador === 'conclusao') {
    base = eu.aceitas;
    parte = eu.completadas;
  } else {
    return null;
  }
  // toFixed(6) antes do ceil: (0.8·200 − 156)/(1 − 0.8) dá 20,000000000000004 em ponto flutuante.
  const k = Math.ceil(Number(((corte * base - parte) / (1 - corte)).toFixed(6)));
  return k > 0 ? k : null;
}

export interface ParaVoltar {
  indicador: Indicador;
  corte: number;
  /** próximas corridas seguidas (aceitação/conclusão) */
  corridas: number | null;
  /** distância até o corte: pontos percentuais (taxas) ou pedidos */
  falta: number | null;
}

/** Um item por indicador que derrubou o motorista do ranking e tem corte definido. */
export function paraVoltar(eu: MinhaLinha, cortes: Cortes): ParaVoltar[] {
  const saida: ParaVoltar[] = [];
  for (const i of eu.motivoCorte) {
    const corte = cortes[i];
    if (corte == null) continue;
    const leitura = eu.leituras[i];
    const falta =
      leitura == null
        ? null
        : i === 'pedidos'
          ? Math.max(0, corte - leitura)
          : Math.max(0, Math.round((corte - leitura) * 1000) / 10);
    saida.push({ indicador: i, corte, corridas: corridasParaVoltar(i, corte, eu), falta });
  }
  return saida;
}

export interface Variacao {
  tipo: 'subiu' | 'desceu' | 'manteve' | 'novo';
  /** módulo da variação (0 para manteve/novo) */
  delta: number;
}

export function variacaoPosicao(anterior: number | null | undefined, atual: number): Variacao {
  if (anterior == null) return { tipo: 'novo', delta: 0 };
  const d = anterior - atual;
  if (d > 0) return { tipo: 'subiu', delta: d };
  if (d < 0) return { tipo: 'desceu', delta: -d };
  return { tipo: 'manteve', delta: 0 };
}

export function textoVariacao(v: Variacao): string {
  const pl = (n: number) => `${n} ${n === 1 ? 'posição' : 'posições'}`;
  switch (v.tipo) {
    case 'subiu':
      return `subiu ${pl(v.delta)} desde ontem`;
    case 'desceu':
      return `desceu ${pl(v.delta)} desde ontem`;
    case 'manteve':
      return 'manteve a posição desde ontem';
    default:
      return 'novo no ranking';
  }
}

export interface Regressiva {
  dias: number;
  horas: number;
  minutos: number;
  encerrou: boolean;
}

/** Contagem até `dataFim` 23:59:59 (America/Sao_Paulo, -03:00). */
export function contagemRegressiva(dataFim: string, agora: Date | number = Date.now()): Regressiva {
  const fim = Date.parse(`${dataFim.slice(0, 10)}T23:59:59-03:00`);
  const ms = fim - (typeof agora === 'number' ? agora : agora.getTime());
  if (!(ms > 0)) return { dias: 0, horas: 0, minutos: 0, encerrou: true };
  const min = Math.floor(ms / 60_000);
  return { dias: Math.floor(min / 1440), horas: Math.floor((min % 1440) / 60), minutos: min % 60, encerrou: false };
}

export function textoTermino(dataFim: string, agora: Date | number = Date.now()): string {
  const r = contagemRegressiva(dataFim, agora);
  if (r.encerrou) return 'termina hoje';
  if (r.dias === 0) return 'termina hoje';
  return `termina em ${r.dias} ${r.dias === 1 ? 'dia' : 'dias'}`;
}

/** Faixa do prêmio: "1º", "2º e 3º", "4º ao 10º". */
export function faixaRotulo(de: number, ate: number): string {
  if (ate <= de) return ordinal(de);
  if (ate === de + 1) return `${ordinal(de)} e ${ordinal(ate)}`;
  return `${ordinal(de)} ao ${ordinal(ate)}`;
}

/** Hoje em São Paulo (yyyy-mm-dd). */
export function hojeSP(agora: Date | number = Date.now()): string {
  const t = typeof agora === 'number' ? agora : agora.getTime();
  return new Date(t - 3 * 3_600_000).toISOString().slice(0, 10);
}

/** Dias inteiros de `de` até `ate` (yyyy-mm-dd); negativo se `ate` é anterior. */
export function diasEntre(de: string, ate: string): number {
  return Math.round((Date.parse(`${ate.slice(0, 10)}T00:00:00Z`) - Date.parse(`${de.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

/** Janela em que o resultado de uma campanha encerrada ainda aparece na Início. */
export const DIAS_RESULTADO_NA_INICIO = 7;

/**
 * Campanha do card da Início, por prioridade:
 * 1. em andamento (melhor posição; sem posição, a que termina primeiro);
 * 2. encerrada com posição minha, fim há no máximo 7 dias (dia 7 entra, dia 8 não);
 * 3. agendada (a que começa primeiro);
 * 4. apurando.
 */
export function escolherCampanha(itens: CampanhaItem[], agora: Date | number = Date.now()): CampanhaItem | null {
  const porFim = (a: CampanhaItem, b: CampanhaItem) => a.dataFim.localeCompare(b.dataFim);
  const ativas = itens.filter((c) => c.situacao === 'em_andamento');
  if (ativas.length) {
    return [...ativas].sort((a, b) => {
      const pa = a.minhaPosicao ?? Infinity;
      const pb = b.minhaPosicao ?? Infinity;
      return pa !== pb ? pa - pb : porFim(a, b);
    })[0];
  }
  const hoje = hojeSP(agora);
  const resultados = itens.filter(
    (c) => c.situacao === 'encerrada' && c.minhaPosicao != null && diasEntre(c.dataFim, hoje) <= DIAS_RESULTADO_NA_INICIO,
  );
  if (resultados.length) return [...resultados].sort((a, b) => porFim(b, a))[0];
  const agendadas = itens.filter((c) => c.situacao === 'agendada');
  if (agendadas.length) return [...agendadas].sort((a, b) => a.dataInicio.localeCompare(b.dataInicio))[0];
  const apurando = itens.filter((c) => c.situacao === 'apurando');
  return apurando.length ? [...apurando].sort(porFim)[0] : null;
}

export type ModoCard = 'andamento' | 'resultado' | 'agendada' | 'apurando';

export function modoCard(c: Pick<CampanhaItem, 'situacao'>): ModoCard {
  return c.situacao === 'encerrada' ? 'resultado' : c.situacao === 'agendada' ? 'agendada' : c.situacao === 'apurando' ? 'apurando' : 'andamento';
}

/** "Começa em 3 dias" / "Começa amanhã" / "Começa hoje". */
export function textoComeca(dataInicio: string, agora: Date | number = Date.now()): string {
  const n = diasEntre(hojeSP(agora), dataInicio);
  if (n <= 0) return 'Começa hoje';
  return n === 1 ? 'Começa amanhã' : `Começa em ${n} dias`;
}

export type EstadoMotorista = 'classificado' | 'abaixo_corte' | 'sem_minimo' | 'sem_modal' | 'sem_linha';

/** Estado do motorista a partir da lista (card) — o detalhe é opcional. */
export function estadoDoItem(c: Pick<CampanhaItem, 'minhaSituacao' | 'minhaPosicao'>): EstadoMotorista {
  if (c.minhaSituacao === 'classificado' && c.minhaPosicao != null) return 'classificado';
  if (c.minhaSituacao === 'abaixo_corte') return 'abaixo_corte';
  if (c.minhaSituacao === 'sem_minimo') return 'sem_minimo';
  if (c.minhaSituacao === 'sem_modal') return 'sem_modal';
  return 'sem_linha';
}

export type EstadoTela = 'encerrada' | EstadoMotorista;

export function estadoTela(t: Pick<CampanhaTela, 'campanha' | 'eu'>): EstadoTela {
  if (t.campanha.situacao === 'encerrada') return 'encerrada';
  const eu = t.eu;
  if (!eu) return 'sem_linha';
  return estadoDoItem({ minhaSituacao: eu.situacao, minhaPosicao: eu.posicao });
}

/** Turnos que faltam para o mínimo (≥ 0). */
export function turnosFaltantes(minTurnos: number, turnos: number): number {
  return Math.max(0, minTurnos - turnos);
}

/** Classificado fora do top 10: ganha a linha separada "Você · Nº" no fim. */
export function foraDoTop10(t: Pick<CampanhaTela, 'eu' | 'top10'>): boolean {
  const eu = t.eu;
  return !!eu && eu.situacao === 'classificado' && eu.posicao != null && !t.top10.some((l) => l.souEu);
}

/** "Jantar em SÃO PAULO · só moto · 10 a 30/11" a partir dos filtros da campanha. */
export function resumoPublico(c: Pick<CampanhaTela['campanha'], 'pracas' | 'turnos' | 'modais' | 'dataInicio' | 'dataFim'>): string {
  const partes: string[] = [];
  if (c.turnos?.length) partes.push(c.turnos.join(', '));
  if (c.pracas?.length) partes.push(c.pracas.join(', '));
  if (c.modais?.length) partes.push(`só ${c.modais.join(', ').toLowerCase()}`);
  const ini = c.dataInicio.slice(8, 10);
  partes.push(`${ini} a ${ddmm(c.dataFim)}`);
  return partes.join(' · ');
}

/** "Marcos V." → "MV"; "Você" → "V". */
export function iniciais(nome: string): string {
  const p = nome.replace(/\./g, '').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}

/** "Aceitação abaixo de 80% tira do ranking" para cada corte definido. */
export function textoCortes(cortes: Cortes): string[] {
  const saida: string[] = [];
  if (cortes.aceitacao != null) saida.push(`Aceitação abaixo de ${fmtCortePct(cortes.aceitacao)} tira do ranking.`);
  if (cortes.conclusao != null) saida.push(`Conclusão abaixo de ${fmtCortePct(cortes.conclusao)} tira do ranking.`);
  if (cortes.tempo != null) saida.push(`Tempo disponível abaixo de ${fmtCortePct(cortes.tempo)} tira do ranking.`);
  if (cortes.pedidos != null) saida.push(`Menos de ${cortes.pedidos} pedidos concluídos tira do ranking.`);
  return saida;
}

/** "Ranking com os dados até ontem (21/11)" — "ontem" só quando `dadosAte` é de fato ontem (SP). */
export function textoDadosAte(dadosAte: string | null, agora: Date | number = Date.now()): string {
  if (!dadosAte) return 'Ranking ainda não calculado';
  const t = typeof agora === 'number' ? agora : agora.getTime();
  const ontem = new Date(t - 3 * 3_600_000 - 86_400_000).toISOString().slice(0, 10);
  const data = ddmm(dadosAte);
  return dadosAte.slice(0, 10) === ontem
    ? `Ranking com os dados até ontem (${data})`
    : `Ranking com os dados até ${data}`;
}
