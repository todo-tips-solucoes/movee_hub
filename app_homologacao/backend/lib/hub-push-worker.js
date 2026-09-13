/**
 * hub-push-worker.js — worker de envio de Web Push (FASE 5, tasks.md 5.1-5.4).
 *
 * Reivindica lotes de `"AvisoEntrega"` pendentes (`hub_push_reivindicar`,
 * `FOR UPDATE SKIP LOCKED` + lease — migration 0061), envia via `web-push`
 * com concorrência limitada e grava o resultado (`hub_push_registrar_resultado`).
 * Também resolve a retomada no boot (5.2) e o expurgo periódico de 90 dias
 * (5.3). Roda DENTRO do processo do backend — nenhum serviço novo
 * (research.md Decision 4, plan.md Constitution Check V).
 *
 * Único módulo que emite a claim interna `hub_push_worker` (mitigação S10,
 * tasks 5.2.2): nunca a partir de dado de requisição — sempre `true` fixo,
 * só aqui. `routes/hub-avisos.js` (disparo, fire-and-forget) e o boot do
 * `server.js` (retomada + expurgo) só chamam as funções exportadas abaixo,
 * nunca constroem o claim eles mesmos.
 *
 * Desenho (research.md Decision 4/5, tasks.md 5.1/5.2):
 * - lote 50, concorrência 10 envios simultâneos por aviso, 1 aviso por vez
 *   por processo (fila interna FIFO — `processarAviso` enfileira e um único
 *   loop ativo por processo drena a fila);
 * - lease 120 s: entrega em voo com processo caído vira `falha/interrompida`
 *   (nunca reenviada — at-most-once, dec-026);
 * - classificação da resposta do `web-push` (tasks 5.1.2): a mesma chamada
 *   `sendNotification` seria ambígua entre "erro local antes do HTTP" e
 *   "erro de rede depois de iniciar o HTTP" (nenhum dos dois carrega
 *   `statusCode`) — por isso valida com `generateRequestDetails` PRIMEIRO
 *   (lançamento aqui = local, sem retry) e só then chama `sendNotification`
 *   (erro daqui em diante = `WebPushError` com `statusCode` HTTP, ou erro de
 *   rede genuíno — ambos elegíveis a retry/transitório). Ver
 *   node_modules/web-push/src/web-push-lib.js:338-344,369-403 (lido nesta
 *   sessão) e README "Returns" (statusCode só em resposta HTTP real).
 * - payload `{ avisoId, titulo, corpo }`, TTL 259200 (72h), urgency
 *   'normal', timeout 10000 (contracts/motorista-push.md §Payload).
 * - logs (5.4): nunca o endpoint completo, p256dh/auth ou a chave privada —
 *   só os 8 primeiros hex do `endpoint_hash` (lib/hub-push-log.js).
 */

'use strict';

const crypto = require('crypto');
const webpush = require('web-push');

const { hubPostgrestRequest: hubPostgrestRequestReal } = require('./hub-postgrest');
const { registrarAuditoria: registrarAuditoriaReal } = require('./hub-auditoria');
const { carregarArquivoChave } = require('./hub-push-vapid');
const { carregarAllowlist, hostPermitido } = require('./hub-push-endpoint');
const { endpointHash, logErro, logInfo } = require('./hub-push-log');

// Limites (research.md Decision 4, "constantes no código, com comentário
// ponytail: do teto"): lote 50, concorrência 10, lease 120s, 3 tentativas.
const LOTE_LIMITE = 50;
const CONCORRENCIA = 10;
const LEASE_SEGUNDOS = 120;
const MAX_TENTATIVAS = 3;
// ponytail: espera crescente entre tentativas — só a ORDEM (crescente) é
// exigida pela tarefa 5.1.3; os valores em si são um default de engenharia
// (não há requisito de SLA específico), ajustável se a operação real pedir.
const RETRY_BACKOFF_MS = [500, 2000];
// ponytail: teto de segurança contra loop infinito num aviso com volume
// anormal (bug em vez de "muitos destinatários" — plan.md fala em "ordem de
// centenas a poucos milhares" de inscrições no total); 2000 lotes de 50 =
// 100.000 entregas processadas antes de desistir e logar.
const MAX_ITERACOES_POR_AVISO = 2000;
const EXPURGO_INTERVALO_MS = 24 * 60 * 60 * 1000;
// contracts/motorista-push.md §Payload do push.
const PUSH_OPTS_BASE = { TTL: 259200, urgency: 'normal', timeout: 10000 };

const DEFAULT_DEPS = {
  hubPostgrestRequest: hubPostgrestRequestReal,
  registrarAuditoria: registrarAuditoriaReal,
  carregarArquivoChave,
  carregarAllowlist,
  hostPermitido,
  enviarPush: (subscription, payload, opts) => webpush.sendNotification(subscription, payload, opts),
  gerarDetalhesRequisicao: (subscription, payload, opts) => webpush.generateRequestDetails(subscription, payload, opts),
  endpointHash,
  logErro,
  logInfo,
  gerarLeaseToken: () => crypto.randomUUID(),
  esperar: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  agendarIntervalo: (fn, ms) => setInterval(fn, ms),
};

// Estado do módulo (1 processo = 1 chave ativa + 1 fila de avisos — mesmo
// espírito de lib/hub-push-vapid.js: sem classe, sem singleton factory).
let chaveCache = null;
let filaAvisos = [];
let processandoFila = false;

/**
 * Classifica o erro de `sendNotification` (já passada a pré-validação local
 * de `gerarDetalhesRequisicao` — ver cabeçalho do arquivo).
 * @param {Error & {statusCode?: number}} err
 * @returns {{status:'morta'|'falha', motivo:string|null, retry:boolean}}
 */
function classificarErroEnvio(err) {
  const statusCode = err && typeof err.statusCode === 'number' ? err.statusCode : null;
  if (statusCode === 404 || statusCode === 410) {
    return { status: 'morta', motivo: null, retry: false };
  }
  if (statusCode !== null && statusCode >= 400 && statusCode < 500) {
    return { status: 'falha', motivo: 'rejeitada', retry: false };
  }
  // 5xx (resposta HTTP real) ou erro de rede genuíno (sem statusCode, mas
  // ocorrido DEPOIS da pré-validação local) — ambos transitórios.
  return { status: 'falha', motivo: null, retry: true };
}

/** Best-effort: falha ao registrar resultado só é logada — o lease vence e a próxima reivindicação reavalia (at-most-once, nunca reenvia). */
async function registrarResultado(deps, entregaId, leaseToken, status, motivo, tentativas) {
  try {
    await deps.hubPostgrestRequest(
      'rpc/hub_push_registrar_resultado',
      'POST',
      {
        p_entrega_id: entregaId,
        p_lease_token: leaseToken,
        p_status: status,
        p_motivo: motivo,
        p_tentativas: tentativas,
      },
      { hubPushWorker: true },
    );
  } catch (err) {
    deps.logErro(`registrarResultado (entrega ${entregaId}) falhou (best-effort — lease vence e a próxima reivindicação reavalia)`, err, null);
  }
}

/**
 * Processa UMA entrega já reivindicada (linha de `hub_push_reivindicar`):
 * valida allowlist (defesa em profundidade, lib/hub-push-endpoint.js),
 * envia via `web-push` com retry de falha transitória (5.1.3) e grava o
 * resultado.
 * @param {{entrega_id:number, endpoint:string, p256dh:string, auth:string}} linha
 * @param {{leaseToken:string, chave:object, payload:object}} ctx
 * @param {typeof DEFAULT_DEPS} deps
 */
async function processarEntrega(linha, ctx, deps) {
  const entregaId = linha.entrega_id;
  const hash = deps.endpointHash(linha.endpoint);

  let url = null;
  try {
    url = new URL(linha.endpoint);
  } catch (e) {
    url = null;
  }
  const allowlist = deps.carregarAllowlist();
  if (!url || !deps.hostPermitido(url.hostname, allowlist)) {
    await registrarResultado(deps, entregaId, ctx.leaseToken, 'falha', 'envio_bloqueado', 0);
    deps.logErro('envio bloqueado (host fora da allowlist de destino, mitigação SSRF S6)', new Error('ENDPOINT_NAO_PERMITIDO'), hash);
    return;
  }

  const subscription = { endpoint: linha.endpoint, keys: { p256dh: linha.p256dh, auth: linha.auth } };
  const payloadTexto = JSON.stringify(ctx.payload);
  const opts = Object.assign({}, PUSH_OPTS_BASE, {
    vapidDetails: {
      subject: ctx.chave.subject,
      publicKey: ctx.chave.chavePublica,
      privateKey: ctx.chave.chavePrivada,
    },
  });

  // Pré-validação local (tasks 5.1.2): erro AQUI nunca teve requisição HTTP
  // — rejeitada imediata, sem retry (subscription/payload/opções malformadas).
  try {
    deps.gerarDetalhesRequisicao(subscription, payloadTexto, opts);
  } catch (errLocal) {
    await registrarResultado(deps, entregaId, ctx.leaseToken, 'falha', 'rejeitada', 0);
    deps.logErro('erro local antes do envio (rejeitada, sem retry)', errLocal, hash);
    return;
  }

  let tentativas = 0;
  for (;;) {
    tentativas += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      await deps.enviarPush(subscription, payloadTexto, opts);
      // eslint-disable-next-line no-await-in-loop
      await registrarResultado(deps, entregaId, ctx.leaseToken, 'aceito', null, tentativas);
      return;
    } catch (err) {
      const classificacao = classificarErroEnvio(err);
      if (classificacao.status === 'morta') {
        // eslint-disable-next-line no-await-in-loop
        await registrarResultado(deps, entregaId, ctx.leaseToken, 'morta', null, tentativas);
        return;
      }
      if (!classificacao.retry) {
        // eslint-disable-next-line no-await-in-loop
        await registrarResultado(deps, entregaId, ctx.leaseToken, 'falha', classificacao.motivo, tentativas);
        deps.logErro('envio rejeitado (4xx sem retry)', err, hash);
        return;
      }
      if (tentativas >= MAX_TENTATIVAS) {
        // eslint-disable-next-line no-await-in-loop
        await registrarResultado(deps, entregaId, ctx.leaseToken, 'falha', 'transitoria_esgotada', tentativas);
        deps.logErro(`falha transitória esgotada após ${tentativas} tentativas`, err, hash);
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      await deps.esperar(RETRY_BACKOFF_MS[tentativas - 1] || RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);
    }
  }
}

/** Executa `tarefa` sobre `itens` com no máximo `limite` execuções concorrentes. */
async function executarComPool(itens, limite, tarefa) {
  const fila = itens.slice();
  const tamanhoPool = Math.max(1, Math.min(limite, fila.length));
  const workers = new Array(tamanhoPool).fill(null).map(async () => {
    for (;;) {
      const item = fila.shift();
      if (item === undefined) return;
      // eslint-disable-next-line no-await-in-loop
      await tarefa(item);
    }
  });
  await Promise.all(workers);
}

/** Chave VAPID ativa (com a privada) para o worker assinar envios — cacheada no boot por `registrarChaveVapid`, carregada sob demanda se ainda não houver cache (ex.: chamada isolada em teste). */
async function obterChave(deps = DEFAULT_DEPS) {
  if (chaveCache) return chaveCache;
  const resultado = deps.carregarArquivoChave(process.env.VAPID_KEYS_FILE);
  if (resultado.ok) {
    chaveCache = resultado.chave;
    return chaveCache;
  }
  return null;
}

async function obterAvisoResumo(avisoId, deps) {
  const linhas = await deps.hubPostgrestRequest(
    `Aviso?id=eq.${avisoId}&select=id,titulo,corpo`,
    'GET', null, { hubPushWorker: true },
  );
  return (Array.isArray(linhas) && linhas[0]) || null;
}

/** Reivindica e processa lotes de UM aviso até esgotar os pendentes. */
async function processarAvisoInterno(avisoId, deps) {
  const chave = await obterChave(deps);
  if (!chave) {
    deps.logErro(`processarAviso ${avisoId}: chave VAPID indisponível — abortando (retomada tentará de novo no próximo boot)`, new Error('PUSH_INDISPONIVEL'), null);
    return;
  }

  const aviso = await obterAvisoResumo(avisoId, deps).catch((err) => {
    deps.logErro(`processarAviso ${avisoId}: falha ao buscar titulo/corpo`, err, null);
    return null;
  });
  if (!aviso) return;

  const payload = { avisoId, titulo: aviso.titulo, corpo: aviso.corpo };

  for (let iteracao = 0; iteracao < MAX_ITERACOES_POR_AVISO; iteracao += 1) {
    const leaseToken = deps.gerarLeaseToken();
    let linhas;
    try {
      // eslint-disable-next-line no-await-in-loop
      linhas = await deps.hubPostgrestRequest(
        'rpc/hub_push_reivindicar', 'POST',
        {
          p_aviso_id: avisoId,
          p_limite: LOTE_LIMITE,
          p_lease_segundos: LEASE_SEGUNDOS,
          p_lease_token: leaseToken,
          p_key_id: chave.keyId,
        },
        { hubPushWorker: true },
      );
    } catch (err) {
      deps.logErro(`processarAviso ${avisoId}: falha ao reivindicar lote (interrompe — próxima retomada tenta de novo)`, err, null);
      return;
    }
    if (!Array.isArray(linhas) || linhas.length === 0) return;

    const ctx = { leaseToken, chave, payload };
    // eslint-disable-next-line no-await-in-loop
    await executarComPool(linhas, CONCORRENCIA, (linha) => processarEntrega(linha, ctx, deps));

    if (linhas.length < LOTE_LIMITE) return;
  }
  deps.logErro(`processarAviso ${avisoId}: limite de segurança de ${MAX_ITERACOES_POR_AVISO} lotes atingido`, new Error('LIMITE_ITERACOES'), null);
}

/**
 * Enfileira `avisoId` para processamento. No máximo 1 aviso por vez POR
 * PROCESSO (research.md Decision 4/plan.md Constraints): uma fila FIFO
 * interna garante que só um loop de reivindicação está ativo por vez; uma
 * chamada concorrente só enfileira e retorna (fire-and-forget, mesmo padrão
 * de `processarImportacao(...).catch(...)` em routes/hub-importacoes.js).
 * @param {number} avisoId
 * @param {typeof DEFAULT_DEPS} [deps]
 */
async function processarAviso(avisoId, deps = DEFAULT_DEPS) {
  filaAvisos.push(avisoId);
  if (processandoFila) return;
  processandoFila = true;
  try {
    while (filaAvisos.length > 0) {
      const id = filaAvisos.shift();
      // eslint-disable-next-line no-await-in-loop
      await processarAvisoInterno(id, deps);
    }
  } finally {
    processandoFila = false;
  }
}

/**
 * Retomada no boot (5.2.1, FR-018): avisos `na_fila`/`em_andamento`
 * sobrevivem a um restart (a fila é a própria tabela); esta função só
 * precisa enfileirar de novo — `hub_push_reivindicar` já trata o resto
 * (lease vencido -> `interrompida`, nunca reenviada).
 * @param {typeof DEFAULT_DEPS} [deps]
 * @returns {Promise<{totalRetomados:number, erro?:string}>}
 */
async function retomarAvisosPendentes(deps = DEFAULT_DEPS) {
  try {
    const linhas = await deps.hubPostgrestRequest(
      'Aviso?status=in.(na_fila,em_andamento)&select=id',
      'GET', null, { hubPushWorker: true },
    );
    const ids = Array.isArray(linhas) ? linhas.map((l) => l.id) : [];
    for (const id of ids) {
      processarAviso(id, deps).catch((err) => {
        deps.logErro(`retomarAvisosPendentes: falha ao processar aviso ${id} após reinício`, err, null);
      });
    }
    if (ids.length > 0) {
      deps.logInfo(`retomarAvisosPendentes: ${ids.length} aviso(s) retomado(s) após reinício`, null);
    }
    return { totalRetomados: ids.length };
  } catch (err) {
    deps.logErro('retomarAvisosPendentes falhou (best-effort, não bloqueia o boot)', err, null);
    return { totalRetomados: 0, erro: err && err.message };
  }
}

/**
 * Registra a chave VAPID carregada no boot em `"PushChaveVapid"` + auditoria
 * (research.md Decision 3: `push_chave_registrada` na 1ª vez,
 * `push_chave_substituida` quando difere da chave ativa anterior; idempotente
 * — mesma chave do boot anterior não duplica registro nem auditoria).
 * ÚNICO ponto do sistema que emite a claim `hub_push_worker` para esta
 * escrita (tasks 5.2.2) — injetado como `registrarFn` de
 * `lib/hub-push-vapid.js#inicializar`. Também cacheia a chave (com a
 * privada) para uso do worker de envio — nunca exposta fora deste módulo.
 * @param {{chavePublica:string,chavePrivada:string,keyId:string,geradoPor:string,geradoEm:string,subject:string}} chave
 * @param {typeof DEFAULT_DEPS} [deps]
 */
async function registrarChaveVapid(chave, deps = DEFAULT_DEPS) {
  chaveCache = chave;
  try {
    const anteriores = await deps.hubPostgrestRequest(
      'PushChaveVapid?select=key_id&order=ativada_em.desc&limit=1',
      'GET', null, { hubPushWorker: true },
    );
    const anteriorKeyId = (Array.isArray(anteriores) && anteriores[0] && anteriores[0].key_id) || null;
    if (anteriorKeyId === chave.keyId) return;

    await deps.hubPostgrestRequest('PushChaveVapid', 'POST', {
      key_id: chave.keyId,
      chave_publica: chave.chavePublica,
      gerado_por: chave.geradoPor,
    }, { hubPushWorker: true });

    await deps.registrarAuditoria({
      acao: anteriorKeyId ? 'push_chave_substituida' : 'push_chave_registrada',
      recurso: 'PushChaveVapid',
      recursoId: chave.keyId,
      detalhes: { geradoPor: chave.geradoPor, anteriorKeyId },
      // dec-123: evento GLOBAL (id_empresa NULL) sem esta claim cai na
      // policy auditoria_insert_por_escopo (0009) sem nenhum ramo que
      // aceite — INSERT negado por RLS, silenciado pelo catch best-effort
      // deste método. hub_push_worker=true é o mesmo claim que
      // hub_jwt_push_worker() já valida em Aviso/AvisoEntrega/PushChaveVapid
      // (migration 0061); a migration 0063 estende auditoria_insert_por_escopo
      // para aceitar este claim nestas 2 ações.
      claims: { hubPushWorker: true },
    });
  } catch (err) {
    deps.logErro('registrarChaveVapid falhou (best-effort, não bloqueia o boot)', err, null);
  }
}

/** Chama `hub_push_expurgo()` (5.3.1, FR-030) — não altera `hub_auditoria_expurgo` (0041) nem a política de 12 meses. */
async function executarExpurgo(deps = DEFAULT_DEPS) {
  try {
    const linhas = await deps.hubPostgrestRequest('rpc/hub_push_expurgo', 'POST', {}, { hubPushWorker: true });
    const resultado = (Array.isArray(linhas) && linhas[0]) || { avisos_removidos: 0, entregas_removidas: 0 };
    if (resultado.avisos_removidos > 0) {
      deps.logInfo(`expurgo: ${resultado.avisos_removidos} aviso(s) e ${resultado.entregas_removidas} entrega(s) removidos (90 dias)`, null);
    }
    return resultado;
  } catch (err) {
    deps.logErro('executarExpurgo falhou (best-effort, não bloqueia o boot/intervalo)', err, null);
    return { avisos_removidos: 0, entregas_removidas: 0, erro: err && err.message };
  }
}

/**
 * Agenda o expurgo automático: 1x no boot + a cada 24h (5.3.1).
 * @param {typeof DEFAULT_DEPS} [deps]
 * @returns {NodeJS.Timeout} handle do intervalo (para testes pararem com `clearInterval`)
 */
function iniciarExpurgoPeriodico(deps = DEFAULT_DEPS) {
  executarExpurgo(deps).catch(() => {});
  return deps.agendarIntervalo(() => { executarExpurgo(deps).catch(() => {}); }, EXPURGO_INTERVALO_MS);
}

/** Só para teste: reseta o estado do módulo entre casos (evita vazamento entre `describe`s). */
function _resetParaTeste() {
  chaveCache = null;
  filaAvisos = [];
  processandoFila = false;
}

module.exports = {
  processarAviso,
  processarEntrega,
  retomarAvisosPendentes,
  registrarChaveVapid,
  executarExpurgo,
  iniciarExpurgoPeriodico,
  obterChave,
  classificarErroEnvio,
  executarComPool,
  _resetParaTeste,
  LOTE_LIMITE,
  CONCORRENCIA,
  LEASE_SEGUNDOS,
  MAX_TENTATIVAS,
  RETRY_BACKOFF_MS,
  EXPURGO_INTERVALO_MS,
};
