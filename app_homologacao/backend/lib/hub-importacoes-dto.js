/**
 * hub-importacoes-dto.js — helpers PUROS (sem I/O) de borda de API para
 * FASE 5 (tasks.md 5.1-5.8): paginação Range PostgREST, mapeamento
 * snake_case -> camelCase (mesmo padrão de `hub-me.js`/data-model.md
 * §Convenções de Borda), janela padrão de 30 dias e proteção CSV injection
 * (FR-016, checklists/requirements.md CHK017).
 *
 * Extraído para arquivo próprio (em vez de inline em routes/hub-importacoes.js)
 * para ser testável isoladamente sem PostgREST/DB real (node --test), mesmo
 * padrão de lib/hub-import-normalizer.js / lib/hub-import-hash.js.
 *
 * Ref: contracts/importacoes-api.md, data-model.md §Mapa permissão lógica.
 */

'use strict';

const { escaparCelulaCsvInjection, quotarCelulaCsv } = require('./hub-csv');

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;
const JANELA_PADRAO_DIAS = 30;

/**
 * Parseia `page`/`pageSize` da query em paginação Range PostgREST
 * (0-indexed, inclusive). `page` < 1 ou não numérico -> 1. `pageSize` fora
 * de [1, PAGE_SIZE_MAX] -> clamp.
 * @param {object} query - `req.query`
 * @returns {{page:number, pageSize:number, from:number, to:number}}
 */
function parsePaginacao(query) {
  const pageParsed = parseInt(query && query.page, 10);
  const page = Number.isFinite(pageParsed) && pageParsed >= 1 ? pageParsed : 1;

  const pageSizeParsed = parseInt(query && query.pageSize, 10);
  const pageSize = Number.isFinite(pageSizeParsed) && pageSizeParsed >= 1
    ? Math.min(pageSizeParsed, PAGE_SIZE_MAX)
    : PAGE_SIZE_DEFAULT;

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  return { page, pageSize, from, to };
}

/**
 * Resolve a janela `de`/`ate` (filtro `criado_em`) — default últimos 30 dias
 * quando o caller não informa NENHUM dos dois (contract §GET /importacoes:
 * "default últimos 30 dias"). Se o caller informar ao menos um dos dois,
 * respeita a intenção explícita (não força o outro extremo).
 * @param {object} query - `req.query` (`de`/`ate`, ISO 8601 ou data)
 * @param {() => Date} [agora] - injeção de tempo p/ testes determinísticos
 * @returns {{de:string|null, ate:string|null}}
 */
function parseJanelaPadrao(query, agora = () => new Date()) {
  const deInformado = query && query.de;
  const ateInformado = query && query.ate;
  if (!deInformado && !ateInformado) {
    const fimJanela = agora();
    const inicioJanela = new Date(fimJanela.getTime() - JANELA_PADRAO_DIAS * 24 * 60 * 60 * 1000);
    return { de: inicioJanela.toISOString(), ate: null };
  }
  return { de: deInformado || null, ate: ateInformado || null };
}

/** @returns {number|null} duração em segundos (arredondada), ou `null` se
 * qualquer uma das pontas estiver ausente. */
function calcularDuracaoSegundos(iniciadoEm, concluidoEm) {
  if (!iniciadoEm || !concluidoEm) return null;
  const ini = new Date(iniciadoEm).getTime();
  const fim = new Date(concluidoEm).getTime();
  if (!Number.isFinite(ini) || !Number.isFinite(fim) || fim < ini) return null;
  return Math.round((fim - ini) / 1000);
}

/**
 * Mapeia 1 linha `ImportacaoArquivo` (snake_case/PostgREST) para o shape de
 * item de listagem do contrato (camelCase). `aguardandoLock` é campo
 * DERIVADO (não existe coluna própria — dec-032/CHK013): `true` quando
 * `status === 'pending'` E já existe outra importação do MESMO
 * `(id_empresa,tipo)` ativa (`validating`/`processing`) — distingue, no
 * histórico, um `pending` "prestes a começar" de um `pending`
 * "esperando o lock liberar".
 * @param {object} row
 * @param {Set<string>} tiposAtivos - tipos com uma importação
 *   validating/processing em andamento (mesma id_empresa do caller)
 */
function mapImportacaoListItem(row, tiposAtivos = new Set()) {
  return {
    id: row.id,
    tipo: row.tipo,
    status: row.status,
    nomeArquivo: row.nome_arquivo,
    totalLinhas: row.total_linhas,
    linhasValidas: row.linhas_validas,
    linhasInvalidas: row.linhas_invalidas,
    dataReferencia: row.data_referencia,
    criadoPor: row.criado_por,
    iniciadoEm: row.iniciado_em,
    concluidoEm: row.concluido_em,
    duracaoSegundos: calcularDuracaoSegundos(row.iniciado_em, row.concluido_em),
    aguardandoLock: row.status === 'pending' && tiposAtivos.has(row.tipo),
  };
}

/** Mapeia 1 linha `ImportacaoArquivo` para o shape de detalhe/progresso
 * (`GET /importacoes/:id`). */
function mapImportacaoDetalhe(row) {
  return {
    id: row.id,
    tipo: row.tipo,
    status: row.status,
    contadores: {
      total: row.total_linhas,
      validas: row.linhas_validas,
      invalidas: row.linhas_invalidas,
    },
    dataReferencia: row.data_referencia,
    iniciadoEm: row.iniciado_em,
    concluidoEm: row.concluido_em,
    duracaoSegundos: calcularDuracaoSegundos(row.iniciado_em, row.concluido_em),
    erroResumo: row.erro_resumo,
  };
}

/** Mapeia 1 linha `ImportacaoLinhaErro` para o shape do contrato
 * (`GET /importacoes/:id/erros`). `valorMascarado` já vem mascarado do
 * processor (4.5) — este mapper NUNCA expõe outro campo bruto. */
function mapErroItem(row) {
  return {
    numeroLinha: row.numero_linha,
    campo: row.campo,
    motivo: row.motivo,
    valorMascarado: row.valor_mascarado,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Proteção CSV injection (FR-016; CHK017; tasks.md 5.3.2/5.3.4) — implementação
// movida para `lib/hub-csv.js` (hub-faturamento/S6, research.md Decision 6,
// tasks.md 2.1); reexportada aqui para não quebrar o contrato externo deste
// módulo (`escaparCelulaCsvInjection`/`quotarCelulaCsv` continuam disponíveis
// via `require('./hub-importacoes-dto')`, sem mudança de comportamento).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Gera o corpo `text/csv` de `GET /importacoes/:id/erros?format=csv`
 * (tasks.md 5.3.2). Cabeçalho fixo + 1 linha por erro, CRLF (RFC 4180).
 * `valorMascarado` passa pela MESMA proteção de injeção que qualquer outra
 * célula (defesa em profundidade — o valor já é mascarado pelo processor,
 * mas o 1º caractere original é preservado por `mascararValor`, então ainda
 * pode começar com `=`/`+`/`-`/`@`).
 * @param {Array<{numeroLinha:number, campo:string|null, motivo:string, valorMascarado:string|null}>} items
 * @returns {string}
 */
function gerarCsvErros(items) {
  const CABECALHO = ['numeroLinha', 'campo', 'motivo', 'valorMascarado'];
  const linhas = [CABECALHO.join(',')];
  for (const item of items) {
    const celulas = [
      String(item.numeroLinha),
      escaparCelulaCsvInjection(item.campo || ''),
      escaparCelulaCsvInjection(item.motivo || ''),
      escaparCelulaCsvInjection(item.valorMascarado || ''),
    ].map(quotarCelulaCsv);
    linhas.push(celulas.join(','));
  }
  return `${linhas.join('\r\n')}\r\n`;
}

module.exports = {
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  JANELA_PADRAO_DIAS,
  parsePaginacao,
  parseJanelaPadrao,
  calcularDuracaoSegundos,
  mapImportacaoListItem,
  mapImportacaoDetalhe,
  mapErroItem,
  escaparCelulaCsvInjection,
  quotarCelulaCsv,
  gerarCsvErros,
};
