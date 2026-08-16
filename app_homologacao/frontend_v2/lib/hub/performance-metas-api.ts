// impeccable r24 parte 2 — cliente das metas de performance.
//
// Usa o molde compartilhado (`criarRequest`/`mensagemPorCodigo` de
// `lib/hub/api.ts`), o mesmo de `performance-api.ts` — não um `fetch` próprio.
//
// ⚠️ FRONTEIRA DE UNIDADE. Este arquivo é o único lugar do frontend que
// converte entre as duas linguagens:
//
//   API / banco : FRAÇÃO 0..1   (0.9)   — migration 0048 tem CHECK
//   pessoa      : PERCENTUAL    (90%)   — ninguém digita "0,9" para 90%
//
// Deixar as duas escalas soltas pela tela é como se produz um erro por fator
// 100 que ninguém vê: 90% virando 9000% aprova tudo, e 0,9% reprova tudo. As
// funções de conversão e validação têm teste próprio.

import { HubApiError, criarRequest, mensagemPorCodigo, codigoDoErro } from './api';

export type IndicadorMeta = 'aceitacao' | 'conclusao' | 'tempo_disponivel';

export const INDICADORES_META: ReadonlyArray<{ id: IndicadorMeta; rotulo: string; ajuda: string }> = [
  { id: 'aceitacao', rotulo: 'Taxa de aceitação', ajuda: 'Corridas aceitas sobre as ofertadas no turno.' },
  { id: 'conclusao', rotulo: 'Taxa de conclusão', ajuda: 'Corridas completadas sobre as aceitas no turno.' },
  {
    id: 'tempo_disponivel',
    rotulo: 'Tempo disponível',
    ajuda: 'Parte do turno em que a pessoa esteve disponível.',
  },
];

export interface MetaPerformance {
  id: number;
  praca: string;
  periodo: string;
  indicador: IndicadorMeta;
  /** Fração 0..1, como veio da API — nunca percentual. */
  valor: number;
  atualizadoEm: string | null;
}

const MENSAGENS_CODIGO: Record<string, string> = {
  NAO_AUTENTICADO: 'Sua sessão expirou. Faça login novamente.',
  ENTIDADE_NAO_SELECIONADA: 'Selecione uma entidade antes de continuar.',
  PERMISSAO_NEGADA: 'Você não tem permissão para definir metas.',
  PRACA_OBRIGATORIA: 'Informe a praça.',
  PERIODO_OBRIGATORIO: 'Informe o turno.',
  INDICADOR_INVALIDO: 'Indicador desconhecido.',
  VALOR_INVALIDO: 'Use apenas números na meta.',
  // O backend fala em fração 0..1; a pessoa preencheu porcentagem. A mensagem
  // é escrita na língua de quem lê o formulário.
  VALOR_FORA_DA_FAIXA: 'A meta é uma porcentagem entre 0 e 100.',
  META_NAO_ENCONTRADA: 'Essa meta já não existe.',
  ID_INVALIDO: 'Meta inválida.',
  ERRO_SERVIDOR: 'Erro no servidor. Tente novamente em instantes.',
};

export class MetasApiError extends HubApiError {
  readonly name = 'MetasApiError';
}

const request = criarRequest(
  (status, body) =>
    new MetasApiError(status, mensagemPorCodigo(MENSAGENS_CODIGO, body, status), codigoDoErro(body))
);

const INDICADORES_VALIDOS: IndicadorMeta[] = ['aceitacao', 'conclusao', 'tempo_disponivel'];

/** `0.85` -> `85`. Para exibir e para preencher o campo. */
export function fracaoParaPercentual(fracao: number): number {
  return Math.round(fracao * 1000) / 10;
}

/** `85` (o que a pessoa digitou) -> `0.85` (o que a API aceita). */
export function percentualParaFracao(percentual: number): number {
  return Math.round(percentual * 10) / 1000;
}

/**
 * Valida o percentual digitado ANTES de virar fração. Devolve a mensagem em
 * português ou `null`.
 *
 * O teto é 100 e não 1: aqui a linguagem é percentual, e recusar "150%" com
 * "valor fora da faixa 0..1" seria falar a língua do banco com quem está
 * preenchendo um formulário.
 */
export function validarPercentual(bruto: string): string | null {
  const texto = bruto.trim().replace(',', '.');
  if (!texto) return 'Informe a meta.';
  const n = Number(texto);
  if (!Number.isFinite(n)) return 'Use apenas números (ex.: 90 ou 90,5).';
  if (n < 0) return 'A meta não pode ser negativa.';
  if (n > 100) return 'A meta é uma porcentagem: no máximo 100.';
  return null;
}

export function parseMeta(bruto: unknown): MetaPerformance {
  const r = (bruto ?? {}) as Record<string, unknown>;
  const indicador = r.indicador as IndicadorMeta;
  if (typeof r.id !== 'number' || !INDICADORES_VALIDOS.includes(indicador)) {
    throw new TypeError('Meta inválida na resposta da API.');
  }
  const valor = typeof r.valor === 'string' ? Number.parseFloat(r.valor) : Number(r.valor);
  if (!Number.isFinite(valor)) throw new TypeError('Meta sem valor numérico.');
  return {
    id: r.id,
    praca: String(r.praca ?? ''),
    periodo: String(r.periodo ?? ''),
    indicador,
    valor,
    atualizadoEm: typeof r.atualizadoEm === 'string' ? r.atualizadoEm : null,
  };
}

export async function listarMetas(): Promise<MetaPerformance[]> {
  const raw = await request<{ metas?: unknown[] }>('/performance/metas');
  return Array.isArray(raw?.metas) ? raw.metas.map(parseMeta) : [];
}

export async function salvarMeta(entrada: {
  praca: string;
  periodo: string;
  indicador: IndicadorMeta;
  /** Fração 0..1 — quem chama já converteu com `percentualParaFracao`. */
  valor: number;
}): Promise<MetaPerformance> {
  const raw = await request<{ meta: unknown }>('/performance/metas', {
    method: 'PUT',
    body: JSON.stringify(entrada),
  });
  return parseMeta(raw.meta);
}

export async function removerMeta(id: number): Promise<void> {
  await request<void>(`/performance/metas/${id}`, { method: 'DELETE' });
}

/**
 * Chave do cruzamento praça × turno × indicador — espelha `chaveMeta` de
 * `backend/lib/hub-performance-meta.js`, incluindo a regra de normalização:
 * caixa e espaços nas pontas não criam cruzamentos distintos, mas ACENTO sim
 * (praças podem se distinguir por ele, e achatar isso fundiria duas
 * configurações legítimas).
 */
export function chaveMeta(praca: string, periodo: string, indicador: string): string {
  return `${praca.trim().toLowerCase()}|${periodo.trim().toLowerCase()}|${indicador}`;
}

/**
 * Leitura de um registro de turno na MESMA unidade das metas (fração 0..1).
 * `tempoDisponivelPct` vem em 0..100 da API e é o único que precisa dividir —
 * mesma regra de `normalizarLeitura` no backend, e mesma armadilha.
 */
export function leiturasDoRegistro(registro: {
  corridasOfertadas: number | null;
  corridasAceitas: number | null;
  corridasCompletadas: number | null;
  tempoDisponivelPct: string | number | null;
}): Record<IndicadorMeta, number | null> {
  const razao = (parte: number | null, todo: number | null) =>
    parte === null || todo === null || !(todo > 0) ? null : parte / todo;

  const tempoBruto =
    typeof registro.tempoDisponivelPct === 'string'
      ? Number.parseFloat(registro.tempoDisponivelPct)
      : registro.tempoDisponivelPct;

  return {
    aceitacao: razao(registro.corridasAceitas, registro.corridasOfertadas),
    conclusao: razao(registro.corridasCompletadas, registro.corridasAceitas),
    tempo_disponivel: Number.isFinite(tempoBruto as number) ? (tempoBruto as number) / 100 : null,
  };
}
