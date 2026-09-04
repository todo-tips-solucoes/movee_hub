// busca-pessoa-entrego.js (hub-motorista-360 FASE 5, tasks.md 5.3.2) — busca
// dos dados de cadastro da pessoa entregadora no portal EntreGô, por UUID.
//
// docs/plans/robo-entrego/ACHADOS-PORTAL.md §9 (MAPEADO 2026-09-04, sessão
// operador-supervisionada) confirma o endpoint do BFF e a estrutura da
// resposta — via de API preferencial (spec.md FR-016), mesmo padrão de
// page.evaluate já usado por entrego-portal.js#buscarUrlsRelatorio. Os 6
// XPaths do briefing (BRIEFING-INPUT.md) e os seletores medidos do filtro
// (ACHADOS-PORTAL.md §9.2) ficam como plano B DECLARADO no plano técnico
// (plan.md), não implementados aqui: o caminho feliz medido é 1 chamada de
// API só (§9.3), navegação por UI é desnecessária (ladder rung 1 — YAGNI).
//
// dec-072 (instrução literal do operador): as 4 URLs de foto do payload
// (identityDocumentFrontPhoto, identityDocumentBackPhoto, driverLicensePhoto,
// workerPhoto) NUNCA são baixadas, persistidas, logadas ou trafegadas ao hub.
// `mapearParaShapeInterno` usa ALLOWLIST (nunca spread do corpo bruto) — as
// chaves de foto simplesmente não têm destino no shape interno.
'use strict';

const { ErroAntibotSuspeito, ErroPortalTransitorio, HEADERS_API } = require('./entrego-portal');

const BASE_URL = 'https://api.entregolog.com/logistics-web-bff';
const PORTAL_ORIGIN = 'https://franqueado.entregolog.com';
const TIMEOUT_NAVEGACAO_MS_DEFAULT = 30000;

/**
 * Avaliado DENTRO da página (`page.evaluate`) — nunca fecha sobre escopo
 * externo do módulo, só sobre `args` (o Playwright serializa o código-fonte
 * desta função e a executa no browser; ver aviso equivalente em
 * entrego-portal.js). ACHADOS-PORTAL.md §9.3.
 */
async function _evalBuscarPessoa(args) {
  const resp = await fetch(`${args.baseURL}/operation/logistics-operator/drivers/${args.uuid}`, {
    credentials: 'include',
    headers: args.headers,
  });
  const contentType = (resp.headers.get('content-type') || '').toLowerCase();
  const corpo = contentType.includes('application/json') ? await resp.json() : await resp.text();
  return { status: resp.status, contentType, corpo };
}

/**
 * Mapeia o payload MEDIDO (ACHADOS-PORTAL.md §9.4) para o shape interno FIXO
 * de data-model.md §"Shape interno de dados_entrego_json". ALLOWLIST
 * deliberada (nunca spread do corpo bruto): descarta explicitamente as 4
 * chaves de foto (dec-072) e os campos fora do shape interno (modalUuid,
 * possibleModals, region, quality). Forma VARIÁVEL confirmada com 2
 * motoristas (ACHADOS-PORTAL.md §9.5.3): `documentDriver.rg`/`.cnh` e
 * `personalData.fatherName` são OPCIONAIS — acesso com `?.`/`??`, nunca
 * lançado como erro por ausência.
 * @param {object} corpo - resposta JSON já parseada de `_evalBuscarPessoa`
 * @returns {object} shape de data-model.md §Shape interno de dados_entrego_json
 */
function mapearParaShapeInterno(corpo) {
  const p = corpo.personalData || {};
  const d = corpo.documentDriver || {};
  const c = corpo.emergencyContact || {};
  const e = corpo.lastDelivery || {};
  const m = corpo.currentModal || {};
  return {
    dadosPessoais: {
      nomeCompleto: p.fullName ?? null,
      dataNascimento: p.birthdate ?? null,
      email: p.email ?? null,
      cpf: p.cpf ?? null,
      nomeMae: p.motherName ?? null,
      nomePai: p.fatherName ?? null,
      telefone: p.phone ?? null,
    },
    documentos: {
      rg: d.rg ?? null,
      cnh: d.cnh ?? null,
    },
    contatoEmergencia: {
      grauParentesco: c.relationship ?? null,
      nome: c.name ?? null,
      telefone: c.phone ?? null,
    },
    informacoesEntrega: {
      operadorLogistico: e.logisticOperatorName ?? null,
      modal: m.modalName ?? null,
    },
  };
}

/**
 * Busca os dados da pessoa entregadora via API do BFF (ACHADOS-PORTAL.md
 * §9.3 — endpoint confirmado em sessão supervisionada, task 5.3.1). Chamada
 * DENTRO da página (`page.evaluate`, `credentials:'include'`), mesmo padrão
 * de entrego-portal.js#buscarUrlsRelatorio/#sondarSessaoValida — nunca axios
 * puro fora do browser para rotas do BFF.
 * @param {object} page - Playwright Page (produção) ou mock (teste)
 * @param {object} opts
 * @param {string} opts.uuid - `Entregador.id_externo` (UUID EntreGô)
 * @param {string} [opts.baseURL]
 * @param {string} [opts.portalOrigin]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<object>} shape de data-model.md §Shape interno de dados_entrego_json
 * @throws {ErroPortalTransitorio} navegação/rede falhou, 401 (sessão expirada) ou 5xx — sinal p/ taxonomia-erro.js
 * @throws {ErroAntibotSuspeito} status/content-type/shape fora do documentado em §9.3/§9.4
 */
async function buscarDadosPessoaPorUuid(
  page,
  { uuid, baseURL = BASE_URL, portalOrigin = PORTAL_ORIGIN, timeoutMs = TIMEOUT_NAVEGACAO_MS_DEFAULT } = {}
) {
  // Mesma guarda de entrego-portal.js#sondarSessaoValida: de about:blank o
  // fetch com credentials:'include' falha na hora (aba recém-criada).
  try {
    if (!String((page.url && page.url()) || '').startsWith(portalOrigin)) {
      await page.goto(portalOrigin, { timeout: timeoutMs });
    }
  } catch (e) {
    throw new ErroPortalTransitorio(`busca-pessoa-entrego: navegação para o portal falhou (${e.message})`, 'erro_conexao');
  }

  let resultado;
  try {
    resultado = await page.evaluate(_evalBuscarPessoa, { baseURL, uuid, headers: HEADERS_API });
  } catch (e) {
    throw new ErroPortalTransitorio(`busca-pessoa-entrego: /drivers/{uuid} — falha de rede (${e.message})`, 'erro_conexao');
  }
  if (resultado.status === 401) {
    throw new ErroPortalTransitorio('busca-pessoa-entrego: /drivers/{uuid} — sessão expirada (401)', 'sessao_expirada_401');
  }
  if (resultado.status >= 500) {
    throw new ErroPortalTransitorio(`busca-pessoa-entrego: /drivers/{uuid} — 5xx (${resultado.status})`, 'http_5xx_portal');
  }
  if (
    resultado.status !== 200
    || !resultado.contentType.includes('application/json')
    || !resultado.corpo
    || typeof resultado.corpo !== 'object'
  ) {
    throw new ErroAntibotSuspeito(
      `busca-pessoa-entrego: /drivers/{uuid} — status/content-type/shape fora do documentado em `
      + `ACHADOS-PORTAL.md §9.3/§9.4 (status=${resultado.status}, content-type=${resultado.contentType})`
    );
  }

  return mapearParaShapeInterno(resultado.corpo);
}

module.exports = {
  buscarDadosPessoaPorUuid,
  mapearParaShapeInterno,
};
