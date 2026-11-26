// campanhas do motorista (W3a) — modelo do formulário, validação e formatação
// (funções puras, testadas). Limites = CONTRATOS.md §4; o backend e o banco
// validam de novo — aqui é para a pessoa ver o erro antes do envio.

import {
  INDICADORES_CAMPANHA,
  ROTULO_INDICADOR_CAMPANHA,
  diasAte,
  type CampanhaDetalhe,
  type CampanhaItem,
  type SituacaoCampanha,
  type Cortes,
  type IndicadorCampanha,
  type MinTurnosBase,
  type Pesos,
  type TipoCampanha,
  type TipoPremio,
} from './campanhas-dto';
import { TETO_CENTAVOS } from './lancamento-externo';

export const LIMITES = {
  nomeMin: 3,
  nomeMax: 120,
  descricaoMax: 1000,
  duracaoMaxDias: 92,
  descarteMax: 60,
  /** Mesma folga do backend: data do prêmio até fim + 365 dias. */
  dataPremioFolgaDias: 365,
  minTurnosMin: 1,
  minTurnosMax: 200,
  corteMaxPedidos: 100000,
  premiosMax: 20,
  posicaoMax: 500,
  descricaoPremioMax: 200,
  /** Prêmio em dinheiro: teto do Lançamento externo, importado — não redigitado. */
  dinheiroMaxCentavos: TETO_CENTAVOS,
  /** Mesmo teto do banco (CHECK da 0129): 1..60 categorias no extrato. */
  categoriasMax: 60,
  fotoMaxBytes: 512000,
  /** Abaixo disso o indicador Pedidos não pode ser usado (CONTRATOS §4). */
  coberturaPedidosMin: 0.95,
} as const;

export interface PremioForm {
  /** Chave estável só da UI (não vai para a API). */
  chave: string;
  /** Id do prêmio já salvo (rascunho em edição) — necessário para a foto. */
  id: number | null;
  posicaoDe: number;
  posicaoAte: number;
  tipo: TipoPremio;
  descricao: string;
  valorCentavos: number | null;
  temFoto: boolean;
}

export interface FormularioCampanha {
  tipo: TipoCampanha;
  /** Nomes exatos ou tokens de família. Obrigatório no extrato; opcional na nota (vazio = todos os turnos). */
  categorias: string[];
  minTurnosBase: MinTurnosBase;
  nome: string;
  descricao: string;
  dataInicio: string;
  dataFim: string;
  /** null = todas/todos. */
  pracas: string[] | null;
  turnos: string[] | null;
  modais: string[] | null;
  minTurnos: number;
  pesos: Pesos;
  cortes: Cortes;
  premios: PremioForm[];
  /** Turnos de até N min sem nenhuma corrida são descartados (0 = não descarta; padrão 5). */
  descarteTurnoMin: number;
  /** Data de pagamento/entrega do prêmio (YYYY-MM-DD); vazio = sem data. */
  dataPremio: string;
  avisar: boolean;
  /** Visível no app do motorista; toda campanha nasce oculta. */
  visivelApp: boolean;
}

export function formularioVazio(): FormularioCampanha {
  return {
    tipo: 'nota',
    categorias: [],
    minTurnosBase: 'trabalhados',
    nome: '',
    descricao: '',
    dataInicio: '',
    dataFim: '',
    pracas: null,
    turnos: null,
    modais: null,
    minTurnos: 5,
    pesos: { aceitacao: 0, conclusao: 0, tempo: 0, pedidos: 0 },
    cortes: { aceitacao: null, conclusao: null, tempo: null, pedidos: null },
    premios: [],
    descarteTurnoMin: 5,
    dataPremio: '',
    avisar: true,
    visivelApp: false,
  };
}

let seq = 0;
export function novaChavePremio(): string {
  seq += 1;
  return `premio-${seq}`;
}

export function premioVazio(posicaoDe = 1): PremioForm {
  return {
    chave: novaChavePremio(),
    id: null,
    posicaoDe,
    posicaoAte: posicaoDe,
    tipo: 'objeto',
    descricao: '',
    valorCentavos: null,
    temFoto: false,
  };
}

export function formularioDeDetalhe(d: CampanhaDetalhe): FormularioCampanha {
  return {
    tipo: d.tipo,
    categorias: d.categorias ?? [],
    minTurnosBase: d.minTurnosBase,
    nome: d.nome,
    descricao: d.descricao,
    dataInicio: d.dataInicio,
    dataFim: d.dataFim,
    pracas: d.pracas,
    turnos: d.turnos,
    modais: d.modais,
    minTurnos: d.minTurnos,
    pesos: { ...d.pesos },
    cortes: { ...d.cortes },
    premios: d.premios.map((p) => ({
      chave: novaChavePremio(),
      id: p.id,
      posicaoDe: p.posicaoDe,
      posicaoAte: p.posicaoAte,
      tipo: p.tipo,
      descricao: p.descricao,
      valorCentavos: p.valorCentavos,
      temFoto: p.temFoto,
    })),
    descarteTurnoMin: d.descarteTurnoMin,
    dataPremio: d.dataPremio ?? '',
    avisar: d.avisar,
    visivelApp: d.visivelApp,
  };
}

/** Corpo do POST/PUT (CONTRATOS §7). Sem as chaves só-de-UI dos prêmios. */
export function formularioParaCorpo(f: FormularioCampanha) {
  return {
    tipo: f.tipo,
    // Nota: categorias opcionais (vazio = null = todos os turnos); extrato: obrigatórias e pesos todos 0.
    categorias: f.categorias.length > 0 ? f.categorias : null,
    ...(f.tipo === 'extrato' ? { minTurnosBase: f.minTurnosBase } : {}),
    nome: f.nome.trim(),
    descricao: f.descricao.trim(),
    dataInicio: f.dataInicio,
    dataFim: f.dataFim,
    pracas: f.pracas,
    turnos: f.turnos,
    modais: f.modais,
    minTurnos: f.minTurnos,
    pesos: f.tipo === 'extrato' ? { aceitacao: 0, conclusao: 0, tempo: 0, pedidos: 0 } : f.pesos,
    cortes: f.cortes,
    premios: f.premios.map((p) => ({
      // id só das faixas já salvas: o banco o usa para preservar a foto. Faixa nova vai sem id.
      ...(p.id !== null ? { id: p.id } : {}),
      posicaoDe: p.posicaoDe,
      posicaoAte: p.posicaoAte,
      tipo: p.tipo,
      descricao: p.descricao.trim(),
      valorCentavos: p.valorCentavos,
    })),
    descarteTurnoMin: f.descarteTurnoMin,
    dataPremio: f.dataPremio || null,
    avisar: f.avisar,
    visivelApp: f.visivelApp,
  };
}

// ── conversões de unidade (fronteira percentual × fração) ───────────────────

/** "80" / "80,5" (o que a pessoa digita) → fração 0..1 (4 casas); vazio → null; ilegível → NaN. */
export function percentualParaFracao(texto: string): number | null {
  const t = texto.trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return Number.NaN;
  return Math.round((n / 100) * 10000) / 10000;
}

export function fracaoParaPercentual(f: number | null): string {
  if (f === null) return '';
  return String(Math.round(f * 10000) / 100).replace('.', ',');
}

// ── validação ───────────────────────────────────────────────────────────────

export interface ContextoValidacao {
  /** YYYY-MM-DD de hoje em São Paulo. */
  hoje: string;
  /** Fração 0..1, ou null quando o público não tem dado nenhum. */
  coberturaPedidos: number | null;
  /** true = checagens exclusivas do lançamento (fim no passado). */
  paraLancar: boolean;
}

export type ErrosFormulario = Record<string, string>;

export const somaPesos = (p: Pesos): number => INDICADORES_CAMPANHA.reduce((s, i) => s + p[i], 0);

/** Pedidos só pode ser usado com cobertura >= 95% (CONTRATOS §4). */
export function pedidosBloqueado(cobertura: number | null): boolean {
  return cobertura === null || cobertura < LIMITES.coberturaPedidosMin;
}

const diasEntre = (a: string, b: string) =>
  Math.round(
    (Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) -
      Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) /
      86_400_000
  );

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Faixas sobrepostas? (2–3 e 3–5 se sobrepõem; 1–1 e 2–3 não.) */
export function faixasSobrepostas(faixas: { posicaoDe: number; posicaoAte: number }[]): boolean {
  const ord = [...faixas].sort((a, b) => a.posicaoDe - b.posicaoDe || a.posicaoAte - b.posicaoAte);
  return ord.some((f, i) => i > 0 && f.posicaoDe <= ord[i - 1].posicaoAte);
}

const inteiro = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

export function validarFormulario(f: FormularioCampanha, ctx: ContextoValidacao): ErrosFormulario {
  const e: ErrosFormulario = {};
  const nome = f.nome.trim();
  if (nome.length < LIMITES.nomeMin || nome.length > LIMITES.nomeMax) {
    e.nome = `O nome precisa ter de ${LIMITES.nomeMin} a ${LIMITES.nomeMax} caracteres.`;
  }
  if (f.descricao.trim().length > LIMITES.descricaoMax) {
    e.descricao = `A descrição pode ter no máximo ${LIMITES.descricaoMax} caracteres.`;
  }

  // período
  if (!DATA_RE.test(f.dataInicio)) e.dataInicio = 'Informe a data de início.';
  if (!DATA_RE.test(f.dataFim)) e.dataFim = 'Informe a data de fim.';
  if (!e.dataInicio && !e.dataFim) {
    const dur = diasEntre(f.dataInicio, f.dataFim) + 1;
    if (dur < 1) e.dataFim = 'O fim não pode ser antes do início.';
    else if (dur > LIMITES.duracaoMaxDias) {
      e.dataFim = `A campanha pode durar no máximo ${LIMITES.duracaoMaxDias} dias (esta tem ${dur}).`;
    }
  }
  if (ctx.paraLancar && !e.dataFim && f.dataFim < ctx.hoje) {
    e.dataFim = 'Para lançar, o fim precisa ser hoje ou depois.';
  }
  if (f.dataPremio !== '') {
    if (!DATA_RE.test(f.dataPremio)) e.dataPremio = 'Data do prêmio inválida.';
    else if (!e.dataInicio && f.dataPremio < f.dataInicio) {
      e.dataPremio = 'A data do prêmio não pode ser antes do início da campanha.';
    } else if (!e.dataFim && diasEntre(f.dataFim, f.dataPremio) > LIMITES.dataPremioFolgaDias) {
      e.dataPremio = `A data do prêmio pode ir até ${LIMITES.dataPremioFolgaDias} dias depois do fim.`;
    }
  }
  if (!inteiro(f.descarteTurnoMin) || f.descarteTurnoMin < 0 || f.descarteTurnoMin > LIMITES.descarteMax) {
    e.descarteTurnoMin = `O descarte vai de 0 a ${LIMITES.descarteMax} minutos (0 = não descarta).`;
  }

  // público (listas vazias não existem: "todas" é null)
  for (const campo of ['pracas', 'turnos', 'modais'] as const) {
    const v = f[campo];
    if (v !== null && (v.length < 1 || v.length > 50)) {
      e[campo] = 'Escolha de 1 a 50 itens, ou marque "Todas/Todos".';
    }
  }
  if (!inteiro(f.minTurnos) || f.minTurnos < LIMITES.minTurnosMin || f.minTurnos > LIMITES.minTurnosMax) {
    e.minTurnos = `O mínimo de turnos vai de ${LIMITES.minTurnosMin} a ${LIMITES.minTurnosMax}.`;
  }

  const extrato = f.tipo === 'extrato';

  // pesos (o extrato não tem peso: o que ordena é o valor somado)
  const pesosOk = INDICADORES_CAMPANHA.every((i) => inteiro(f.pesos[i]) && f.pesos[i] >= 0 && f.pesos[i] <= 100);
  if (!extrato) {
    if (!pesosOk) e.pesos = 'Cada peso é um número inteiro de 0 a 100.';
    else if (somaPesos(f.pesos) !== 100) e.pesos = `Os pesos precisam somar 100 (hoje somam ${somaPesos(f.pesos)}).`;
  }

  // cortes
  for (const i of INDICADORES_CAMPANHA) {
    const c = f.cortes[i];
    if (c === null) continue;
    const rotulo = ROTULO_INDICADOR_CAMPANHA[i];
    if (Number.isNaN(c)) e[`corte.${i}`] = `Corte de ${rotulo}: número inválido.`;
    else if (!extrato && pesosOk && f.pesos[i] === 0) e[`corte.${i}`] = `${rotulo} tem peso 0: tire o corte ou dê peso.`;
    else if (i === 'pedidos') {
      if (!inteiro(c) || c < 1 || c > LIMITES.corteMaxPedidos) {
        e[`corte.${i}`] = `Corte de pedidos: inteiro de 1 a ${LIMITES.corteMaxPedidos}.`;
      }
    } else if (c < 0 || c > 1) e[`corte.${i}`] = `Corte de ${rotulo}: de 0% a 100%.`;
  }

  if (extrato) {
    // E2/E3: ao menos 1 critério com mínimo e ao menos 1 categoria de valor.
    if (!INDICADORES_CAMPANHA.some((i) => f.cortes[i] !== null)) {
      e.cortes = 'Marque ao menos 1 critério e informe o mínimo no turno.';
    }
    if (f.categorias.length < 1) e.categorias = 'Marque ao menos 1 categoria para compor o valor do turno.';
  }
  if (f.categorias.length > LIMITES.categoriasMax) {
    e.categorias = `Marque no máximo ${LIMITES.categoriasMax} categorias.`;
  }

  // pedidos exige cobertura (só na nota: no extrato turno sem a leitura simplesmente não vale)
  if (!extrato && f.pesos.pedidos > 0 && pedidosBloqueado(ctx.coberturaPedidos)) {
    e['pesos.pedidos'] =
      ctx.coberturaPedidos === null
        ? 'Sem dado de pedidos concluídos neste público: use peso 0 em Pedidos concluídos.'
        : `Só ${Math.round(ctx.coberturaPedidos * 100)}% dos turnos deste público têm pedidos concluídos (mínimo 95%): use peso 0 em Pedidos concluídos.`;
  }

  // prêmios
  if (f.premios.length < 1 || f.premios.length > LIMITES.premiosMax) {
    e.premios = `Cadastre de 1 a ${LIMITES.premiosMax} faixas de prêmio.`;
  } else {
    f.premios.forEach((p, idx) => {
      const k = `premio.${idx}`;
      if (!inteiro(p.posicaoDe) || !inteiro(p.posicaoAte) || p.posicaoDe < 1 || p.posicaoAte < p.posicaoDe || p.posicaoAte > LIMITES.posicaoMax) {
        e[`${k}.faixa`] = `Faixa inválida: de 1 até ${LIMITES.posicaoMax}, e o "até" não pode ser menor que o "de".`;
      }
      const d = p.descricao.trim();
      if (d.length < 1 || d.length > LIMITES.descricaoPremioMax) {
        e[`${k}.descricao`] = `Descreva o prêmio (até ${LIMITES.descricaoPremioMax} caracteres).`;
      }
      if (p.tipo === 'dinheiro') {
        if (!inteiro(p.valorCentavos) || p.valorCentavos < 1 || p.valorCentavos > LIMITES.dinheiroMaxCentavos) {
          e[`${k}.valor`] = `Prêmio em dinheiro: de R$ 0,01 a R$ ${(LIMITES.dinheiroMaxCentavos / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}.`;
        }
      } else if (p.valorCentavos !== null && (!inteiro(p.valorCentavos) || p.valorCentavos < 1)) {
        e[`${k}.valor`] = 'Valor estimado inválido (deixe vazio ou informe um valor positivo).';
      }
    });
    if (!Object.keys(e).some((k) => k.endsWith('.faixa')) && faixasSobrepostas(f.premios)) {
      e.premios = 'Há faixas de prêmio sobrepostas (ex.: 2º–3º e 3º–5º). Cada posição só pode ter um prêmio.';
    }
  }
  return e;
}

/** O extrato fecha sozinho 3 dias depois do fim (E5). "YYYY-MM-DD" → "DD/MM"; inválida → null. */
export function fechamentoExtrato(dataFim: string): string | null {
  if (!DATA_RE.test(dataFim)) return null;
  const d = new Date(Date.UTC(+dataFim.slice(0, 4), +dataFim.slice(5, 7) - 1, +dataFim.slice(8, 10) + 3));
  return formatDiaMes(d.toISOString().slice(0, 10));
}

// ── formatação ──────────────────────────────────────────────────────────────

export function formatNota(n: number | null): string {
  return n === null ? '—' : n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

/** Fração 0..1 → "96,2%". */
export function formatFracao(f: number | null): string {
  return f === null ? '—' : `${(f * 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

export function formatCentavos(c: number | null): string {
  return c === null ? '—' : (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** "2026-11-10" → "10/11" (ou "10/11/2026" com `ano`). */
export function formatDiaMes(iso: string, ano = false): string {
  if (!DATA_RE.test(iso.slice(0, 10))) return '—';
  const [a, m, d] = iso.slice(0, 10).split('-');
  return ano ? `${d}/${m}/${a}` : `${d}/${m}`;
}

export function formatPeriodo(inicio: string, fim: string): string {
  return `${formatDiaMes(inicio)} – ${formatDiaMes(fim)}`;
}

const ord = (n: number) => `${n}º`;

/** 1–1 → "1º lugar"; 2–3 → "2º e 3º"; 4–10 → "4º ao 10º". */
export function rotuloFaixa(de: number, ate: number): string {
  if (de === ate) return de === 1 ? '1º lugar' : ord(de);
  if (ate === de + 1) return `${ord(de)} e ${ord(ate)}`;
  return `${ord(de)} ao ${ord(ate)}`;
}

/** "Aceitação 30 · Conclusão 30 · …" só dos indicadores com peso > 0. */
export function resumoPesos(pesos: Pesos, cortes?: Cortes): string {
  return INDICADORES_CAMPANHA.filter((i) => pesos[i] > 0)
    .map((i: IndicadorCampanha) => {
      const c = cortes?.[i] ?? null;
      const corte = c === null ? '' : i === 'pedidos' ? ` (corte ${c})` : ` (corte ${formatFracao(c).replace(',0%', '%')})`;
      return `${ROTULO_INDICADOR_CAMPANHA[i]} ${pesos[i]}%${corte}`;
    })
    .join(' · ');
}

/** Extrato: "Taxa de aceitação ≥ 90% · Tempo disponível ≥ 70%" — o mínimo conferido em cada turno. */
export function resumoCriterios(cortes: Cortes): string {
  return INDICADORES_CAMPANHA.filter((i) => cortes[i] !== null)
    .map((i) => {
      const c = cortes[i] as number;
      return `${ROTULO_INDICADOR_CAMPANHA[i]} ≥ ${i === 'pedidos' ? `${c} pedidos` : formatFracao(c).replace(',0%', '%')}`;
    })
    .join(' · ');
}

// ── helpers de entrada ──────────────────────────────────────────────────────

/** Marca/desmarca um item numa seleção múltipla onde `null` = "Todas/Todos".
 * Esvaziar a lista volta a `null` (lista vazia não existe no contrato). */
export function alternarSelecao(atual: string[] | null, item: string): string[] | null {
  const base = atual ?? [];
  const prox = base.includes(item) ? base.filter((x) => x !== item) : [...base, item];
  return prox.length === 0 ? null : prox;
}

/** Reais no formato BR → centavos. Aceita "100", "100,5", "100,50", "1.234,56"; vazio → null.
 * Qualquer outra coisa (inclusive "100.50", que é decimal à moda americana e
 * viraria 10050 reais) → NaN: melhor recusar que errar por fator 100.
 * (Não havia parser monetário reaproveitável no frontend: os existentes só
 * trocam vírgula por ponto, em campos que nunca levam milhar.) */
export function reaisParaCentavos(texto: string): number | null {
  const t = texto.trim();
  if (t === '') return null;
  if (!/^(\d{1,3}(\.\d{3})+|\d+)(,\d{1,2})?$/.test(t)) return Number.NaN;
  const [inteiro, dec = ''] = t.replace(/\./g, '').split(',');
  return Number(inteiro) * 100 + Number(dec.padEnd(2, '0'));
}

export function centavosParaReais(c: number | null): string {
  return c === null ? '' : (c / 100).toFixed(2).replace('.', ',');
}

/** Hoje em São Paulo, YYYY-MM-DD (mesma regra do banco: `hub_hoje_sp()`). */
export function hojeSP(agora: Date = new Date()): string {
  return agora.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
}

const TIPOS_FOTO = ['image/jpeg', 'image/png', 'image/webp'];

/** Pré-checagem da foto (o servidor confere os bytes de verdade). null = ok. */
export function erroFoto(arquivo: { type: string; size: number }): string | null {
  if (!TIPOS_FOTO.includes(arquivo.type)) return 'A foto precisa ser JPEG, PNG ou WebP.';
  if (arquivo.size > LIMITES.fotoMaxBytes) return 'A foto pode ter no máximo 500 KB.';
  return null;
}

// ── textos da lista e do detalhe ────────────────────────────────────────────

/** "SAO PAULO · turnos JANTAR 18H-22H · mín. 5 turnos" (null = todas/todos). */
export function escopoTexto(c: Pick<CampanhaItem, 'pracas' | 'turnos' | 'modais' | 'minTurnos' | 'tipo' | 'minTurnosBase'>): string {
  const partes = [
    c.pracas === null ? 'Todas as praças' : c.pracas.join(', '),
    c.turnos === null ? 'todos os turnos' : `turnos ${c.turnos.join(', ')}`,
  ];
  if (c.modais !== null) partes.push(`modal ${c.modais.join(', ')}`);
  partes.push(`mín. ${c.minTurnos} turnos${c.tipo === 'extrato' ? (c.minTurnosBase === 'validos' ? ' válidos' : ' trabalhados') : ''}`);
  return partes.join(' · ');
}

export function participantesTexto(c: CampanhaItem, hoje: string): string {
  switch (c.situacao) {
    case 'agendada': {
      const d = diasAte(c.dataInicio, hoje);
      return d === 0 ? 'começa hoje' : d === 1 ? 'começa amanhã' : `começa em ${d} dias`;
    }
    case 'rascunho':
      return '—';
    case 'cancelada':
      return 'cancelada';
    default: {
      const base = `${c.contagem.classificado} no ranking · ${c.contagem.abaixoCorte} abaixo do corte`;
      return c.situacao === 'encerrada' && c.premiosPendentes > 0
        ? `${base} · ${c.premiosPendentes} prêmios a entregar`
        : base;
    }
  }
}

export function acaoDaSituacao(s: SituacaoCampanha): { rotulo: string; editar: boolean } {
  if (s === 'rascunho') return { rotulo: 'Editar', editar: true };
  if (s === 'em_andamento' || s === 'apurando') return { rotulo: 'Acompanhar', editar: false };
  if (s === 'encerrada') return { rotulo: 'Ver vencedores', editar: false };
  return { rotulo: 'Ver', editar: false };
}

/** CONTRATOS §3: fechamento manual só em `apurando` e a partir de fim + 3 dias. */
export function podeFecharAntecipado(situacao: SituacaoCampanha, dataFim: string, hoje: string): boolean {
  return situacao === 'apurando' && diasAte(hoje, dataFim) >= 3;
}

export const MOTIVO_CORTE_LABEL: Record<string, string> = {
  aceitacao: 'Aceitação abaixo do corte',
  conclusao: 'Conclusão abaixo do corte',
  tempo: 'Tempo disponível abaixo do corte',
  pedidos: 'Pedidos abaixo do corte',
};

/** Timestamp ISO → "12/11 18:42" no fuso de São Paulo. */
export function formatDataHora(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('day')}/${g('month')} ${g('hour')}:${g('minute')}`;
}
