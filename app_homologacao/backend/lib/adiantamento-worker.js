/**
 * adiantamento-worker.js — tick de 60s do adiantamento pelo app motorista
 * (tasks.md FASE 3, 3.3). Roda DENTRO do processo do backend, sem serviço
 * novo (plan.md Constitution Check V) — mesmo espírito de
 * `lib/hub-push-worker.js`.
 *
 * A cada tick (e uma vez no boot):
 *   1. `hub_adiantamento_processar(200)` — avalia `AGUARDANDO_CORTE` (corte
 *      já passado) e `AGUARDANDO_PRODUCAO` com `FOR UPDATE SKIP LOCKED`;
 *      audita no Node cada linha do retorno `(id, id_empresa, status_para,
 *      resultado)` (3.3.4, FR-047 — só as duas ações que a policy de
 *      auditoria libera para este claim: `adiantamento.calculado` e
 *      `adiantamento.aguardando_producao`, migration 0069).
 *   2. `hub_adiantamento_lote_orfaos(5)` — cancela lotes `GERANDO` há mais
 *      de 5 min (3.3.2).
 *   3. `hub_adiantamento_expurgo_arquivos(90)` — zera o arquivo de lotes
 *      concluídos/cancelados há mais de 90 dias (3.3.3, FR-052).
 *
 * CHK023 (checklists/api.md) — a distinção exigida é feita assim:
 *   - "produção D-1 ainda não disponível" NUNCA é um erro: a própria RPC
 *     `hub_adiantamento_processar` já decide isso por linha (devolve
 *     `status_para='AGUARDANDO_PRODUCAO'`, sem lançar exceção) — o tick só
 *     audita o resultado e deixa o PRÓXIMO tick (60s) tentar de novo,
 *     indefinidamente (FR-011, edge #7/#23). Nenhum retry aqui.
 *   - erro transitório de INFRA (timeout/5xx/rede na chamada http a
 *     PostgREST) É um erro: `chamarProcessarComRetry` classifica com o
 *     mesmo critério já usado por `lib/hub-import-processor.js#errorTransiente`
 *     (reuso — nunca duplicar a régua 5xx/429/código de rede) e retenta com
 *     backoff limitado (mesmos valores de `lib/hub-push-worker.js`), alertando
 *     (`logErro`) se esgotar as tentativas.
 *
 * Único módulo que emite a claim `hub_adiantamento_worker` (tasks 3.4.1) —
 * nunca a partir de dado de requisição.
 */

'use strict';

const { hubPostgrestRequest: hubPostgrestRequestReal } = require('./hub-postgrest');
const { registrarAuditoria: registrarAuditoriaReal } = require('./hub-auditoria');
const { errorTransiente } = require('./hub-import-processor');

const TICK_INTERVALO_MS = 60 * 1000; // plan.md §Regras "Tick de 60s"
const LIMITE_PROCESSAR = 200; // PLANO §17 / FR-049 / CHK024
const MINUTOS_ORFAOS = 5; // 3.3.2
const DIAS_EXPURGO = 90; // FR-052
// ponytail: mesmos valores de lib/hub-push-worker.js (MAX_TENTATIVAS/
// RETRY_BACKOFF_MS) — sem SLA específico definido para o tick, reusa o
// default já aceito no mesmo backend; ajustar se a operação real pedir.
const MAX_TENTATIVAS_PROCESSAR = 3;
const RETRY_BACKOFF_MS = [500, 2000];

const claimsWorker = { adiantamentoWorker: true };

const DEFAULT_DEPS = {
  hubPostgrestRequest: hubPostgrestRequestReal,
  registrarAuditoria: registrarAuditoriaReal,
  esperar: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  agendarIntervalo: (fn, ms) => setInterval(fn, ms),
  logErro: (msg, err) => console.error(`[adiantamento-worker] ${msg}`, err && err.message),
  logInfo: (msg) => console.log(`[adiantamento-worker] ${msg}`),
};

/**
 * Chama `hub_adiantamento_processar` com retry de erro TRANSITÓRIO DE INFRA
 * (timeout/5xx/rede na própria chamada HTTP) — nunca de "produção
 * indisponível" (isso é um resultado normal já decidido dentro da RPC, ver
 * cabeçalho do arquivo). `errorTransiente` reusa a mesma classificação de
 * `lib/hub-import-processor.js` (5xx/429 ou código de rede POSIX).
 */
async function chamarProcessarComRetry(deps) {
  let tentativas = 0;
  for (;;) {
    tentativas += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      return await deps.hubPostgrestRequest(
        'rpc/hub_adiantamento_processar', 'POST', { p_limite: LIMITE_PROCESSAR }, claimsWorker,
      );
    } catch (err) {
      if (!errorTransiente(err)) throw err;
      if (tentativas >= MAX_TENTATIVAS_PROCESSAR) {
        deps.logErro(`hub_adiantamento_processar: falha transitória de infra esgotada após ${tentativas} tentativa(s) — próximo tick (60s) tenta de novo`, err);
        throw err;
      }
      // eslint-disable-next-line no-await-in-loop
      await deps.esperar(RETRY_BACKOFF_MS[tentativas - 1] || RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);
    }
  }
}

/**
 * Audita UMA linha do retorno de `hub_adiantamento_processar` (3.3.4).
 * `resultado.erro` presente (bloco EXCEPTION da RPC, ex.: NO_BANK_ACCOUNT
 * raríssimo) significa que o status NÃO mudou — não é uma ação a auditar
 * (FR-047 exige auditoria só de ação que muda estado); só loga o anômalo.
 * Sem dado pessoal: `resultado` só carrega motivo/tentativas/valorLiquido
 * (nunca documento/conta — FR-047).
 * @param {{id:number,id_empresa:number,status_para:string,resultado:object}} linha
 */
async function auditarResultado(linha, deps) {
  const resultado = linha.resultado || {};
  if (resultado.erro) {
    deps.logErro(`hub_adiantamento_processar: solicitação ${linha.id} manteve status ${linha.status_para} por erro inesperado (${resultado.erro})`, null);
    return;
  }
  const acao = linha.status_para === 'AGUARDANDO_PRODUCAO' ? 'adiantamento.aguardando_producao' : 'adiantamento.calculado';
  try {
    await deps.registrarAuditoria({
      idEmpresa: linha.id_empresa,
      acao,
      recurso: 'AdiantamentoSolicitacao',
      recursoId: linha.id,
      detalhes: resultado,
      claims: claimsWorker,
    });
  } catch (err) {
    deps.logErro(`registrarAuditoria (solicitação ${linha.id}) falhou (best-effort)`, err);
  }
}

/** 3.3.1/3.3.4/3.3.5 — processa o lote pendente do tick e audita cada linha. */
async function processarPendentes(deps) {
  let linhas;
  try {
    linhas = await chamarProcessarComRetry(deps);
  } catch (err) {
    deps.logErro('hub_adiantamento_processar falhou (infra) — próximo tick tenta de novo', err);
    return;
  }
  if (!Array.isArray(linhas) || linhas.length === 0) return;
  for (const linha of linhas) {
    // eslint-disable-next-line no-await-in-loop
    await auditarResultado(linha, deps);
  }
}

/** 3.3.2 — cancela lotes `GERANDO` há mais de `MINUTOS_ORFAOS`. Best-effort: falha aqui não deve impedir o resto do tick nem o próximo. */
async function cancelarLotesOrfaos(deps) {
  try {
    const lotes = await deps.hubPostgrestRequest(
      'rpc/hub_adiantamento_lote_orfaos', 'POST', { p_minutos: MINUTOS_ORFAOS }, claimsWorker,
    );
    if (Array.isArray(lotes) && lotes.length > 0) {
      deps.logInfo(`lote_orfaos: ${lotes.length} lote(s) GERANDO há mais de ${MINUTOS_ORFAOS}min cancelado(s)`);
    }
  } catch (err) {
    deps.logErro('hub_adiantamento_lote_orfaos falhou (best-effort — próximo tick tenta de novo)', err);
  }
}

/** 3.3.3/FR-052 — expurga arquivo de lotes concluídos/cancelados há mais de `DIAS_EXPURGO`. Best-effort, mesmo padrão de `cancelarLotesOrfaos`. */
async function expurgarArquivos(deps) {
  try {
    const lotes = await deps.hubPostgrestRequest(
      'rpc/hub_adiantamento_expurgo_arquivos', 'POST', { p_dias: DIAS_EXPURGO }, claimsWorker,
    );
    if (Array.isArray(lotes) && lotes.length > 0) {
      deps.logInfo(`expurgo_arquivos: ${lotes.length} lote(s) com arquivo expurgado (${DIAS_EXPURGO} dias)`);
    }
  } catch (err) {
    deps.logErro('hub_adiantamento_expurgo_arquivos falhou (best-effort — próximo tick tenta de novo)', err);
  }
}

/** Um tick completo: processar -> órfãos -> expurgo (ordem do plan.md §Regras). */
async function executarTick(deps = DEFAULT_DEPS) {
  await processarPendentes(deps);
  await cancelarLotesOrfaos(deps);
  await expurgarArquivos(deps);
}

/**
 * Inicia o tick: roda uma vez agora (boot) e a cada 60s dali em diante
 * (3.3.1). Mesmo padrão de `lib/hub-push-worker.js#iniciarExpurgoPeriodico`
 * — quem decide SE isso roda em produção é o mount point em `server.js`
 * (guardado por `POSTGREST_URL`), nunca este módulo.
 * @param {typeof DEFAULT_DEPS} [deps]
 * @returns {NodeJS.Timeout} handle do intervalo (testes param `clearInterval`)
 */
function iniciarTick(deps = DEFAULT_DEPS) {
  executarTick(deps).catch((err) => deps.logErro('executarTick (boot) falhou inesperadamente', err));
  return deps.agendarIntervalo(() => {
    executarTick(deps).catch((err) => deps.logErro('executarTick falhou inesperadamente', err));
  }, TICK_INTERVALO_MS);
}

module.exports = {
  iniciarTick,
  executarTick,
  processarPendentes,
  cancelarLotesOrfaos,
  expurgarArquivos,
  chamarProcessarComRetry,
  auditarResultado,
  DEFAULT_DEPS,
  TICK_INTERVALO_MS,
  LIMITE_PROCESSAR,
  MINUTOS_ORFAOS,
  DIAS_EXPURGO,
  MAX_TENTATIVAS_PROCESSAR,
  RETRY_BACKOFF_MS,
};
