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
  renovarSessao,
  lerExpiracaoRefresh,
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

// Keep-alive (ACHADOS-PORTAL.md §10, medido 2026-09-05): o refresh token vive
// 60 min e é ROTACIONADO a cada renovação — a sessão só morre se ficar mais de
// uma hora sem renovar. Sem isto, uma fila parada por > 60 min custa um login
// completo (código por e-mail) no próximo trabalho. Com fila vazia, se faltam
// <= KEEPALIVE_MARGEM_MS para o refresh vencer, renova. Sobre o PerimeterX:
// são ~36 toques leves/dia (goto na origem + 1 POST via page.evaluate, como
// toda chamada do robô), decisão do operador em 2026-09-05.
//
// Regra dura: keep-alive NUNCA faz login completo. Refresh já vencido ou
// ausente => não toca o portal; o próximo trabalho real reloga. Senão a fila
// vazia viraria um código por hora.
const KEEPALIVE_MARGEM_MS = 20 * 60_000;

/** @returns {Promise<null|'renovada'|string>} null = não precisava/não podia; 'renovada'; ou 'falhou:<status>' */
async function manterSessaoViva({ page, storageStatePath, agora = Date.now() }) {
  const exp = lerExpiracaoRefresh(storageStatePath);
  if (!exp) return null;
  const restante = exp.getTime() - agora;
  if (restante <= 0 || restante > KEEPALIVE_MARGEM_MS) return null;
  const { renovada, status } = await renovarSessao(page, { storageStatePath });
  const rotulo = renovada ? 'renovada' : `falhou:${status}`;
  // eslint-disable-next-line no-console
  console.log(`[enriquecimento] keep-alive: refresh vencia em ${Math.round(restante / 60_000)} min — ${rotulo}`);
  return rotulo;
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

  // 2. fila ANTES da sessão EntreGô (corrigido em 2026-09-04, antes de
  //    instalar os timers). O modo `sob-demanda` roda a cada 5 min: com a
  //    ordem anterior (sessão -> fila) toda execução com fila VAZIA — que é o
  //    estado normal — sondava a EntreGô à toa, ~288x/dia, e podia disparar
  //    login completo por token expirado. Isso na MESMA sessão compartilhada
  //    com a importação diária (dec-039), com PerimeterX ativo
  //    (ACHADOS-PORTAL.md §6). O robô nunca foi bloqueado porque quase não
  //    toca a plataforma; sondagem ociosa é exatamente o padrão que atrai
  //    bloqueio. Consultar a fila é uma chamada ao hub (barata, local).
  const itens = await clienteHub.buscarMotoristasParaEnriquecer(modo);
  if (itens.length === 0) {
    const keepAlive = await manterSessaoViva({ page, storageStatePath: config.storageStatePath });
    return { resultado: 'sem_dados', total: 0, sucessos: 0, falhas: 0, parouPorAntibotOuGap: false, motivoParada: null, sessao: keepAlive === 'renovada' ? 'renovada' : 'nao-tocou', keepAlive };
  }

  // 3. sessão EntreGô (sonda + login completo se 401 — reusa Decision 3).
  //    Só chega aqui se HÁ trabalho a fazer.
  // O retorno de `garantirSessaoValida` era DESCARTADO nos dois chamadores, e
  // com ele a única informação que distingue "reusou a sessão" de "fez login
  // completo". Login completo dispara código de validação por e-mail para o
  // operador: era ele quem descobria, pela caixa de entrada, o que o log não
  // contava. Medido em 2026-09-05: o access token do portal vive 3 min e o
  // timer roda a cada 5, então TODA rodada com trabalho relogava.
  const opcoesSessao = {
    email: config.entregoEmail,
    senha: config.entregoSenha,
    obterCodigo,
    storageStatePath: config.storageStatePath,
  };
  const rotularSessao = ({ relogou, renovada } = {}) => (relogou ? 'relogou' : renovada ? 'renovada' : 'reusada');
  const sessao = rotularSessao(await garantirSessaoValida(page, opcoesSessao));
  // eslint-disable-next-line no-console
  console.log(`[enriquecimento] sessão EntreGô: ${sessao}${sessao === 'relogou' ? ' (login completo — gerou código de validação)' : ''}`);

  let sucessos = 0;
  let falhas = 0;
  let motivoParada = null;
  let renovacoesNaRodada = 0;

  for (let i = 0; i < itens.length; i += 1) {
    const item = itens[i];
    // FR-016: throttle MÍNIMO de 60s entre motoristas processados NUMA
    // rodada — nunca antes do primeiro item.
    if (i > 0) await dormir(THROTTLE_MS_ENTRE_MOTORISTAS);

    try {
      try {
        await processarUmMotorista({ item, page, clienteHub, modo, dormir, buscarDadosPessoa });
      } catch (e) {
        // O token de acesso vive 3 min e a rodada espera 60 s entre motoristas
        // (medido 2026-09-05): toda rodada com 4+ motoristas cruza a expiração
        // NO MEIO. Antes disto o 401 interrompia a rodada no 4º motorista e o
        // resto do lote ficava para o timer seguinte — que relogava (código) e
        // processava mais 3. Renova (refresh; login completo só se o refresh
        // falhar) e retenta ESTE motorista uma vez. Um segundo 401 no mesmo
        // item cai no tratamento abaixo e para a rodada, como antes.
        if (e.sinal !== 'sessao_expirada_401') throw e;
        const rotulo = rotularSessao(await garantirSessaoValida(page, opcoesSessao));
        renovacoesNaRodada += 1;
        // eslint-disable-next-line no-console
        console.log(`[enriquecimento] sessão expirou no motorista ${i + 1}/${itens.length} — ${rotulo}, retentando`);
        await processarUmMotorista({ item, page, clienteHub, modo, dormir, buscarDadosPessoa });
      }
      sucessos += 1;
    } catch (e) {
      // FR-016/FR-011 — "parando em vez de insistir": suspeita de anti-bot OU
      // falha transitória/de sessão que sobrou dos 3 retries de
      // comRetryTransitorio (rede/5xx — nenhuma culpa DESTE motorista), ou um
      // 401 que PERSISTIU depois de renovar, interrompem a RODADA inteira. O
      // item CORRENTE fica sem PATCH — o pedido (dados_entrego_solicitado_em)
      // permanece pendente na fila, reprocessado na PRÓXIMA execução do timer.
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

  return { resultado, total: itens.length, sucessos, falhas, parouPorAntibotOuGap: motivoParada !== null, motivoParada, sessao, renovacoesNaRodada };
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
  manterSessaoViva,
  KEEPALIVE_MARGEM_MS,
  executarRodadaEnriquecimento,
  processarUmMotorista,
  THROTTLE_MS_ENTRE_MOTORISTAS,
  MODOS_VALIDOS,
  ENV_PATH_DEFAULT,
};
