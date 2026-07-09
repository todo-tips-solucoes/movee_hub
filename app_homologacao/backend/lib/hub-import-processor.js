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
 *
 * F6 (pós-review PR #57) — IMPORTANTE: "rollback por construção" descrito
 * acima vale SÓ para o caminho pré-insert (decisão >50% inválidas, ANTES do
 * 1º INSERT de fato). Ele NÃO se aplica a um cancelamento NO MEIO dos
 * lotes (`processarLotesValidas`/4.6): nesse caso os lotes JÁ inseridos
 * ficam persistidos — não há DELETE disponível para desfazê-los, nem faz
 * sentido tentar (fatos são append-only e idempotentes por
 * `hash_linha`/`ON CONFLICT DO NOTHING`). Semântica assumida: uma
 * importação cancelada NO MEIO do processamento fica `cancelled` com
 * contadores parciais e é RETOMÁVEL via `POST .../reprocessar` — o reparse
 * do MESMO arquivo produz os MESMOS `hash_linha`, então as linhas já
 * inseridas são puladas (idempotência) e só as restantes são gravadas.
 * Nunca tentar apagar linhas parciais de um cancelamento mid-batch.
 */

'use strict';

const { hubPostgrestRequest: hubPostgrestRequestReal } = require('./hub-postgrest');
const { registrarAuditoria: registrarAuditoriaReal } = require('./hub-auditoria');
const { extensaoDe, caminhoArmazenamento } = require('./hub-import-storage');
const {
  resolverConteudoCsvAsync,
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
// F3 (pós-review PR #57, OOM) — 100MB de ZIP descomprimido comportam ~1M
// linhas no formato observado; 300k é uma margem generosa acima do volume
// real (arquivos reais: 4-8k linhas, §7.1 do plano técnico) sem deixar o
// parse-completo-em-memória (necessário para o rollback "por construção",
// ver F6/cabeçalho) crescer sem limite em caso de arquivo hostil/corrompido
// que passe pelas defesas de tamanho de bytes mas tenha linhas minúsculas.
const MAX_LINHAS_IMPORTACAO = 300000;

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

// F12 (pós-review PR #57) — códigos POSIX de rede que o `fetch`/undici do
// Node expõe em `err.cause.code` (ou, em versões mais antigas, `err.code`)
// quando a falha é DE FATO de infraestrutura (conexão recusada/resetada,
// DNS, timeout de socket) — nunca um bug de código.
const CODIGOS_REDE_TRANSIENTES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT',
  'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * F12 — a versão anterior (`!err.status -> true`) classificava QUALQUER
 * erro sem status HTTP como transiente, incluindo bugs de programação
 * (`TypeError: Cannot read properties of undefined`, etc. — que também não
 * têm `.status`) — um erro assim era retentado 1x e, na 2ª falha idêntica
 * (determinística, não é rede), ainda assim seguia o caminho de "falha de
 * infraestrutura" em vez de propagar como erro real. Regra corrigida: só é
 * transiente (a) HTTP 5xx ou 429 (rate limit — vale retry), OU (b) uma
 * falha de rede IDENTIFICÁVEL pelo código POSIX da causa
 * (`err.cause.code`/`err.code`). Qualquer outro erro sem status (TypeError
 * de bug, erro de asserção, etc.) NÃO é transiente — propaga imediatamente
 * para `marcarFailed` (via o catch de `executarPipeline`), sem re-tentar
 * silenciosamente um bug determinístico.
 */
function errorTransiente(err) {
  if (!err) return false;
  if (typeof err.status === 'number') return err.status >= 500 || err.status === 429;
  const codigo = (err.cause && err.cause.code) || err.code;
  return Boolean(codigo && CODIGOS_REDE_TRANSIENTES.has(codigo));
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

  // claim `origemImportacao: true` (aditiva a job.claims, nunca sobrescreve
  // usuarioId/empresaAtiva/escopo) -- habilita hub_jwt_origem_importacao()
  // no trigger trg_entregador_protege_nome (migration 0025, tasks.md 8.2.4/
  // block-004/dec-048), que só protege nome_editado_manualmente=true contra
  // ESTE caminho (reimportação S4); o PATCH manual (routes/hub-motoristas.js)
  // nunca emite esta claim e por isso sempre pode reeditar o nome.
  const resultado = await executarComRetry(() => deps.hubPostgrestRequest(
    'Entregador?on_conflict=id_empresa,id_externo',
    'POST',
    payload,
    { ...job.claims, origemImportacao: true },
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

/** F13 (pós-review PR #57) — `on_conflict=importacao_id,numero_linha` +
 * `resolution=ignore-duplicates` (ON CONFLICT DO NOTHING, migration 0018):
 * se a 1ª tentativa deste lote já tiver gravado no servidor mas a resposta
 * se perdesse (erro transiente -> `executarComRetry` reenvia o MESMO
 * lote), o retry não duplica as linhas de erro já persistidas. */
async function inserirLoteErros(job, lote, deps) {
  await executarComRetry(() => deps.hubPostgrestRequest(
    'ImportacaoLinhaErro?on_conflict=importacao_id,numero_linha',
    'POST',
    lote,
    job.claims,
    { resolution: 'ignore-duplicates', returnMinimal: true }
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
  // Auditoria é best-effort (mesmo padrão de hub-auditoria.js): se falhar
  // AQUI, o PATCH acima (o que de fato destrava o mutex) já teve sucesso —
  // não deixa a transição de status inteira propagar como erro por causa
  // de um problema só no registro de auditoria (F1 — nenhum erro pode
  // impedir a marcação de `failed`).
  try {
    await deps.registrarAuditoria({
      idEmpresa: job.idEmpresa,
      acao: 'importacao.falhou',
      recurso: 'ImportacaoArquivo',
      recursoId: job.importacaoId,
      detalhes: { motivo, ...extra },
      claims: job.claims,
    });
  } catch (errAuditoria) {
    console.error('[hub-import-processor] falha ao registrar auditoria de failed (best-effort):', errAuditoria && errAuditoria.message);
  }
}

/** F1.1 (pós-review PR #57) — wrapper NUNCA lança: usado no catch de topo
 * de `processarImportacao` para garantir que uma falha ao TENTAR marcar
 * failed (ex.: PostgREST também fora do ar no momento) não impede o
 * `finally` de rodar `tentarIniciarProximaPendente` nem propaga como
 * unhandled rejection do fire-and-forget da rota. */
async function marcarFailedSeguro(job, motivo, deps, extra = {}) {
  try {
    await marcarFailed(job, motivo, deps, extra);
  } catch (err) {
    console.error(
      '[hub-import-processor] falha ao marcar failed (best-effort) — registro pode ficar preso em validating/processing até o próximo boot (recuperarImportacoesOrfas):',
      err && err.message
    );
  }
}

async function marcarCancelled(job, deps, extra = {}) {
  await deps.hubPostgrestRequest(`ImportacaoArquivo?id=eq.${job.importacaoId}`, 'PATCH', {
    status: 'cancelled',
    concluido_em: deps.isoAgora(),
    total_linhas: extra.total ?? null,
    linhas_validas: extra.validas ?? null,
    linhas_invalidas: extra.invalidas ?? null,
  }, job.claims);
  try {
    await deps.registrarAuditoria({
      idEmpresa: job.idEmpresa,
      acao: 'importacao.cancelada_durante_processamento',
      recurso: 'ImportacaoArquivo',
      recursoId: job.importacaoId,
      detalhes: extra,
      claims: job.claims,
    });
  } catch (errAuditoria) {
    console.error('[hub-import-processor] falha ao registrar auditoria de cancelamento (best-effort):', errAuditoria && errAuditoria.message);
  }
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

  // F1.2 (pós-review PR #57) — watchdog: NENHUMA chamada hubPostgrestRequest
  // deste pipeline fica pendente além de TIMEOUT_IMPORTACAO_MS (a lacuna que
  // motivou F1.3 — mutex órfão — inclui uma request de rede que nunca
  // resolve nem rejeita). `trabalho` é uma view de `deps` com o
  // AbortSignal injetado em toda chamada; as transições TERMINAIS
  // (marcarFailed/marcarCancelled, chamadas no catch/pontos de saída deste
  // pipeline) usam sempre `deps` ORIGINAL — precisam conseguir gravar o
  // status mesmo depois do abort disparar, senão o próprio watchdog
  // impediria a recuperação que ele deveria viabilizar.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`timeout de processamento (${TIMEOUT_IMPORTACAO_MS}ms) excedido`));
  }, TIMEOUT_IMPORTACAO_MS);
  const trabalho = {
    ...deps,
    hubPostgrestRequest: (endpoint, method, body, claims, opts = {}) => (
      deps.hubPostgrestRequest(endpoint, method, body, claims, { ...opts, signal: controller.signal })
    ),
  };

  try {
    const infoLinhas = await trabalho.hubPostgrestRequest(
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
      // F2 (pós-review PR #57) — versão ASSÍNCRONA: a descompressão de até
      // 100MB (quando o original é .zip) não trava o event loop aqui (já
      // estamos fora do ciclo request/response — fire-and-forget — mas o
      // processo Node é compartilhado, um bloqueio síncrono ainda atrasaria
      // TODAS as outras requisições em andamento).
      conteudoCsv = await resolverConteudoCsvAsync(bufferArquivo, { nomeArquivo });
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

    // status=processing (transição validating->processing) — F5 (pós-review
    // PR #57): GUARDADA por `status=eq.validating`. Se um
    // `POST .../cancelar` concorrente já moveu o registro para `cancelled`
    // ANTES desta transição, 0 linhas afetadas -> NÃO sobrescreve (detecta
    // e para aqui, preservando a transição já feita pelo cancelamento).
    const patchProcessing = await trabalho.hubPostgrestRequest(
      `ImportacaoArquivo?id=eq.${job.importacaoId}&status=eq.validating`,
      'PATCH', { status: 'processing' }, job.claims
    );
    if (!patchProcessing || patchProcessing.length === 0) {
      await marcarCancelled(job, deps, {});
      return { status: 'cancelled' };
    }

    const idx = indiceHeader(primeira.value.campos);
    const normalizarLinha = NORMALIZAR[job.tipo];
    const camposHash = CAMPOS_HASH[job.tipo];

    const linhasValidas = [];
    const errosLinha = [];
    let total = 0;
    let invalidasCount = 0;
    let excedeuLimiteLinhas = false;

    // Parse COMPLETO em memória antes de qualquer INSERT (ver cabeçalho do
    // arquivo — evita depender de DELETE, que a tabela de fatos não concede).
    // F3 (pós-review PR #57, OOM) — corta em MAX_LINHAS_IMPORTACAO: um
    // arquivo hostil/corrompido com linhas minúsculas poderia ficar dentro
    // do limite de BYTES (100MB) mas ter milhões de linhas — o corte evita
    // que o array `linhasValidas`/`errosLinha` cresça sem limite.
    // eslint-disable-next-line no-restricted-syntax
    for await (const linha of iterador) {
      total += 1;
      if (total > MAX_LINHAS_IMPORTACAO) {
        excedeuLimiteLinhas = true;
        break;
      }
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

    if (excedeuLimiteLinhas) {
      await marcarFailed(
        job,
        `arquivo excede o limite de ${MAX_LINHAS_IMPORTACAO} linhas — importação recusada`,
        deps,
        { total: MAX_LINHAS_IMPORTACAO, validas: null, invalidas: null }
      );
      return { status: 'failed' };
    }

    const validasCount = linhasValidas.length;

    if (total === 0) {
      await marcarFailed(job, 'arquivo sem linhas de dados (apenas cabeçalho)', deps, { total: 0, validas: 0, invalidas: 0 });
      return { status: 'failed' };
    }

    // 4.4 — regra >50% inválidas: decide ANTES de qualquer INSERT (rollback
    // "por construção" — nenhuma linha desta importação jamais foi gravada;
    // ver F6/cabeçalho do arquivo sobre o alcance dessa garantia).
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
    if (await foiCancelado(job, trabalho)) {
      await marcarCancelled(job, deps, { total, validas: validasCount, invalidas: invalidasCount });
      return { status: 'cancelled' };
    }

    let resultadoLotes;
    try {
      resultadoLotes = await processarLotesValidas(job, linhasValidas, trabalho);
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
      await processarLotesErros(job, errosLinha, trabalho);
    } catch (errErros) {
      console.error('[hub-import-processor] falha ao gravar ImportacaoLinhaErro (não bloqueia a importação):', errErros.message);
    }

    const dataReferencia = linhasValidas.length > 0
      ? (job.tipo === 'faturamento' ? linhasValidas[0].valores.data_referencia : linhasValidas[0].valores.data_periodo)
      : null;
    const statusFinal = invalidasCount > 0 ? 'completed_with_errors' : 'completed';

    // F5 (pós-review PR #57) — transição terminal GUARDADA por
    // `status=eq.processing`: se um cancelamento concorrente entrou na
    // janela ESTREITA entre o último lote e esta PATCH, 0 linhas afetadas
    // -> NÃO sobrescreve `cancelled` com `completed*` (os fatos já
    // inseridos permanecem — não há rollback, ver F6 — mas o STATUS
    // reportado ao usuário reflete o cancelamento, não uma conclusão
    // enganosa).
    const patchFinal = await trabalho.hubPostgrestRequest(
      `ImportacaoArquivo?id=eq.${job.importacaoId}&status=eq.processing`,
      'PATCH',
      {
        status: statusFinal,
        total_linhas: total,
        linhas_validas: validasCount,
        linhas_invalidas: invalidasCount,
        data_referencia: dataReferencia,
        concluido_em: deps.isoAgora(),
      },
      job.claims
    );
    if (!patchFinal || patchFinal.length === 0) {
      await marcarCancelled(job, deps, { total, validas: validasCount, invalidas: invalidasCount });
      return { status: 'cancelled' };
    }

    try {
      await deps.registrarAuditoria({
        idEmpresa: job.idEmpresa,
        acao: 'importacao.processada',
        recurso: 'ImportacaoArquivo',
        recursoId: job.importacaoId,
        detalhes: { status: statusFinal, total, validas: validasCount, invalidas: invalidasCount },
        claims: job.claims,
      });
    } catch (errAuditoria) {
      console.error('[hub-import-processor] falha ao registrar auditoria de conclusão (best-effort):', errAuditoria && errAuditoria.message);
    }

    // Refresh da MV de resumo do tipo importado (migrations 0028/0031 —
    // follow-ups SC-004 de S6/S7): única fonte de escrita nos fatos é este
    // pipeline, então o refresh ao final de toda importação bem-sucedida
    // mantém o staleness da MV na janela do próprio processamento.
    // Best-effort: uma falha aqui NÃO reverte a importação (fatos já
    // gravados; GET /faturamento e GET /performance leem a tabela-base,
    // sempre fresca) — o próximo import/refresh manual reconcilia. `deps`
    // direto (sem o signal de timeout de `trabalho`): o refresh não deve
    // ser abortado pelo timeout da importação que ACABOU de concluir.
    const rpcRefreshMv = {
      faturamento: 'rpc/hub_faturamento_refresh_mv', // mv_faturamento_dia (0028)
      performance: 'rpc/hub_performance_refresh_mv', // mv_performance_dia (0031)
    }[job.tipo];
    if (rpcRefreshMv) {
      try {
        await deps.hubPostgrestRequest(rpcRefreshMv, 'POST', {}, job.claims);
      } catch (errRefresh) {
        console.error(`[hub-import-processor] falha ao atualizar a MV de resumo (${rpcRefreshMv}, best-effort, staleness até o próximo refresh):`, errRefresh && errRefresh.message);
      }
    }

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
  } finally {
    clearTimeout(timeoutId);
  }
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
    try {
      const resultado = await executarPipeline(job, deps);
      return { adquirido: true, ...resultado };
    } catch (errPipeline) {
      // F1.1 (pós-review PR #57) — o achado MAIS grave do review: antes,
      // só falhas de NEGÓCIO (header inválido, >50% inválidas, etc.)
      // marcavam `failed` — qualquer erro NÃO tratado aqui dentro (infra
      // OU bug de código: PostgREST fora do ar na 1ª chamada, exceção em
      // `registrarAuditoria` fora dos best-effort já tratados, um bug
      // futuro qualquer) propagava até este ponto e o `catch` do
      // fire-and-forget na rota só LOGAVA — o registro ficava preso em
      // `validating`/`processing` PARA SEMPRE, e o índice único parcial
      // (migration 0011) bloqueava TODO upload futuro do mesmo
      // (id_empresa,tipo). Este catch garante que QUALQUER erro não
      // tratado do pipeline sempre termina em `failed` (erro_resumo
      // genérico, sem detalhe interno/PII) — nunca deixa o mutex órfão.
      console.error(
        '[hub-import-processor] erro não tratado no pipeline — marcando failed (F1):',
        errPipeline && errPipeline.message
      );
      await marcarFailedSeguro(job, 'falha inesperada no processamento (infraestrutura ou erro interno)', deps);
      return { adquirido: true, status: 'failed' };
    }
  } finally {
    await tentarIniciarProximaPendente(job, deps);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// F1.3 (pós-review PR #57) — recuperação de lock órfão no BOOT.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Roda 1x na inicialização do backend (server.js, ADITIVA — chamada dentro
 * de try/catch, NUNCA gateia o boot): um restart no meio de uma importação
 * (deploy) deixa o registro preso em `validating`/`processing` — o índice
 * único parcial (migration 0011, "1 importação ativa por (id_empresa,tipo)")
 * bloqueia TODO upload futuro daquele (id_empresa,tipo) até alguém destravar
 * manualmente. Esta função move QUALQUER `ImportacaoArquivo` ainda em
 * `validating`/`processing` (de TODOS os tenants — é manutenção do próprio
 * hub, não uma operação de negócio escopada por usuário; ver
 * lib/hub-postgrest-jwt.js) para `failed`, com `erro_resumo` explícito.
 *
 * Auth: usa a claim interna `hubBootRecovery` (nunca emitida por nenhuma
 * rota que atende requisição de usuário), que habilita SÓ a policy
 * `importacaoarquivo_update_recuperacao_orfa` (migration 0018) — essa
 * policy permite APENAS a transição `validating`/`processing` -> `failed`,
 * nada além disso (não é um bypass geral de RLS). Best-effort: NUNCA lança
 * — uma falha aqui (ex.: POSTGREST_URL ausente neste deployment, ou
 * PostgREST momentaneamente fora) só significa que a recuperação não
 * rodou desta vez, não pode derrubar o processo.
 * @param {typeof DEFAULT_DEPS} [deps]
 * @returns {Promise<{totalRecuperadas: number, erro?: string}>}
 */
async function recuperarImportacoesOrfas(deps = DEFAULT_DEPS) {
  try {
    const claimsRecuperacao = { hubBootRecovery: true };
    const recuperadas = await deps.hubPostgrestRequest(
      'ImportacaoArquivo?status=in.(validating,processing)',
      'PATCH',
      {
        status: 'failed',
        erro_resumo: 'recuperada apos reinicio',
        concluido_em: deps.isoAgora(),
      },
      claimsRecuperacao
    );
    const total = Array.isArray(recuperadas) ? recuperadas.length : 0;
    if (total > 0) {
      console.log(JSON.stringify({ evento: 'hub_import_recuperacao_orfa_boot', totalRecuperadas: total }));
      // hub-auditoria-admin 2.2.2 — gap fechado: recuperação órfã no boot
      // afeta linhas de TENANTS distintos (todos os `id_empresa` com
      // ImportacaoArquivo preso em validating/processing); 1 evento POR
      // tenant afetado (não 1 evento global), preservando o escopo correto
      // de quem consulta a trilha (FR-002) — best-effort por item, uma
      // falha isolada não impede os demais nem o boot (mesmo espírito do
      // `try` externo desta função).
      for (const linha of recuperadas) {
        const idEmpresaLinha = linha && linha.id_empresa != null ? linha.id_empresa : null;
        try {
          // eslint-disable-next-line no-await-in-loop
          await deps.registrarAuditoria({
            idEmpresa: idEmpresaLinha,
            acao: 'importacao_recuperada_boot',
            recurso: 'ImportacaoArquivo',
            recursoId: linha && linha.id,
            detalhes: { motivo: 'recuperada apos reinicio' },
            claims: idEmpresaLinha != null
              ? { empresaAtiva: idEmpresaLinha, escopo: [idEmpresaLinha] }
              : {},
          });
        } catch (errAuditoria) {
          console.error('[hub-import-processor] falha ao registrar auditoria de recuperacao orfa (best-effort):', errAuditoria && errAuditoria.message);
        }
      }
    }
    return { totalRecuperadas: total };
  } catch (err) {
    console.error('[hub-import-processor] recuperarImportacoesOrfas falhou (best-effort, não bloqueia o boot):', err && err.message);
    return { totalRecuperadas: 0, erro: err && err.message };
  }
}

module.exports = {
  // entrada pública (ImportJob)
  processarImportacao,
  // F1.3 — recuperação de lock órfão no boot (server.js)
  recuperarImportacoesOrfas,
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
  // F12 — classificação de erro transiente (testável isoladamente)
  errorTransiente,
  // pipeline completo (para testes de integração com deps reais/mocks)
  executarPipeline,
  // constantes
  TAMANHO_LOTE,
  LIMIAR_INVALIDAS,
  TIMEOUT_IMPORTACAO_MS,
  MAX_LINHAS_IMPORTACAO,
  DEFAULT_DEPS,
};
