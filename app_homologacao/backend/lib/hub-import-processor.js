/**
 * hub-import-processor.js — máquina de estados + pipeline de processamento
 * em lote (tasks.md FASE 4, 4.1-4.6). Ref: research.md Decision 5 (ADENDO
 * dec-033/CHK036), 6, 7, 8, 9, 10; data-model.md migrations 0011-0014;
 * contracts/importacoes-api.md §Convenção de máquina de estados; briefing
 * s4-pipeline-importacoes.md; 01-plano-tecnico.md §12.1.
 *
 * ── Interface `ImportJob` (research.md Decision 10 — isolada para plugar
 * fila depois sem refazer o pipeline) ────────────────────────────────────
 *   @typedef {Object} ImportJob
 *   @property {number} importacaoId - id de `ImportacaoArquivo`
 *   @property {number} idEmpresa
 *   @property {'faturamento'|'performance'} tipo
 *   @property {object} claims - claims para `hubPostgrestRequest`
 *     ({ usuarioId, empresaAtiva, escopo }); reusado também para a PRÓXIMA
 *     importação `pending` da fila (ver `tentarIniciarProximaPendente`) —
 *     seguro porque as policies RLS (migration 0015) escopam por
 *     `escopo`/`id_empresa`, não por `usuarioId`.
 *
 * `processarImportacao(job)` é o ÚNICO ponto de entrada público do
 * pipeline: hoje chamado diretamente (fire-and-forget) por
 * `routes/hub-importacoes.js` logo após o upload; amanhã, se o volume
 * exigir fila (gatilho documentado: arquivo > 50k linhas ou timeout de
 * request — Decision 10), um worker de fila chamaria a MESMA função sem
 * mudar nada abaixo.
 *
 * ── Mutex de concorrência (research.md Decision 5, ADENDO dec-033) ──────
 * NÃO usa `pg_try_advisory_lock` (premissa original invalidada: o backend
 * do hub fala com o Postgres via PostgREST, HTTP stateless, sem sessão
 * dedicada — ver ADENDO). "Adquirir o lock" = UPDATE atômico
 * `status='pending' -> 'validating'`; se outra linha do MESMO
 * `(id_empresa,tipo)` já está `validating`/`processing`, o índice único
 * parcial (migration 0011) rejeita a transição (Postgres unique_violation
 * -> PostgREST 409) e esta chamada simplesmente NÃO adquire — a
 * importação PERMANECE `pending` (sem 409 ao cliente; 409 é só duplicidade
 * de hash). Ao final de QUALQUER processamento (sucesso/falha/cancelado),
 * `tentarIniciarProximaPendente` busca a próxima `pending` do mesmo
 * `(id_empresa,tipo)` e a dispara — implementa "demais aguardam, inicia
 * automaticamente" sem precisar de fila/cron.
 *
 * ── Rollback estrutural SEM `DELETE` (decisão de implementação, ver
 * comentário mais abaixo em `executarPipeline`) ──────────────────────────
 * `FaturamentoLancamento`/`PerformanceTurno` (migrations 0013/0014) NÃO
 * concedem `DELETE`/`UPDATE` a `authenticated` — são fatos append-only por
 * desenho ("fato append-only... dedupe por hash_linha, reprocessar não
 * sobrescreve" — comentário das próprias migrations). Em vez de inserir e
 * depois apagar (o que exigiria uma migration nova só para o rollback),
 * este processor faz **parse completo em memória primeiro** (todas as
 * linhas do arquivo — tipicamente 4-8k, ordem de poucos MB): só decide
 * `failed` (>50% inválidas) ou segue para INSERT depois de já saber o
 * resultado. Efeito observável idêntico ao "rollback total" descrito em
 * research.md Decision 7 (zero linhas persistidas em caso de falha
 * estrutural) — na verdade uma garantia MAIS forte (nenhuma linha fica
 * visível nem transitoriamente a um leitor concorrente).
 */

'use strict';

const { hubPostgrestRequest: hubPostgrestRequestReal } = require('./hub-postgrest');
const { registrarAuditoria: registrarAuditoriaReal } = require('./hub-auditoria');
const { extensaoDe, caminhoArmazenamento } = require('./hub-import-storage');
const {
  resolverConteudoCsv,
  iterarLinhas,
  bufferParaStream,
} = require('./hub-import-parser');
const {
  indiceHeader,
  validarHeader,
  normalizarLinhaFaturamento,
  normalizarLinhaPerformance,
  CAMPOS_HASH_FATURAMENTO,
  CAMPOS_HASH_PERFORMANCE,
} = require('./hub-import-normalizer');
const { hashLinha } = require('./hub-import-hash');

// ────────────────────────────────────────────────────────────────────────────
// Constantes (research.md Decision 6/9/10; plano técnico §12.6)
// ────────────────────────────────────────────────────────────────────────────

const TAMANHO_LOTE = 500;
const LIMIAR_INVALIDAS = 0.5; // >50% -> failed (research.md Decision 7)
const TIMEOUT_IMPORTACAO_MS = 120 * 1000; // plano técnico §12.6

const TABELA_FATO = { faturamento: 'FaturamentoLancamento', performance: 'PerformanceTurno' };
const NORMALIZAR = { faturamento: normalizarLinhaFaturamento, performance: normalizarLinhaPerformance };
const CAMPOS_HASH = { faturamento: CAMPOS_HASH_FATURAMENTO, performance: CAMPOS_HASH_PERFORMANCE };

// ────────────────────────────────────────────────────────────────────────────
// Máquina de estados (4.1.2; contracts/importacoes-api.md §Convenção)
// ────────────────────────────────────────────────────────────────────────────

const ESTADOS = [
  'pending', 'validating', 'processing',
  'completed', 'completed_with_errors', 'failed', 'cancelled',
];
const ESTADOS_TERMINAIS = ['completed', 'completed_with_errors', 'failed', 'cancelled'];

/** Transições permitidas (fonte da verdade: contracts/importacoes-api.md
 * §Convenção de máquina de estados). `failed`/`cancelled` -> `pending`
 * (reprocessar) é FASE 5 — incluído aqui só para a tabela ficar completa e
 * o teste unitário (4.1.3) cobrir a transição prevista pelo contrato. */
const TRANSICOES_VALIDAS = {
  pending: ['validating', 'cancelled'],
  validating: ['processing', 'failed', 'cancelled'],
  processing: ['completed', 'completed_with_errors', 'failed', 'cancelled'],
  completed: [],
  completed_with_errors: [],
  failed: ['pending'],
  cancelled: ['pending'],
};

/** @returns {boolean} se `de -> para` é uma transição permitida da máquina
 * de estados (4.1.2/4.1.3). Estado desconhecido em qualquer lado -> false
 * (fail-closed). */
function transicaoValida(de, para) {
  if (!ESTADOS.includes(de) || !ESTADOS.includes(para)) return false;
  return TRANSICOES_VALIDAS[de].includes(para);
}

// ────────────────────────────────────────────────────────────────────────────
// Mascaramento LGPD (4.5.2; research.md Decision 8 — "NUNCA grava a linha
// bruta"). Universal: aplica-se a QUALQUER campo (não só UUID/nome) — mais
// conservador que uma allowlist de "campos sensíveis" e satisfaz o
// requisito 4.5.4 ("nunca retorna o valor original em NENHUM branch") sem
// depender de manter uma lista de campos pessoais sincronizada com o
// normalizador.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Mascara 1 valor bruto para `ImportacaoLinhaErro.valor_mascarado`. NUNCA
 * retorna a string original intacta (4.5.4): mantém só o 1º e o último
 * caractere, substitui o miolo por `*`. Vazio/nulo passam através (não há
 * conteúdo para vazar). Strings de 1-2 chars viram só asteriscos.
 * @param {*} valorBruto
 * @returns {string|null}
 */
function mascararValor(valorBruto) {
  if (valorBruto === null || valorBruto === undefined) return null;
  const str = String(valorBruto).trim();
  if (str === '') return '';
  if (str.length <= 2) return '*'.repeat(str.length);
  return `${str[0]}${'*'.repeat(str.length - 2)}${str[str.length - 1]}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Injeção de dependências (testabilidade — 4.7: unit tests SEM PostgREST/DB
// real, mockando `deps.hubPostgrestRequest`/`deps.lerArquivo`).
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_DEPS = {
  hubPostgrestRequest: hubPostgrestRequestReal,
  registrarAuditoria: registrarAuditoriaReal,
  lerArquivo: (caminho) => require('node:fs/promises').readFile(caminho),
  agoraMs: () => Date.now(),
  isoAgora: () => new Date().toISOString(),
};

// ────────────────────────────────────────────────────────────────────────────
// Lock (4.2) — UPDATE atômico no índice único parcial (research.md
// Decision 5 ADENDO). "Ocupado" = PostgREST devolve 409 (unique_violation)
// OU 0 linhas afetadas (a linha já não está mais `pending`).
// ────────────────────────────────────────────────────────────────────────────

/**
 * @param {ImportJob} job
 * @param {typeof DEFAULT_DEPS} deps
 * @returns {Promise<boolean>} true se o lock foi adquirido (linha
 *   transicionou pending->validating nesta chamada)
 */
async function tentarAdquirirLock(job, deps = DEFAULT_DEPS) {
  try {
    const linhas = await deps.hubPostgrestRequest(
      `ImportacaoArquivo?id=eq.${job.importacaoId}&status=eq.pending`,
      'PATCH',
      { status: 'validating', iniciado_em: deps.isoAgora() },
      job.claims
    );
    return Array.isArray(linhas) && linhas.length > 0;
  } catch (err) {
    if (err && err.status === 409) return false; // índice único parcial colidiu — outra ativa
    throw err;
  }
}

/** Busca a próxima `pending` do MESMO `(id_empresa,tipo)` (FIFO por
 * `criado_em`) e a dispara (fire-and-forget) — 4.2.2 "inicia
 * automaticamente quando o lock libera". Best-effort: falha aqui nunca
 * derruba o processamento que ACABOU DE terminar com sucesso. */
async function tentarIniciarProximaPendente(job, deps = DEFAULT_DEPS) {
  try {
    const pendentes = await deps.hubPostgrestRequest(
      `ImportacaoArquivo?id_empresa=eq.${job.idEmpresa}&tipo=eq.${job.tipo}&status=eq.pending&order=criado_em.asc&limit=1&select=id`,
      'GET', null, job.claims
    );
    if (pendentes && pendentes.length > 0) {
      const proximoId = pendentes[0].id;
      // Encadeamento assíncrono deliberado (sem await): não bloqueia o
      // retorno do job atual; próxima importação processa em background.
      processarImportacao({ ...job, importacaoId: proximoId }, deps).catch((e) => {
        console.error('[hub-import-processor] falha ao iniciar próxima importação pendente:', e.message);
      });
    }
  } catch (e) {
    console.error('[hub-import-processor] falha ao buscar próxima importação pendente:', e.message);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Cancelamento (4.6) — checagem "ponto seguro" entre lotes/antes do insert.
// ────────────────────────────────────────────────────────────────────────────

/** @returns {Promise<boolean>} true se o registro já foi marcado
 * `cancelled` por outra chamada concorrente (ex.: futuro
 * POST /importacoes/:id/cancelar — FASE 5). Best-effort: falha na
 * checagem NUNCA interrompe o processamento (assume não-cancelado). */
async function foiCancelado(job, deps = DEFAULT_DEPS) {
  try {
    const linhas = await deps.hubPostgrestRequest(
      `ImportacaoArquivo?id=eq.${job.importacaoId}&select=status`,
      'GET', null, job.claims
    );
    return Boolean(linhas && linhas[0] && linhas[0].status === 'cancelled');
  } catch (_e) {
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Regra >50% inválidas (4.4) — função pura, testável isoladamente (4.7.3).
// ────────────────────────────────────────────────────────────────────────────

/** @returns {'failed'|'ok'} */
function computarStatusLimiar(total, invalidas) {
  if (total === 0) return 'failed';
  return (invalidas / total) > LIMIAR_INVALIDAS ? 'failed' : 'ok';
}

// ────────────────────────────────────────────────────────────────────────────
// Retentativa 1x em erro transiente (4.3.3).
// ────────────────────────────────────────────────────────────────────────────

function errorTransiente(err) {
  if (!err) return false;
  if (!err.status) return true; // falha de rede (fetch rejeitou sem status)
  return err.status >= 500;
}

async function executarComRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!errorTransiente(err)) throw err;
    return fn(); // 1 retentativa; 2ª falha propaga
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Upsert de Entregador (research.md Decision 9) — por lote, dedupe por
// `id_externo` DENTRO do lote (mantém o nome mais recente encontrado).
// ────────────────────────────────────────────────────────────────────────────

async function upsertEntregadoresDoLote(job, lote, deps) {
  const mapaNomes = new Map();
  lote.forEach(({ valores }) => {
    const idExterno = valores.id_externo;
    if (!idExterno) return;
    const nome = job.tipo === 'faturamento' ? valores.recebedor : valores.pessoa_entregadora;
    if (nome) mapaNomes.set(idExterno, nome);
    else if (!mapaNomes.has(idExterno)) mapaNomes.set(idExterno, null);
  });
  if (mapaNomes.size === 0) return new Map();

  const payload = Array.from(mapaNomes.entries()).map(([idExterno, nome]) => ({
    id_empresa: job.idEmpresa,
    id_externo: idExterno,
    nome,
  }));

  const resultado = await executarComRetry(() => deps.hubPostgrestRequest(
    'Entregador?on_conflict=id_empresa,id_externo',
    'POST',
    payload,
    job.claims,
    { resolution: 'merge-duplicates' }
  ));

  const idPorExterno = new Map();
  (resultado || []).forEach((linha) => idPorExterno.set(linha.id_externo, linha.id));
  return idPorExterno;
}

// ────────────────────────────────────────────────────────────────────────────
// Construção dos fatos por tipo (data-model.md migrations 0013/0014).
// ────────────────────────────────────────────────────────────────────────────

function construirFatoFaturamento(job, valores, hash, entregadorId) {
  return {
    id_empresa: job.idEmpresa,
    importacao_id: job.importacaoId,
    entregador_id: entregadorId || null,
    recebedor_agregado: entregadorId ? null : valores.recebedor,
    data_lancamento: valores.data_lancamento,
    data_referencia: valores.data_referencia,
    data_repasse: valores.data_repasse,
    periodo: valores.periodo,
    praca: valores.praca,
    subpraca: valores.subpraca,
    origem: valores.origem,
    tipo: valores.tipo,
    valor: valores.valor,
    descricao: valores.descricao,
    atingido: valores.atingido,
    pct_tempo_disponivel: valores.pct_tempo_disponivel,
    pct_aceitacao: valores.pct_aceitacao,
    pct_conclusao: valores.pct_conclusao,
    criterio_tempo_disponivel: valores.criterio_tempo_disponivel,
    criterio_rotas_aceitas: valores.criterio_rotas_aceitas,
    criterio_rotas_concluidas: valores.criterio_rotas_concluidas,
    margem_fee_raw: valores.margem_fee_raw,
    margem_fee_min: valores.margem_fee_min,
    margem_fee_inter: valores.margem_fee_inter,
    hash_linha: hash,
  };
}

function construirFatoPerformance(job, valores, hash, entregadorId) {
  return {
    id_empresa: job.idEmpresa,
    importacao_id: job.importacaoId,
    entregador_id: entregadorId || null,
    data_periodo: valores.data_periodo,
    periodo: valores.periodo,
    duracao: valores.duracao,
    min_entregadores_escala: valores.min_entregadores_escala,
    tag: valores.tag,
    praca: valores.praca,
    subpraca: valores.subpraca,
    origem: valores.origem,
    tempo_disponivel_pct: valores.tempo_disponivel_pct,
    tempo_disponivel: valores.tempo_disponivel,
    corridas_ofertadas: valores.corridas_ofertadas,
    corridas_aceitas: valores.corridas_aceitas,
    corridas_rejeitadas: valores.corridas_rejeitadas,
    corridas_completadas: valores.corridas_completadas,
    corridas_canceladas: valores.corridas_canceladas,
    pedidos_concluidos: valores.pedidos_concluidos,
    taxas_centavos: valores.taxas_centavos,
    hash_linha: hash,
  };
}

const CONSTRUIR_FATO = { faturamento: construirFatoFaturamento, performance: construirFatoPerformance };

/** Insere 1 lote de até 500 linhas válidas: upsert de Entregador (Decision
 * 9) seguido do bulk insert do fato com `ON CONFLICT (id_empresa,
 * hash_linha) DO NOTHING` (Decision 6 — idempotência por linha). */
async function inserirLoteFatos(job, lote, deps) {
  const idPorExterno = await upsertEntregadoresDoLote(job, lote, deps);
  const construir = CONSTRUIR_FATO[job.tipo];
  const payload = lote.map(({ valores, hash }) => construir(
    job, valores, hash, valores.id_externo ? (idPorExterno.get(valores.id_externo) || null) : null
  ));
  await executarComRetry(() => deps.hubPostgrestRequest(
    `${TABELA_FATO[job.tipo]}?on_conflict=id_empresa,hash_linha`,
    'POST',
    payload,
    job.claims,
    { resolution: 'ignore-duplicates', returnMinimal: true }
  ));
}

async function inserirLoteErros(job, lote, deps) {
  await executarComRetry(() => deps.hubPostgrestRequest(
    'ImportacaoLinhaErro',
    'POST',
    lote,
    job.claims,
    { returnMinimal: true }
  ));
}

// Janela de teste (OPCIONAL, opt-in via env var — 4.6.3): dá tempo para um
// teste de integração real emitir `UPDATE "ImportacaoArquivo" SET
// status='cancelled'` entre 2 lotes de um arquivo grande e observar a
// interrupção de fato (em vez de só simular via mock, como os unit tests
// 4.7 já fazem). NÃO lido em produção (env var ausente -> 0ms, no-op total
// — `Number(undefined)` é `NaN`, tratado como 0 abaixo).
function delayEntreLotesParaTeste() {
  const ms = Number(process.env.HUB_IMPORT_TEST_LOTE_DELAY_MS);
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Percorre `linhasValidas` em lotes de `TAMANHO_LOTE`, checando o
 * cancelamento (4.6.1) ANTES de cada lote — "ponto seguro de interrupção".
 * @returns {Promise<{cancelado: boolean}>} */
async function processarLotesValidas(job, linhasValidas, deps) {
  for (let i = 0; i < linhasValidas.length; i += TAMANHO_LOTE) {
    // eslint-disable-next-line no-await-in-loop
    if (await foiCancelado(job, deps)) return { cancelado: true };
    const lote = linhasValidas.slice(i, i + TAMANHO_LOTE);
    // eslint-disable-next-line no-await-in-loop
    await inserirLoteFatos(job, lote, deps);
    // eslint-disable-next-line no-await-in-loop
    await delayEntreLotesParaTeste();
  }
  return { cancelado: false };
}

async function processarLotesErros(job, errosLinha, deps) {
  for (let i = 0; i < errosLinha.length; i += TAMANHO_LOTE) {
    const lote = errosLinha.slice(i, i + TAMANHO_LOTE);
    // eslint-disable-next-line no-await-in-loop
    await inserirLoteErros(job, lote, deps);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Transições terminais + Auditoria (best-effort — nunca derruba o pipeline)
// ────────────────────────────────────────────────────────────────────────────

async function marcarFailed(job, motivo, deps, extra = {}) {
  await deps.hubPostgrestRequest(`ImportacaoArquivo?id=eq.${job.importacaoId}`, 'PATCH', {
    status: 'failed',
    erro_resumo: motivo,
    concluido_em: deps.isoAgora(),
    total_linhas: extra.total ?? null,
    linhas_validas: extra.validas ?? null,
    linhas_invalidas: extra.invalidas ?? null,
  }, job.claims);
  await deps.registrarAuditoria({
    idEmpresa: job.idEmpresa,
    acao: 'importacao.falhou',
    recurso: 'ImportacaoArquivo',
    recursoId: job.importacaoId,
    detalhes: { motivo, ...extra },
    claims: job.claims,
  });
}

async function marcarCancelled(job, deps, extra = {}) {
  await deps.hubPostgrestRequest(`ImportacaoArquivo?id=eq.${job.importacaoId}`, 'PATCH', {
    status: 'cancelled',
    concluido_em: deps.isoAgora(),
    total_linhas: extra.total ?? null,
    linhas_validas: extra.validas ?? null,
    linhas_invalidas: extra.invalidas ?? null,
  }, job.claims);
  await deps.registrarAuditoria({
    idEmpresa: job.idEmpresa,
    acao: 'importacao.cancelada_durante_processamento',
    recurso: 'ImportacaoArquivo',
    recursoId: job.importacaoId,
    detalhes: extra,
    claims: job.claims,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Pipeline principal (4.1 + 4.3 + 4.4 + 4.5 + 4.6)
// ────────────────────────────────────────────────────────────────────────────

/**
 * @param {ImportJob} job
 * @param {typeof DEFAULT_DEPS} deps
 * @returns {Promise<{status: string, total?: number, validas?: number, invalidas?: number}>}
 */
async function executarPipeline(job, deps = DEFAULT_DEPS) {
  const inicioMs = deps.agoraMs();

  const infoLinhas = await deps.hubPostgrestRequest(
    `ImportacaoArquivo?id=eq.${job.importacaoId}&select=id,nome_arquivo`,
    'GET', null, job.claims
  );
  if (!infoLinhas || infoLinhas.length === 0) {
    throw new Error(`ImportacaoArquivo ${job.importacaoId} não encontrada — não é possível processar`);
  }
  const nomeArquivo = infoLinhas[0].nome_arquivo || '';
  const extensao = extensaoDe(nomeArquivo);
  const caminho = caminhoArmazenamento(job.importacaoId, extensao);

  let bufferArquivo;
  try {
    bufferArquivo = await deps.lerArquivo(caminho);
  } catch (errLeitura) {
    await marcarFailed(job, `arquivo original inacessível: ${errLeitura.code || errLeitura.message}`, deps);
    return { status: 'failed' };
  }

  let conteudoCsv;
  try {
    conteudoCsv = resolverConteudoCsv(bufferArquivo, { nomeArquivo });
  } catch (errParse) {
    await marcarFailed(job, `conteúdo inválido: ${errParse.motivo || errParse.message}`, deps);
    return { status: 'failed' };
  }

  const iterador = iterarLinhas(bufferParaStream(conteudoCsv));
  const primeira = await iterador.next();
  if (primeira.done) {
    await marcarFailed(job, 'arquivo vazio (sem cabeçalho)', deps, { total: 0, validas: 0, invalidas: 0 });
    return { status: 'failed' };
  }

  // status=validating: cabeçalho esperado? (01-plano-tecnico.md §12.1)
  const { valido } = validarHeader(primeira.value.campos, job.tipo);
  if (!valido) {
    await marcarFailed(job, 'cabeçalho não corresponde ao esperado para este tipo de importação', deps, { total: 0, validas: 0, invalidas: 0 });
    return { status: 'failed' };
  }

  // status=processing (transição validating->processing; não conflita com
  // o índice único parcial — ambos os estados contam como "ativo").
  await deps.hubPostgrestRequest(`ImportacaoArquivo?id=eq.${job.importacaoId}`, 'PATCH', { status: 'processing' }, job.claims);

  const idx = indiceHeader(primeira.value.campos);
  const normalizarLinha = NORMALIZAR[job.tipo];
  const camposHash = CAMPOS_HASH[job.tipo];

  const linhasValidas = [];
  const errosLinha = [];
  let total = 0;
  let invalidasCount = 0;

  // Parse COMPLETO em memória antes de qualquer INSERT (ver cabeçalho do
  // arquivo — evita depender de DELETE, que a tabela de fatos não concede).
  // eslint-disable-next-line no-restricted-syntax
  for await (const linha of iterador) {
    total += 1;
    const { valores, erros } = normalizarLinha(linha.campos, idx);
    if (erros.length > 0) {
      invalidasCount += 1;
      erros.forEach((erro) => {
        errosLinha.push({
          importacao_id: job.importacaoId,
          id_empresa: job.idEmpresa,
          numero_linha: linha.numeroLinha,
          motivo: erro.motivo,
          campo: erro.campo || null,
          valor_mascarado: mascararValor(erro.valorBruto),
        });
      });
    } else {
      linhasValidas.push({ valores, hash: hashLinha(valores, camposHash), numeroLinha: linha.numeroLinha });
    }
  }

  const validasCount = linhasValidas.length;

  if (total === 0) {
    await marcarFailed(job, 'arquivo sem linhas de dados (apenas cabeçalho)', deps, { total: 0, validas: 0, invalidas: 0 });
    return { status: 'failed' };
  }

  // 4.4 — regra >50% inválidas: decide ANTES de qualquer INSERT (rollback
  // "por construção" — nenhuma linha desta importação jamais foi gravada).
  if (computarStatusLimiar(total, invalidasCount) === 'failed') {
    const pct = Math.round((invalidasCount / total) * 1000) / 10;
    await marcarFailed(
      job,
      `${invalidasCount}/${total} linhas inválidas (${pct}% > limiar de ${LIMIAR_INVALIDAS * 100}%) — importação recusada, nenhuma linha persistida`,
      deps,
      { total, validas: validasCount, invalidas: invalidasCount }
    );
    return { status: 'failed' };
  }

  // 4.6 — ponto seguro de cancelamento antes de iniciar os inserts.
  if (await foiCancelado(job, deps)) {
    await marcarCancelled(job, deps, { total, validas: validasCount, invalidas: invalidasCount });
    return { status: 'cancelled' };
  }

  let resultadoLotes;
  try {
    resultadoLotes = await processarLotesValidas(job, linhasValidas, deps);
  } catch (errLote) {
    // 4.3.3 — falha transiente já foi retentada 1x dentro do lote; se
    // ainda assim falhou, é falha de infraestrutura (não de dado) ->
    // failed com resumo explícito (distinto do >50% inválidas).
    await marcarFailed(job, `falha de infraestrutura ao inserir lote: ${errLote.message}`, deps, { total, validas: validasCount, invalidas: invalidasCount });
    return { status: 'failed' };
  }

  if (resultadoLotes.cancelado) {
    await marcarCancelled(job, deps, { total, validas: validasCount, invalidas: invalidasCount });
    return { status: 'cancelled' };
  }

  // 4.5 — erros por linha (best-effort de detalhamento: os fatos JÁ foram
  // gravados com sucesso; uma falha aqui não deve reverter isso).
  try {
    await processarLotesErros(job, errosLinha, deps);
  } catch (errErros) {
    console.error('[hub-import-processor] falha ao gravar ImportacaoLinhaErro (não bloqueia a importação):', errErros.message);
  }

  const dataReferencia = linhasValidas.length > 0
    ? (job.tipo === 'faturamento' ? linhasValidas[0].valores.data_referencia : linhasValidas[0].valores.data_periodo)
    : null;
  const statusFinal = invalidasCount > 0 ? 'completed_with_errors' : 'completed';

  await deps.hubPostgrestRequest(`ImportacaoArquivo?id=eq.${job.importacaoId}`, 'PATCH', {
    status: statusFinal,
    total_linhas: total,
    linhas_validas: validasCount,
    linhas_invalidas: invalidasCount,
    data_referencia: dataReferencia,
    concluido_em: deps.isoAgora(),
  }, job.claims);

  await deps.registrarAuditoria({
    idEmpresa: job.idEmpresa,
    acao: 'importacao.processada',
    recurso: 'ImportacaoArquivo',
    recursoId: job.importacaoId,
    detalhes: { status: statusFinal, total, validas: validasCount, invalidas: invalidasCount },
    claims: job.claims,
  });

  // Log estruturado (plano técnico §12.6) — SEM dado pessoal (só contadores
  // e timing; nunca nome/UUID/linha de CSV).
  const duracaoMs = deps.agoraMs() - inicioMs;
  console.log(JSON.stringify({
    evento: 'hub_import_processado',
    importacaoId: job.importacaoId,
    idEmpresa: job.idEmpresa,
    tipo: job.tipo,
    status: statusFinal,
    totalLinhas: total,
    linhasValidas: validasCount,
    linhasInvalidas: invalidasCount,
    duracaoMs,
    linhasPorSegundo: duracaoMs > 0 ? Math.round((total / duracaoMs) * 1000) : total,
  }));

  return { status: statusFinal, total, validas: validasCount, invalidas: invalidasCount };
}

// ────────────────────────────────────────────────────────────────────────────
// Entrada pública (ImportJob)
// ────────────────────────────────────────────────────────────────────────────

/**
 * @param {ImportJob} job
 * @param {typeof DEFAULT_DEPS} [deps]
 * @returns {Promise<{adquirido: boolean, status: string}>}
 */
async function processarImportacao(job, deps = DEFAULT_DEPS) {
  const adquirido = await tentarAdquirirLock(job, deps);
  if (!adquirido) {
    // 4.2.2 — outra importação do mesmo (id_empresa,tipo) está ativa; esta
    // permanece `pending` (sem 409) e será retomada quando a ativa
    // terminar (a chamada `tentarIniciarProximaPendente` DELA vai achá-la).
    return { adquirido: false, status: 'pending' };
  }
  try {
    const resultado = await executarPipeline(job, deps);
    return { adquirido: true, ...resultado };
  } finally {
    await tentarIniciarProximaPendente(job, deps);
  }
}

module.exports = {
  // entrada pública (ImportJob)
  processarImportacao,
  // máquina de estados (4.1 — testável isoladamente, 4.7.1)
  ESTADOS,
  ESTADOS_TERMINAIS,
  TRANSICOES_VALIDAS,
  transicaoValida,
  // lock (4.2 — testável isoladamente com mocks, 4.7.2)
  tentarAdquirirLock,
  tentarIniciarProximaPendente,
  foiCancelado,
  // regra >50% (4.4 — função pura, 4.7.3)
  computarStatusLimiar,
  // LGPD (4.5)
  mascararValor,
  // pipeline completo (para testes de integração com deps reais/mocks)
  executarPipeline,
  // constantes
  TAMANHO_LOTE,
  LIMIAR_INVALIDAS,
  TIMEOUT_IMPORTACAO_MS,
  DEFAULT_DEPS,
};
