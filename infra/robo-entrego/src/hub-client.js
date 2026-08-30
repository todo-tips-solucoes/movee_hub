// hub-client.js (tasks.md FASE 3, 3.3) — login + upload + polling no hub.
// Ref: docs/specs/robo-entrego/contracts/hub-api.md (login, importacoes,
// polling) — únicas 3 rotas consumidas, todas EXISTENTES exceto o endpoint
// de auditoria (routes/hub-robo-entrego.js, FASE 2, chamado por index.js
// separadamente, não deste módulo).
//
// Cookie jar manual (decisão de implementação deixada em aberto pelo
// contrato): sem `tough-cookie`/`axios-cookiejar-support` — o Set-Cookie da
// resposta de login é capturado e reenviado como header `Cookie:` bruto nas
// chamadas seguintes. Evita dependência nova para um cliente com 1 sessão só
// (ladder rung 5: nenhuma dependência já instalada resolve isso melhor do
// que ~10 linhas).
//
// Testável por injeção de `axiosInstance` (interface mínima usada:
// `.post(url, body, opts)` / `.get(url, opts)` -> `{status, data, headers}`)
// — os testes unit passam um mock, sem servidor HTTP real nem `nock`.
'use strict';

const axios = require('axios');
const FormData = require('form-data');

const POLL_INTERVAL_MS_DEFAULT = 5000;
const POLL_TIMEOUT_MS_DEFAULT = 5 * 60 * 1000; // 5min — não especificado pela spec/plan; default de engenharia (não fato de negócio), ajustável via opts.

/** Erro de CONFIGURAÇÃO (contracts/hub-api.md: entidade_ativa ≠ HUB_ID_EMPRESA) — nunca retry. */
class ErroConfiguracaoHub extends Error {}

/** Erro de resposta do hub (upload 422, status inesperado, timeout de polling). */
class ErroHub extends Error {
  constructor(message, { motivo } = {}) {
    super(message);
    this.name = 'ErroHub';
    this.motivo = motivo;
  }
}

function extrairCookieHeader(setCookieHeaders) {
  if (!setCookieHeaders) return null;
  const lista = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  const pares = lista.map((c) => c.split(';')[0]).filter(Boolean);
  return pares.length ? pares.join('; ') : null;
}

function extrairValorCookie(cookieHeader, nome) {
  if (!cookieHeader) return null;
  const par = cookieHeader.split('; ').find((c) => c.startsWith(`${nome}=`));
  return par ? par.slice(nome.length + 1) : null;
}

/** Decodifica (SEM verificar assinatura) o payload de um JWT — o robô só lê
 * a claim `entidade_ativa` de um token que ELE MESMO acabou de receber via
 * TLS direto do hub; não há superfície de confiar-em-token-de-terceiro aqui. */
function decodificarPayloadJwt(token) {
  if (typeof token !== 'string') return null;
  const partes = token.split('.');
  if (partes.length < 2) return null;
  try {
    const b64 = partes[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch (_e) {
    return null;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.baseURL - HUB_BASE_URL da configuração
 * @param {number|string} opts.idEmpresaEsperado - HUB_ID_EMPRESA
 * @param {object} [opts.axiosInstance] - override para testes
 */
function criarClienteHub({ baseURL, idEmpresaEsperado, axiosInstance }) {
  const http = axiosInstance || axios.create({ baseURL, timeout: 30000, validateStatus: () => true });
  let cookieHeader = null;

  function garantirAutenticado() {
    if (!cookieHeader) throw new ErroHub('hub-client: chamada antes de login() bem-sucedido');
  }

  /**
   * POST /api/v1/auth/login + POST /api/v1/me/entidade. Confere entidade_ativa
   * contra idEmpresaEsperado (contracts/hub-api.md — falha aqui é
   * ErroConfiguracaoHub, nunca retry).
   *
   * CORREÇÃO EMPÍRICA (tasks.md 6.2 — roundtrip real contra hub-homolog,
   * 2026-08-28): o token emitido por POST /auth/login NUNCA carrega a claim
   * `entidade_ativa` — `routes/hub-auth.js#gerarAccessToken` assina só
   * `{sub, email}` (confirmado lendo o código-fonte e decodificando o JWT de
   * uma sessão real de teste). A claim só existe após POST /me/entidade
   * selecionar a entidade explicitamente — mesmo para um usuário com um único
   * vínculo. O contrato (contracts/hub-api.md) documentava, incorretamente,
   * que o login já entregava a claim pronta; corrigido junto com este fix.
   */
  async function login(email, senha) {
    const resp = await http.post('/api/v1/auth/login', { email, senha });
    if (resp.status !== 200) {
      throw new ErroHub(`hub-client: login falhou (status ${resp.status})`, {
        motivo: resp.data && resp.data.erro,
      });
    }
    cookieHeader = extrairCookieHeader(resp.headers && resp.headers['set-cookie']);
    if (!cookieHeader) {
      throw new ErroHub('hub-client: login 200 sem Set-Cookie');
    }

    const respEntidade = await http.post(
      '/api/v1/me/entidade',
      { empresa_id: Number(idEmpresaEsperado) },
      { headers: { Cookie: cookieHeader } }
    );
    if (respEntidade.status !== 200) {
      throw new ErroConfiguracaoHub(
        `hub-client: POST /me/entidade (empresa_id=${idEmpresaEsperado}) falhou (status ${respEntidade.status}) — corrigir cadastro/vínculo do usuário de serviço`
      );
    }
    const cookieEntidade = extrairCookieHeader(respEntidade.headers && respEntidade.headers['set-cookie']);
    if (cookieEntidade) cookieHeader = cookieEntidade;

    const accessToken = extrairValorCookie(cookieHeader, 'hub_accessToken');
    const payload = decodificarPayloadJwt(accessToken);
    const entidadeAtiva = payload && payload.entidade_ativa != null ? Number(payload.entidade_ativa) : null;
    if (entidadeAtiva !== Number(idEmpresaEsperado)) {
      throw new ErroConfiguracaoHub(
        `hub-client: entidade_ativa do token (${entidadeAtiva}) difere de HUB_ID_EMPRESA (${idEmpresaEsperado}) — corrigir cadastro do usuário de serviço`
      );
    }
    return { entidadeAtiva };
  }

  /**
   * POST /api/v1/importacoes (multipart). Devolve `{sinal, ...}` com `sinal`
   * já no vocabulário de src/taxonomia-erro.js — index.js (FASE 5) só
   * repassa para `classificarSinal`.
   */
  async function enviarImportacao({ tipo, nomeArquivo, bufferArquivo }) {
    garantirAutenticado();
    const form = new FormData();
    form.append('tipo', tipo);
    form.append('file', bufferArquivo, { filename: nomeArquivo });
    const resp = await http.post('/api/v1/importacoes', form, {
      headers: { ...form.getHeaders(), Cookie: cookieHeader },
    });
    if (resp.status === 201) return { sinal: 'upload_201', id: resp.data.id, status: resp.data.status };
    if (resp.status === 409) return { sinal: 'upload_409', importacaoOriginalId: resp.data.importacaoOriginalId };
    if (resp.status === 422) return { sinal: 'upload_422', motivo: resp.data.motivo };
    if (resp.status >= 500) return { sinal: 'http_5xx_hub', status: resp.status };
    throw new ErroHub(`hub-client: upload — status inesperado ${resp.status}`, { motivo: resp.data && (resp.data.erro || resp.data.error) });
  }

  /**
   * POST /api/v1/importacoes/:id/reprocessar — refaz uma importação que
   * terminou torta (failed/cancelled/completed_with_errors) REUSANDO o mesmo
   * id. É a única saída quando o arquivo já subiu: reenviá-lo bate em
   * UNIQUE(id_empresa,tipo,hash_sha256) e volta 409 para sempre.
   * 409 aqui = já não está refazível (outra passada ganhou a corrida, ou o
   * estado virou `completed`) — não é erro, é "não há o que refazer".
   */
  async function reprocessarImportacao(id) {
    garantirAutenticado();
    const resp = await http.post(`/api/v1/importacoes/${id}/reprocessar`, null, {
      headers: { Cookie: cookieHeader },
    });
    if (resp.status === 202) return { sinal: 'reprocessar_202', id: resp.data.id, status: resp.data.status };
    if (resp.status === 409) return { sinal: 'reprocessar_409' };
    if (resp.status === 404) return { sinal: 'reprocessar_404' };
    if (resp.status >= 500) return { sinal: 'http_5xx_hub', status: resp.status };
    throw new ErroHub(`hub-client: reprocessar — status inesperado ${resp.status}`, { motivo: resp.data && (resp.data.erro || resp.data.error) });
  }

  /**
   * GET /api/v1/importacoes/:id em loop até status terminal (contracts/hub-api.md).
   * `dormir`/`agora` injetáveis para teste (sem esperar tempo real nem
   * depender do relógio real para exercitar o timeout).
   */
  async function pollarImportacao(id, { intervaloMs = POLL_INTERVAL_MS_DEFAULT, timeoutMs = POLL_TIMEOUT_MS_DEFAULT, dormir, agora } = {}) {
    garantirAutenticado();
    const _dormir = dormir || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const _agora = agora || Date.now;
    const inicio = _agora();
    for (;;) {
      const resp = await http.get(`/api/v1/importacoes/${id}`, { headers: { Cookie: cookieHeader } });
      if (resp.status !== 200) {
        throw new ErroHub(`hub-client: polling — status inesperado ${resp.status}`);
      }
      const dados = resp.data;
      if (dados.status === 'failed') return { sinal: 'polling_failed', dados };
      if (dados.status === 'completed_with_errors') return { sinal: 'polling_completed_with_errors', dados };
      if (dados.status === 'cancelled') return { sinal: 'polling_failed', dados }; // não-sucesso; motivo em dados.erroResumo
      if (dados.status === 'completed') return { sinal: 'polling_completed', dados };
      if (_agora() - inicio >= timeoutMs) {
        throw new ErroHub(`hub-client: polling — timeout após ${timeoutMs}ms (último status: ${dados.status})`);
      }
      await _dormir(intervaloMs);
    }
  }

  /**
   * POST /api/v1/robo-entrego/eventos (tasks.md FASE 5, research.md Decision
   * 9) — trilha de auditoria das 3 reações de FR-013. Best-effort por design
   * (`registrarAuditoria` no hub já é best-effort/nunca lança,
   * contracts/hub-api.md) — o CHAMADOR (index.js) decide se uma falha aqui
   * impede as outras 2 reações (não deveria: log e e-mail seguem
   * independentes, `Promise.allSettled`).
   * @param {object} opts
   * @param {string} opts.acao - allowlist do backend (`ACOES_PERMITIDAS` em
   *   routes/hub-robo-entrego.js): `robo_entrego.sucesso` |
   *   `robo_entrego.falha_definitiva` | `robo_entrego.suspeita_antibot` |
   *   `robo_entrego.falha_configuracao`
   * @param {object} [opts.detalhes]
   */
  async function registrarEvento({ acao, detalhes } = {}) {
    garantirAutenticado();
    const resp = await http.post('/api/v1/robo-entrego/eventos', { acao, detalhes }, { headers: { Cookie: cookieHeader } });
    if (resp.status === 201) return { sinal: 'evento_201' };
    if (resp.status >= 500) return { sinal: 'http_5xx_hub', status: resp.status };
    throw new ErroHub(`hub-client: registrarEvento — status inesperado ${resp.status}`, { motivo: resp.data && resp.data.erro });
  }

  /**
   * GET /api/v1/importacoes/:id/erros — os rastros de linha da importação.
   *
   * Existe para o AVISO DE VALOR SILENCIOSO: desde a migration 0054, um `valor`
   * de faturamento que venha como texto é gravado como 0 e a importação termina
   * `completed`. O total do período fica subestimado e NADA avisa — o único
   * sinal é este registro. Sem consultá-lo, o dado errado passa despercebido.
   *
   * Best-effort por desenho: uma falha aqui NUNCA pode transformar uma
   * importação bem-sucedida em falha. Devolve [] e segue.
   */
  async function consultarErrosImportacao(id, { limite = 200 } = {}) {
    try {
      garantirAutenticado();
      const resp = await http.get(`/api/v1/importacoes/${id}/erros?limit=${limite}`, {
        headers: { Cookie: cookieHeader },
      });
      if (resp.status !== 200) return [];
      const corpo = resp.data;
      return Array.isArray(corpo) ? corpo : (corpo && Array.isArray(corpo.items) ? corpo.items : []);
    } catch (_) {
      return [];
    }
  }

  return { login, enviarImportacao, reprocessarImportacao, pollarImportacao, registrarEvento, consultarErrosImportacao };
}

module.exports = {
  criarClienteHub,
  ErroConfiguracaoHub,
  ErroHub,
  POLL_INTERVAL_MS_DEFAULT,
  POLL_TIMEOUT_MS_DEFAULT,
  // exportados para teste unitário puro (sem precisar de client completo)
  extrairCookieHeader,
  extrairValorCookie,
  decodificarPayloadJwt,
};
