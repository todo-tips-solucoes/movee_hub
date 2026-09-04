// enriquecimento.js (hub-motorista-360 FASE 5, tasks.md 5.3.4) — worker que
// consome a fila de enriquecimento EntreGô (routes/hub-robo-entrego.js#GET
// /motoristas-para-enriquecer, FASE 2) e reporta o resultado (#PATCH
// .../entrego-enriquecimento). Espelha a estrutura de src/index.js
// (dependências injetadas: `page`/`clienteHub`/`dormir` — testável sem
// Playwright real), mas é um MÓDULO NOVO e SEPARADO — research.md Decision
// 7: "um novo par timer+script em infra/robo-entrego/", não uma alteração
// da rodada diária de importação (index.js#executarRodada), que já roda em
// produção real desde 2026-08-28 e não deve ganhar um caminho de falha novo
// no meio do fluxo crítico.
//
// Serialização com a rodada de importação (dec-039 — "uma raspagem por vez,
// robô prioritário", FR-005): a cargo do wrapper de processo
// (scripts/docker-run-enriquecimento.sh, tasks.md FASE 6.1) — mesmo `flock
// -n` de scripts/docker-run.sh sobre o MESMO lockfile
// (${SECRETS_DIR}/robo-entrego.lock). "Robô prioritário" emerge do próprio
// `-n` (non-blocking): quem já está com o lock corre; o outro nunca espera,
// só desiste desta execução e tenta de novo no próximo tick do seu timer —
// como a rodada diária roda só 3x/dia e a de enriquecimento sob-demanda a
// cada poucos minutos, a diária nunca fica esperando na fila. Este módulo só
// implementa a lógica da rodada; `--pulado-lock` (mesmo padrão de
// index.js#executarPuladoLock) é o que o wrapper invoca quando o lock está
// ocupado.
'use strict';

const { criarClienteHub } = require('./hub-client');
const {
  carregarStorageState,
  garantirSessaoValida,
  ErroAntibotSuspeito,
  ErroPortalTransitorio,
} = require('./entrego-portal');
const { buscarDadosPessoaPorUuid } = require('./busca-pessoa-entrego');
// 6.1.3 — reaproveita o MESMO backoff/retry transitório (1/5/15min, até 3
// tentativas, FR-012/FR-016) já usado pelo robô de importação, em vez de
// duplicar a lógica: `comRetryTransitorio` é puro (fn, {dormir}) e agnóstico
// ao que executa.
const { BACKOFF_MS_SEQUENCIA, comRetryTransitorio, carregarEnv, lerConfiguracao, ENV_PATH_DEFAULT } = require('./index');

// FR-016: "throttle entre motoristas MUST ser de no mínimo 60 segundos ...
// reaproveita o primeiro degrau do backoff já existente do robô
// (BACKOFF_MS_SEQUENCIA[0] = 60_000 ms)" — reaproveitado por import, não
// duplicado como número mágico novo.
const THROTTLE_MS_ENTRE_MOTORISTAS = BACKOFF_MS_SEQUENCIA[0];

const MODOS_VALIDOS = Object.freeze(['sob-demanda', 'semestral']);

async function dormirReal(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Processa 1 motorista da fila: busca (busca-pessoa-entrego.js, com retry
 * transitório — 6.1.3) e reporta o resultado ao hub (PATCH, task 5.2.2).
 * @param {Function} [opts.buscarDadosPessoa] override para teste (default:
 *   a chamada real de API — busca-pessoa-entrego.js)
 * @returns {Promise<{ok:true}>} nunca lança — a classificação do erro
 *   (segue vs. para a rodada) é decidida pelo chamador
 *   (`executarRodadaEnriquecimento`), que precisa do erro original.
 */
async function processarUmMotorista({ item, page, clienteHub, modo, dormir, buscarDadosPessoa = buscarDadosPessoaPorUuid }) {
  const { valor: dados } = await comRetryTransitorio(
    () => buscarDadosPessoa(page, { uuid: item.idExterno }),
    { dormir }
  );
  await clienteHub.atualizarEnriquecimento(item.id, { sucesso: true, dados, modo });
  return { ok: true };
}

/**
 * Executa 1 rodada completa da fila de enriquecimento (task 5.3.4).
 * @param {object} opts
 * @param {'sob-demanda'|'semestral'} opts.modo
 * @param {object} opts.page - Playwright Page (ou mock) já com storageState carregado
 * @param {object} opts.clienteHub - já criado via `criarClienteHub`
 * @param {(timestamp: Date) => Promise<string>} opts.obterCodigo - para relogin, se a sessão expirou
 * @param {object} opts.config - ver `lerConfiguracao()` (index.js)
 * @param {Function} [opts.dormir] override para teste
 * @param {Function} [opts.buscarDadosPessoa] override para teste - ver busca-pessoa-entrego.js
 * @returns {Promise<{resultado:string, total:number, sucessos:number, falhas:number, parouPorAntibotOuGap:boolean, motivoParada:string|null}>}
 */
async function executarRodadaEnriquecimento({ modo, page, clienteHub, obterCodigo, config, dormir = dormirReal, buscarDadosPessoa } = {}) {
  if (!MODOS_VALIDOS.includes(modo)) {
    throw new Error(`enriquecimento: modo inválido "${modo}" (válidos: ${MODOS_VALIDOS.join(', ')})`);
  }

  // 1. hub: login (ErroConfiguracaoHub -> nunca retry, propaga — mesmo
  //    contrato de index.js#executarRodada).
  await clienteHub.login(config.hubServicoEmail, config.hubServicoSenha);

  // 2. sessão EntreGô (sonda + login completo se 401 — reusa Decision 3).
  await garantirSessaoValida(page, {
    email: config.entregoEmail,
    senha: config.entregoSenha,
    obterCodigo,
    storageStatePath: config.storageStatePath,
  });

  // 3. fila (task 5.3.4 — GET .../motoristas-para-enriquecer).
  const itens = await clienteHub.buscarMotoristasParaEnriquecer(modo);
  if (itens.length === 0) {
    return { resultado: 'sem_dados', total: 0, sucessos: 0, falhas: 0, parouPorAntibotOuGap: false, motivoParada: null };
  }

  let sucessos = 0;
  let falhas = 0;
  let motivoParada = null;

  for (let i = 0; i < itens.length; i += 1) {
    const item = itens[i];
    // FR-016: throttle MÍNIMO de 60s entre motoristas processados NUMA
    // rodada — nunca antes do primeiro item.
    if (i > 0) await dormir(THROTTLE_MS_ENTRE_MOTORISTAS);

    try {
      await processarUmMotorista({ item, page, clienteHub, modo, dormir, buscarDadosPessoa });
      sucessos += 1;
    } catch (e) {
      // FR-016/FR-011 — "parando em vez de insistir": suspeita de anti-bot OU
      // falha transitória/de sessão que sobrou dos 3 retries de
      // comRetryTransitorio (rede/5xx/401 — nenhuma culpa DESTE motorista)
      // interrompem a RODADA inteira. O item CORRENTE fica sem PATCH — o
      // pedido (dados_entrego_solicitado_em) permanece pendente na fila,
      // reprocessado na PRÓXIMA execução do timer (auto-cura: uma nova
      // sessão é sondada/relogada do zero no passo 2 — ver header do módulo,
      // "sob-demanda" roda a cada poucos minutos, não precisa de relogin
      // NO MEIO da rodada corrente, ao contrário do robô diário de FASE 4).
      if (e instanceof ErroAntibotSuspeito || e instanceof ErroPortalTransitorio) {
        motivoParada = e.message;
        // eslint-disable-next-line no-console
        console.error(`[enriquecimento] rodada interrompida (${e.name}): ${e.message}`);
        break;
      }
      // Falha específica DESTE motorista (ex.: dados incompletos, timeout
      // isolado) — reporta e segue para o próximo (mesma disciplina do
      // PATCH sucesso=false, FR-007: nunca descarta enriquecimento anterior).
      falhas += 1;
      try {
        await clienteHub.atualizarEnriquecimento(item.id, { sucesso: false, motivoFalha: e.message, modo });
      } catch (patchErr) {
        // Falha ao REPORTAR a falha — nunca silenciosa (mesma disciplina de
        // index.js#dispararReacoesFalha).
        // eslint-disable-next-line no-console
        console.error(`[enriquecimento] falha ao reportar item ${item.id} ao hub: ${patchErr.message}`);
      }
    }
  }

  const processados = sucessos + falhas;
  const resultado = motivoParada && processados === 0 ? 'falha_total'
    : falhas === 0 && !motivoParada ? 'sucesso'
      : sucessos === 0 ? 'falha_total'
        : 'falha_parcial';

  return { resultado, total: itens.length, sucessos, falhas, parouPorAntibotOuGap: motivoParada !== null, motivoParada };
}

if (require.main === module) {
  const modo = (process.argv.find((a) => a.startsWith('--modo=')) || '').slice('--modo='.length);
  const puladoLock = process.argv.includes('--pulado-lock');

  if (puladoLock) {
    // eslint-disable-next-line no-console
    console.error('[enriquecimento] pulado_lock — outra execução (importação ou enriquecimento) em andamento');
    process.exitCode = 0;
  } else {
    (async () => {
      carregarEnv();
      const config = lerConfiguracao();

      const { chromium } = require('playwright');
      const { ImapFlow } = require('imapflow');

      const storageState = carregarStorageState(config.storageStatePath);
      const browser = await chromium.launch();
      const context = await browser.newContext(storageState ? { storageState } : {});
      const page = await context.newPage();

      async function obterCodigo(timestampDisparo) {
        const client = new ImapFlow({
          host: 'imap.gmail.com',
          port: 993,
          secure: true,
          auth: { user: config.gmailEmail, pass: config.gmailAppPassword },
          logger: false,
        });
        await client.connect();
        try {
          const { lerCodigoAcesso } = require('./imap-codigo');
          return await lerCodigoAcesso(client, timestampDisparo);
        } finally {
          await client.logout();
        }
      }

      const clienteHub = criarClienteHub({ baseURL: config.hubBaseURL, idEmpresaEsperado: config.hubIdEmpresa });

      try {
        const resultado = await executarRodadaEnriquecimento({ modo, page, clienteHub, obterCodigo, config });
        // eslint-disable-next-line no-console
        console.log('[enriquecimento] rodada concluída:', JSON.stringify(resultado));
      } finally {
        await browser.close();
      }
    })().catch((e) => {
      // eslint-disable-next-line no-console
      console.error('[enriquecimento] falha fatal fora da rodada:', e && e.stack ? e.stack : e);
      process.exitCode = 1;
    });
  }
}

module.exports = {
  executarRodadaEnriquecimento,
  processarUmMotorista,
  THROTTLE_MS_ENTRE_MOTORISTAS,
  MODOS_VALIDOS,
  ENV_PATH_DEFAULT,
};
