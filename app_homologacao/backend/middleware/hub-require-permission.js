// hub-fundacoes (FASE 4) — middleware/hub-require-permission.js
//
// `requirePermission('modulo.acao')` — gate obrigatório de TODA ação de
// capacidade nova entregue pelo hub (FR-012, contracts/rbac-me.md
// §Middleware). Nenhuma rota nova do hub pode ser registrada sem passar por
// este middleware.
//
// Fail-closed EXPLÍCITO (research.md Decision 13 — achado mais crítico do
// gate `owasp-security`): qualquer erro/exceção/timeout na resolução de
// permissões DEVE negar (403), NUNCA `next()` num bloco catch/else de erro.
// `lib/hub-rbac-cache.js` já resolve para Set vazio em caso de erro de infra
// (e não cacheia o erro); o try/catch abaixo é uma SEGUNDA camada de defesa
// em profundidade contra qualquer exceção inesperada (ex.: TypeError) que
// escape do cache — o resultado é sempre negar, nunca permitir.
//
// Precedência = UNIÃO de grants, sem herança nem negação (FR-009, Decision 5)
// — o Set retornado por `obterPermissoesEfetivas` já é essa união achatada;
// este middleware só verifica pertencimento (`.has(codigo)`).
'use strict';

const { decodificarAccessToken, lerAccessTokenDoRequest } = require('../lib/hub-access-token');
const { obterPermissoesEfetivas } = require('../lib/hub-rbac-cache');

/**
 * Extrai e valida o `sub` (usuarioId) do cookie `accessToken`. Retorna `null`
 * se ausente ou inválido — NUNCA lança (mesmo padrão de
 * `decodificarUsuarioIdDoAccessToken` em routes/hub-auth.js).
 * @param {import('express').Request} req
 * @returns {string|number|null}
 */
function extrairUsuarioIdDoRequest(req) {
  const payload = decodificarAccessToken(lerAccessTokenDoRequest(req));
  return payload && payload.sub ? payload.sub : null;
}

/**
 * @param {string} codigoPermissao - ex.: `motoristas.consultar`
 * @returns {import('express').RequestHandler}
 */
function requirePermission(codigoPermissao) {
  return async function requirePermissionMiddleware(req, res, next) {
    const usuarioId = extrairUsuarioIdDoRequest(req);
    if (!usuarioId) {
      return res.status(401).json({ erro: 'NAO_AUTENTICADO' });
    }
    // Disponibiliza pra rota downstream (ex.: GET /auditoria) sem precisar
    // redecodificar o token.
    req.hubUsuarioId = usuarioId;

    try {
      const permissoes = await obterPermissoesEfetivas(usuarioId);
      if (!permissoes || !permissoes.has(codigoPermissao)) {
        return res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
      }
      return next();
    } catch (e) {
      // Fail-closed (Decision 13): NUNCA next() aqui — qualquer exceção nega.
      console.error(
        `[hub-require-permission] erro inesperado ao resolver '${codigoPermissao}' (fail-closed -> nega):`,
        e.message
      );
      return res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
    }
  };
}

module.exports = { requirePermission, extrairUsuarioIdDoRequest };
