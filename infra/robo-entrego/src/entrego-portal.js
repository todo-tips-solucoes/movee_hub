// entrego-portal.js (tasks.md FASE 4) — sessão + login 4 passos + fetch de
// relatórios do portal EntreGô, via Playwright.
// Ref: contracts/entrego-portal.md, docs/plans/robo-entrego/ACHADOS-PORTAL.md
// (fonte única de seletores/endpoints — Princípio VI), research.md Decision
// 2/3/11.
//
// Regra de desenho (research.md Decision 2, resume 2026-08-28): TODA chamada
// ao BFF do portal roda dentro do `page.evaluate()` (herda cookies/fetch do
// browser) — nunca axios puro fora do browser para essas rotas. A UI só é
// tocada no fluxo de login (não há alternativa); o fetch de relatórios usa a
// API diretamente, minimizando interação com a página (evidência de
// PerimeterX no achado §6). Download do CSV é o único axios puro — o S3 não
// exige sessão (ACHADOS-PORTAL.md §4).
//
// Funções passadas a `page.evaluate()`/`page.waitForFunction()` (prefixo
// `_eval`) NUNCA fecham sobre escopo externo do módulo — só sobre o
// parâmetro `args` — porque em produção o Playwright serializa o código-fonte
// da função e o executa dentro do browser; qualquer variável de módulo
// referenciada ali seria `undefined` lá dentro. Nos testes, o mock de `page`
// chama essas mesmas funções direto em Node (sem esse risco), o que também
// as torna testáveis sem instalar/subir browser algum no host.
//
// Testável por injeção de `page` (interface mínima usada: `evaluate`,
// `waitForFunction`, `goto`, `fill`, `click`, `waitForSelector`,
// `context().storageState()`) — os testes unit passam um mock, sem
// Playwright real (convenção do repo: nunca instalar browsers no host).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const axios = require('axios');

const BASE_URL = 'https://api.entregolog.com/logistics-web-bff';
const LOGIN_URL_DEFAULT = 'https://franqueado.entregolog.com/login';
// Origem do portal. A sonda de sessão precisa que a página esteja AQUI antes de
// chamar a API por `page.evaluate` — de `about:blank` o fetch com credenciais
// falha (ver sondarSessaoValida).
const PORTAL_ORIGIN = 'https://franqueado.entregolog.com';
const STORAGE_STATE_PATH_DEFAULT = '/var/lib/hub_secrets/robo-entrego/entrego-session.json';

/** ACHADOS-PORTAL.md §5.4 — únicos 2 tipos suportados; tradução num único ponto (plan.md §Convenções de Borda). */
const TRADUCAO_TIPO_HUB = Object.freeze({ PERFORMANCE: 'performance', FINANCE: 'faturamento' });

// Defaults de engenharia (não fatos de negócio) — geração observada leva
// "poucos segundos" (ACHADOS-PORTAL.md §3), margem generosa não especificada.
const TIMEOUT_LOGIN_MS_DEFAULT = 30000;
const TIMEOUT_GERACAO_MS_DEFAULT = 2 * 60 * 1000;
const INTERVALO_POLL_GERACAO_MS_DEFAULT = 3000;

/** Suspeita de desafio anti-bot (research.md Decision 11) — NUNCA retry; parada imediata da rodada (FR-011). */
class ErroAntibotSuspeito extends Error {
  constructor(message) {
    super(message);
    this.name = 'ErroAntibotSuspeito';
    this.sinal = 'schema_inesperado';
  }
}

/**
 * O portal respondeu certo, mas o movimento do dia ainda não foi publicado.
 * NÃO é falha: é "tente de novo mais tarde" (config.json aceita vários
 * horários). Antes disto, uma lista vazia virava
 * `TypeError: Cannot read properties of undefined (reading 'url')` e um CSV só
 * com cabeçalho virava importação de 0 linhas marcada como sucesso.
 */
class ErroSemDados extends Error {
  constructor(message) {
    super(message);
    this.name = 'ErroSemDados';
    this.sinal = 'relatorio_sem_dados';
  }
}

/** Falha transitória (research.md Decision 11) — o chamador (FASE 5/index.js) decide o retry (FR-012). */
class ErroPortalTransitorio extends Error {
  constructor(message, sinal) {
    super(message);
    this.name = 'ErroPortalTransitorio';
    this.sinal = sinal;
  }
}

// ---------------------------------------------------------------------------
// 4.1 — Sessão persistida + sonda de validade
// ---------------------------------------------------------------------------

/** Carrega o storageState salvo (research.md Decision 3), ou `null` se ausente. */
function carregarStorageState(caminho = STORAGE_STATE_PATH_DEFAULT) {
  try {
    return JSON.parse(fs.readFileSync(caminho, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/** Persiste o storageState após login completo bem-sucedido (4.1.3), permissão 600 (data-model.md). */
function persistirStorageState(storageState, caminho = STORAGE_STATE_PATH_DEFAULT) {
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  fs.writeFileSync(caminho, JSON.stringify(storageState), { mode: 0o600 });
}

/** Avaliado dentro da página (contracts/entrego-portal.md: sonda reusa `GET .../authentication/me`). */
// ⚠️ Os headers aqui devem ser OS MESMOS de _evalBuscarUrls. `X-IFood-Logistics-Auth`
// e `x-cookie-login` não são decoração: sem eles o BFF responde
// 401 {"message":"no jwt token"} MESMO com a sessão válida (ACHADOS-PORTAL.md §3).
// A versão anterior mandava só `Accept` — a sonda dava 401 sempre, o robô concluía
// "sessão expirada" e refazia o login completo em TODA execução. Isso anulava a
// decisão do block-003 (reusar sessão, relogar só no 401 de verdade) e colocava o
// login — a etapa sujeita ao anti-bot — no caminho crítico diário.
// Diagnosticado na execução assistida de 2026-08-28: a sessão salva abria o painel
// normalmente enquanto a sonda insistia em 401.
const HEADERS_API = Object.freeze({
  Accept: 'application/json, text/plain, */*',
  'X-IFood-Logistics-Auth': 'true',
  'x-cookie-login': 'true',
  'X-Timezone': 'America/Sao_Paulo',
  'Accept-Language': 'pt',
  'x-country': 'BR',
});

/** Avaliado dentro da página — zera o storage da origem antes de relogar. */
function _evalLimparStorage() {
  try { localStorage.clear(); } catch (e) { /* storage bloqueado: segue */ }
  try { sessionStorage.clear(); } catch (e) { /* idem */ }
  return true;
}

async function _evalSondaSessao(args) {
  const resp = await fetch(`${args.baseURL}/operation/users/authentication/me`, {
    credentials: 'include',
    headers: args.headers,
  });
  return { status: resp.status };
}

/**
 * Sonda de sessão viva (research.md Decision 3, tasks.md 4.1.2).
 * @returns {Promise<{valida: boolean}>} `valida=false` (401) NÃO é falha — o
 *   chamador deve seguir para `realizarLoginCompleto` (taxonomia-erro.js:
 *   sinal `sessao_expirada_401` -> NAO_E_FALHA).
 * @throws {ErroPortalTransitorio} timeout/erro de rede/5xx — falha transitória
 */
async function sondarSessaoValida(page, { baseURL = BASE_URL, portalOrigin = PORTAL_ORIGIN, timeoutMs = TIMEOUT_LOGIN_MS_DEFAULT } = {}) {
  // O evaluate abaixo faz `fetch(..., {credentials:'include'})` DENTRO da página.
  // Isso exige que a página esteja num contexto de origem real: em `about:blank`
  // (estado de toda aba recém-criada) o fetch cross-origin falha na hora com
  // "Failed to fetch", e a sonda virava ErroPortalTransitorio SEMPRE na primeira
  // execução. Achado da execução assistida de 2026-08-28 — invisível nos testes,
  // que injetam um `page` mockado cujo `evaluate` devolve o status desejado.
  try {
    if (!String((page.url && page.url()) || '').startsWith(portalOrigin)) {
      await page.goto(portalOrigin, { timeout: timeoutMs });
    }
  } catch (e) {
    throw new ErroPortalTransitorio(`entrego-portal: navegação para o portal falhou (${e.message})`, 'erro_conexao');
  }

  let resultado;
  try {
    resultado = await page.evaluate(_evalSondaSessao, { baseURL, headers: HEADERS_API });
  } catch (e) {
    throw new ErroPortalTransitorio(`entrego-portal: sonda de sessão falhou (${e.message})`, 'erro_conexao');
  }
  if (resultado.status === 200) return { valida: true };
  if (resultado.status === 401) return { valida: false };
  if (resultado.status >= 500) {
    throw new ErroPortalTransitorio(`entrego-portal: sonda de sessão — 5xx (${resultado.status})`, 'http_5xx_portal');
  }
  throw new ErroAntibotSuspeito(`entrego-portal: sonda de sessão — status inesperado ${resultado.status}`);
}

// ---------------------------------------------------------------------------
// 4.2 — Fluxo de login completo (4 passos, ACHADOS-PORTAL.md §7)
// ---------------------------------------------------------------------------

// ⚠️ NÃO use `button[type="submit"]`. O seletor CSS casa pelo ATRIBUTO, e o React
// do portal renderiza `<button>` SEM o atributo `type` (o default do HTML já é
// submit). O levantamento original registrou `type: "submit"` porque leu a
// PROPRIEDADE DOM `e.type`, que devolve o default mesmo sem atributo — daí o
// seletor entrou errado e nunca encontrou nada no portal real. Diagnosticado na
// execução assistida de 2026-08-28: `document.querySelectorAll('button[type="submit"]')`
// devolve [] na tela de login enquanto o botão "Continuar" está visível.
// Localizar por TEXTO, como já era feito para o modal.
const SELETORES = Object.freeze({
  email: 'input#email',
  senha: 'input[data-testid="password"]',
  botaoContinuar: 'button:has-text("Continuar"):not([disabled])',
  botaoModal: 'text=OK, entendi',
  codigo: 'input#code',
  botaoConfirmar: 'button:has-text("Confirmar"):not([disabled])',
});

/** Avaliado dentro da página — sinal barato de "estou logado" (ACHADOS-PORTAL.md §7). */
function _evalTemUserData() {
  try {
    const redux = JSON.parse(localStorage.getItem('redux') || 'null');
    return Boolean(redux && redux.authentication && redux.authentication.userData);
  } catch (_e) {
    return false;
  }
}

/**
 * Login completo de 4 passos (ACHADOS-PORTAL.md §7, contracts/entrego-portal.md §Login).
 * Qualquer elemento que não aparecer dentro do timeout é suspeita de anti-bot
 * (research.md Decision 11) — nunca retry (tasks.md 4.2.5). Falhas de
 * `obterCodigo` (IMAP) propagam como estão — NÃO são reclassificadas como
 * anti-bot (são um problema de e-mail/timing, não do portal).
 * @param {object} page - Playwright Page (produção) ou mock (teste)
 * @param {object} opts
 * @param {string} opts.email
 * @param {string} opts.senha
 * @param {(timestampDisparo: Date) => Promise<string>} opts.obterCodigo -
 *   recebe o timestamp exato do disparo de `POST authentication/validate`
 *   (passo 2, tasks.md 4.2.4) e devolve o código de 6 dígitos; o wiring com
 *   `imap-codigo.js` é responsabilidade do chamador (FASE 5/index.js) — este
 *   módulo não conhece IMAP.
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.loginUrl]
 * @returns {Promise<object>} storageState pronto para `persistirStorageState()`
 * @throws {ErroAntibotSuspeito} passo 1-3 ou passo 4 não concluído no timeout
 */
async function realizarLoginCompleto(page, { email, senha, obterCodigo, timeoutMs = TIMEOUT_LOGIN_MS_DEFAULT, loginUrl = LOGIN_URL_DEFAULT } = {}) {
  let timestampDisparo;
  try {
    // Limpa a sessão residual ANTES de relogar. O portal tem DOIS níveis de
    // sessão: o token do BFF (que a sonda testa) expira antes do cookie de
    // navegação da SPA. Com o cookie ainda válido, `/login` REDIRECIONA para o
    // painel e o campo de senha nunca aparece — o login fica impossível
    // exatamente quando passa a ser necessário.
    // Observado em 2026-08-28: `GET /authentication/me` devolvia 401 (sessão de
    // API expirada) enquanto o painel carregava normalmente em
    // /supply/driver-booking-import; o login travava em
    // `waiting for locator('input[data-testid="password"]')`.
    try {
      if (page.context && typeof page.context === 'function') {
        const ctx = page.context();
        if (ctx && typeof ctx.clearCookies === 'function') await ctx.clearCookies();
      }
      // localStorage TAMBÉM. Limpar só os cookies não basta: o `storageState`
      // do Playwright restaura cookies E localStorage, e a SPA usa
      // `localStorage.redux.authentication.userData` como sinal de "estou
      // logado" (ACHADOS-PORTAL.md §7). Com ele presente, o portal desvia do
      // fluxo de login no meio — observado em 2026-08-28: o passo 1 completava
      // (200 em validation/first-login) e a página ia para
      // /supply/driver-booking-import em vez de /login/password.
      // Precisa estar NA origem para tocar o storage dela.
      if (typeof page.goto === 'function' && typeof page.evaluate === 'function') {
        await page.goto(PORTAL_ORIGIN, { timeout: timeoutMs });
        await page.evaluate(_evalLimparStorage);
      }
    } catch (_) {
      // best-effort: se a limpeza falhar, o login ainda pode dar certo quando
      // não houver sessão residual.
    }

    // Passo 1
    await page.goto(loginUrl, { timeout: timeoutMs });
    await page.fill(SELETORES.email, email, { timeout: timeoutMs });
    await page.click(SELETORES.botaoContinuar, { timeout: timeoutMs });

    // Passo 2 — captura o timestamp EXATO do disparo (tasks.md 4.2.4)
    await page.waitForSelector(SELETORES.senha, { timeout: timeoutMs });
    await page.fill(SELETORES.senha, senha, { timeout: timeoutMs });
    timestampDisparo = new Date();
    await page.click(SELETORES.botaoContinuar, { timeout: timeoutMs });

    // Passo 3 — modal sem role="dialog", localizado por texto
    await page.click(SELETORES.botaoModal, { timeout: timeoutMs });

    // aguarda o campo do passo 4 aparecer antes de pedir o código
    await page.waitForSelector(SELETORES.codigo, { timeout: timeoutMs });
  } catch (e) {
    throw new ErroAntibotSuspeito(`entrego-portal: login (passos 1-3) não concluído dentro do timeout (${e.message})`);
  }

  const codigo = await obterCodigo(timestampDisparo);

  try {
    // Passo 4
    await page.fill(SELETORES.codigo, codigo, { timeout: timeoutMs });
    await page.click(SELETORES.botaoConfirmar, { timeout: timeoutMs });
    await page.waitForFunction(_evalTemUserData, null, { timeout: timeoutMs });
  } catch (e) {
    throw new ErroAntibotSuspeito(`entrego-portal: login (passo 4) não concluído dentro do timeout (${e.message})`);
  }

  return page.context().storageState();
}

/**
 * Garante sessão válida antes de qualquer chamada ao portal — combina 4.1.2
 * (sonda) + 4.2 (login completo se necessário) + 4.1.3 (persiste após
 * relogar). O `browserContext` já deve ter sido criado com o storageState
 * carregado por `carregarStorageState()` (Playwright exige isso na criação
 * do contexto, não depois) — isso é responsabilidade do chamador (FASE 5).
 * @returns {Promise<{relogou: boolean}>}
 */
async function garantirSessaoValida(page, { email, senha, obterCodigo, baseURL = BASE_URL, storageStatePath = STORAGE_STATE_PATH_DEFAULT, timeoutMs, loginUrl } = {}) {
  const { valida } = await sondarSessaoValida(page, { baseURL });
  if (valida) return { relogou: false };
  const storageState = await realizarLoginCompleto(page, { email, senha, obterCodigo, timeoutMs, loginUrl });
  persistirStorageState(storageState, storageStatePath);
  return { relogou: true };
}

// ---------------------------------------------------------------------------
// 4.3 — Fetch dos relatórios + detecção de desafio anti-bot
// ---------------------------------------------------------------------------

/** Avaliado dentro da página — headers reproduzidos de ACHADOS-PORTAL.md §3 (o app os aplica automaticamente; aqui é o robô que precisa montá-los, já que chama via `page.evaluate`, não pelo form real). */
async function _evalBuscarUrls(args) {
  const qs = `type=${args.tipo}&initialDate=${args.dataInicial}&finalDate=${args.dataFinal}`;
  const resp = await fetch(`${args.baseURL}/operation/logistics-operator/reports/${args.tipo}/urls?${qs}`, {
    credentials: 'include',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'X-IFood-Logistics-Auth': 'true',
      'x-cookie-login': 'true',
      'X-Timezone': 'America/Sao_Paulo',
      'Accept-Language': 'pt',
      'x-country': 'BR',
    },
  });
  const contentType = (resp.headers.get('content-type') || '').toLowerCase();
  const corpo = contentType.includes('application/json') ? await resp.json() : await resp.text();
  return { status: resp.status, contentType, corpo };
}

const REGEX_DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Valida o shape MEDIDO (ACHADOS-PORTAL.md §3, dec-036): array na raiz, cada
 * item `{url, date}`. Qualquer desvio é suspeita de anti-bot (Decision 11) —
 * nunca tenta "interpretar" um formato diferente (tasks.md 4.3.3).
 */
function validarItensUrls(corpo) {
  // ATENÇÃO: array vazio NÃO é "sem dados" — é "relatório ainda GERANDO".
  // O portal gera de forma assíncrona e `buscarUrlsRelatorio` faz polling
  // esperando o item aparecer (timeout -> ErroPortalTransitorio, que o FR-012
  // retenta). Tratar vazio como sem-dados aqui QUEBRA esse polling — tentado
  // e revertido em 2026-08-29, pego pelos testes existentes.
  // O caso real de "movimento não publicado" é o CSV que vem só com
  // cabeçalho, detectado em index.js após o download.
  if (!Array.isArray(corpo)) {
    throw new ErroAntibotSuspeito('entrego-portal: /urls — resposta não é array (fora do shape medido em ACHADOS-PORTAL.md §3)');
  }
  for (const item of corpo) {
    if (!item || typeof item.url !== 'string' || !item.url.startsWith('https://s3.amazonaws.com/')) {
      throw new ErroAntibotSuspeito('entrego-portal: /urls — item sem url S3 válida (fora do shape medido)');
    }
    if (typeof item.date !== 'string' || !REGEX_DATA_ISO.test(item.date)) {
      throw new ErroAntibotSuspeito('entrego-portal: /urls — item sem date no formato yyyy-MM-dd (fora do shape medido)');
    }
  }
  return corpo;
}

/**
 * Busca as URLs pré-assinadas de um tipo de relatório (tasks.md 4.3.1-4.3.3).
 * A tela observada mostra "processando"→"concluído" (ACHADOS-PORTAL.md §3);
 * não há endpoint de status separado documentado, então o robô repete a
 * própria chamada de `/urls` como proxy de "ainda processando" enquanto o
 * array vier vazio — no caso comum (resposta já pronta) isso é 1 chamada só.
 * @param {object} page
 * @param {object} opts
 * @param {'PERFORMANCE'|'FINANCE'} opts.tipo
 * @param {string} opts.dataInicial `yyyy-MM-dd`
 * @param {string} opts.dataFinal `yyyy-MM-dd`
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.intervaloMs]
 * @param {Function} [opts.dormir] override para teste
 * @param {Function} [opts.agora] override para teste
 * @returns {Promise<{tipoPortal:string, tipoHub:string, url:string, date:string}[]>}
 * @throws {ErroAntibotSuspeito} resposta fora do shape medido — nunca retry
 * @throws {ErroPortalTransitorio} 401/5xx/timeout de geração — falha de tentativa (FR-004/FR-012)
 */
async function buscarUrlsRelatorio(
  page,
  {
    tipo,
    dataInicial,
    dataFinal,
    baseURL = BASE_URL,
    timeoutMs = TIMEOUT_GERACAO_MS_DEFAULT,
    intervaloMs = INTERVALO_POLL_GERACAO_MS_DEFAULT,
    dormir,
    agora,
  } = {}
) {
  const _dormir = dormir || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const _agora = agora || Date.now;
  const inicio = _agora();
  for (;;) {
    let resultado;
    try {
      resultado = await page.evaluate(_evalBuscarUrls, { baseURL, tipo, dataInicial, dataFinal });
    } catch (e) {
      throw new ErroPortalTransitorio(`entrego-portal: /urls — falha de rede (${e.message})`, 'erro_conexao');
    }
    if (resultado.status === 401) {
      throw new ErroPortalTransitorio('entrego-portal: /urls — sessão expirada (401) no meio da rodada', 'sessao_expirada_401');
    }
    if (resultado.status >= 500) {
      throw new ErroPortalTransitorio(`entrego-portal: /urls — 5xx (${resultado.status})`, 'http_5xx_portal');
    }
    if (resultado.status !== 200 || !resultado.contentType.includes('application/json')) {
      throw new ErroAntibotSuspeito(
        `entrego-portal: /urls — status/content-type fora do documentado (status=${resultado.status}, content-type=${resultado.contentType})`
      );
    }
    const itens = validarItensUrls(resultado.corpo);
    if (itens.length > 0) {
      return itens.map((item) => ({ tipoPortal: tipo, tipoHub: TRADUCAO_TIPO_HUB[tipo], url: item.url, date: item.date }));
    }
    if (_agora() - inicio >= timeoutMs) {
      throw new ErroPortalTransitorio(`entrego-portal: /urls — geração não concluiu dentro de ${timeoutMs}ms (FR-004)`, 'timeout_rede');
    }
    await _dormir(intervaloMs);
  }
}

/**
 * Baixa o CSV da URL pré-assinada do S3 (tasks.md 4.3.4) — axios puro, fora
 * do Playwright (URL pré-assinada não precisa de sessão, ACHADOS-PORTAL.md
 * §4). Detecta a assinatura de erro documentada (XML/HTML da AWS) ANTES de
 * aceitar o corpo como CSV (contracts/entrego-portal.md §Download do CSV) —
 * não assume um Content-Type específico de sucesso (não verificado,
 * research.md Decision 10), só rejeita a assinatura de erro conhecida.
 * @throws {ErroPortalTransitorio} status != 200, ou corpo com assinatura de erro do S3 — sinal `erro_conexao` (falha de tentativa, não anti-bot: o S3 fica fora do alcance do PerimeterX)
 */
async function baixarCsv(url, { axiosInstance = axios } = {}) {
  let resp;
  try {
    resp = await axiosInstance.get(url, { responseType: 'arraybuffer', validateStatus: () => true });
  } catch (e) {
    throw new ErroPortalTransitorio(`entrego-portal: download do CSV — falha de rede (${e.message})`, 'erro_conexao');
  }
  const contentType = String((resp.headers && resp.headers['content-type']) || '').toLowerCase();
  const amostra = Buffer.from(resp.data).subarray(0, 64).toString('utf8').trimStart();
  const pareceErroS3 = resp.status !== 200 || contentType.includes('xml') || contentType.includes('html') || amostra.startsWith('<?xml') || amostra.startsWith('<Error');
  if (pareceErroS3) {
    throw new ErroPortalTransitorio(
      `entrego-portal: download do CSV — resposta de erro do S3 (status=${resp.status}, content-type=${contentType || '(vazio)'})`,
      'erro_conexao'
    );
  }
  const buffer = Buffer.from(resp.data);
  return { buffer, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}

module.exports = {
  // 4.1
  carregarStorageState,
  persistirStorageState,
  sondarSessaoValida,
  garantirSessaoValida,
  // 4.2
  realizarLoginCompleto,
  // 4.3
  buscarUrlsRelatorio,
  baixarCsv,
  validarItensUrls,
  // constantes/erros
  TRADUCAO_TIPO_HUB,
  STORAGE_STATE_PATH_DEFAULT,
  ErroAntibotSuspeito,
  ErroSemDados,
  ErroPortalTransitorio,
};
