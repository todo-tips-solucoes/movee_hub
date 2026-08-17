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

/**
 * Sentinela de "qualquer praça / qualquer turno" — a META PADRÃO da entidade,
 * espelhando `META_PADRAO` de `backend/lib/hub-performance-meta.js`.
 *
 * O operador definiu três patamares globais (tempo online ≥90%, aceitas ≥90%,
 * completadas ≥95%) com o cruzamento praça × turno como exceção. Guardar o
 * padrão como linha `*`/`*` evita colunas anuláveis: no PG13 a unique trata
 * NULLs como distintos, e duas linhas "padrão" caberiam sem a unique reclamar.
 */
export const META_PADRAO = '*';

/**
 * Os patamares que o operador informou como contrato vigente (2026-08-17).
 * São SUGESTÃO de preenchimento, não gravação automática: nenhuma meta passa a
 * valer sem alguém salvar — a tela não decide o contrato de ninguém sozinha.
 */
export const METAS_SUGERIDAS: Record<IndicadorMeta, number> = {
  tempo_disponivel: 90,
  aceitacao: 90,
  conclusao: 95,
};

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

/**
 * Casas decimais de PERCENTUAL que sobrevivem à gravação.
 *
 * A coluna é `numeric(5,4)` (migration 0048) = 4 casas de fração = **2 casas
 * de percentual**. O conversor original arredondava para 3 casas de fração e
 * jogava a segunda casa fora: revisão adversarial mediu que **9000 de 10001**
 * percentuais de duas casas não sobreviviam à ida e volta — e `99,95` virava
 * `1`, ou seja, meta de **100%**, transformando o patamar contratual em
 * perfeição obrigatória sem avisar ninguém. Como não há tela de edição (só
 * adicionar e remover), a pessoa nunca via o valor antes de ele mudar.
 */
const CASAS_PERCENTUAL = 2;
const FATOR = 10 ** CASAS_PERCENTUAL;

/** `0.8542` -> `85.42`. Para exibir e para preencher o campo. */
export function fracaoParaPercentual(fracao: number): number {
  return Math.round(fracao * 100 * FATOR) / FATOR;
}

/** `85.42` (o que a pessoa digitou) -> `0.8542` (o que a API aceita). */
export function percentualParaFracao(percentual: number): number {
  return Math.round(percentual * FATOR) / (100 * FATOR);
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

/**
 * Suspeita de erro por fator 100 na direção OPOSTA — e ela existia sem guarda
 * nenhuma. A validação barra `> 100` (quem digitou 9000 querendo 90%), mas
 * `0,9` querendo dizer 90% passava direto e virava meta de **0,9%**: tudo
 * fica verde para sempre naquele cruzamento, que é a falha silenciosa
 * simétrica à que o produto diz combater.
 *
 * Aviso, não bloqueio: meta de 0,5% pode ser legítima em algum indicador, e
 * recusar seria decidir pelo operador. Devolve a pergunta a fazer, ou `null`.
 */
export function suspeitaDeUnidade(percentual: number): string | null {
  if (percentual > 0 && percentual < 1) {
    const provavel = fracaoParaPercentual(percentual);
    return `${percentual.toLocaleString('pt-BR')}% é menos de um por cento. Você quis dizer ${provavel.toLocaleString('pt-BR')}%?`;
  }
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
 * Forma canônica de praça/turno — espelha `canonizarTexto` de
 * `backend/lib/hub-performance-meta.js` e `hub_meta_canonica()` da migration
 * 0049. As três TÊM de concordar: enquanto o banco guardava o texto cru e a
 * chave normalizava caixa, `"SAO PAULO"` e `"Sao Paulo"` viravam duas linhas
 * e uma chave, com a última vencendo em silêncio (reproduzido contra o
 * ambiente real antes da correção).
 *
 * `normalize('NFC')` não é detalhe: a mesma letra acentuada tem duas
 * representações de bytes, visualmente idênticas. Sem isso, uma meta é
 * gravada, aparece na lista e nunca marca nada.
 */
export function canonizarTexto(bruto: string | null | undefined): string {
  if (typeof bruto !== 'string') return '';
  return bruto.normalize('NFC').replace(/\s+/g, ' ').trim().toUpperCase();
}

/**
 * Chave do cruzamento praça × turno × indicador, sobre a forma canônica.
 *
 * `JSON.stringify` de um array em vez de juntar com `|`: o separador estava
 * dentro do alfabeto possível do dado, e `["SP|NOITE","X"]` colidia com
 * `["SP","NOITE|X"]`. Espelha `chaveMeta` do backend.
 */
export function chaveMeta(praca: string, periodo: string, indicador: string): string {
  return JSON.stringify([canonizarTexto(praca), canonizarTexto(periodo), indicador]);
}

/**
 * Resolve a meta que vale para um registro: a do CRUZAMENTO específico vence;
 * não havendo, vale o PADRÃO da entidade (`*`/`*`); não havendo nenhum dos
 * dois, não há meta — e sem meta não há julgamento.
 *
 * A ordem importa e é a única que faz sentido: um patamar acordado para uma
 * praça específica existe justamente para se sobrepor ao geral.
 */
export function metaAplicavel(
  metasPorChave: Map<string, number>,
  praca: string | null,
  periodo: string | null,
  indicador: IndicadorMeta
): number | undefined {
  const especifica = metasPorChave.get(chaveMeta(praca ?? '', periodo ?? '', indicador));
  if (especifica !== undefined) return especifica;
  return metasPorChave.get(chaveMeta(META_PADRAO, META_PADRAO, indicador));
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
