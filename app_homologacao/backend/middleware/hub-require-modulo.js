// hub-auditoria-admin (S9) — middleware/hub-require-modulo.js
//
// `requireModuloAtivo('codigo')` — gate obrigatório de TODA rota de módulo
// novo/evoluído desde a S9 (FR-008/SC-005, research.md Decision 3;
// contracts/admin-modulos-api.md/usuarios-api.md/papeis-api.md). Aplicado
// SEMPRE ANTES de `requirePermission` na cadeia de middlewares — módulo
// desabilitado bloqueia mesmo quem tem a permissão de negócio.
//
// Fail-closed EXPLÍCITO (mesmo padrão de middleware/hub-require-permission.js
// Decision 13): qualquer erro/exceção na resolução do Set de módulos ativos
// DEVE negar (403 MODULO_DESABILITADO), NUNCA `next()` num catch. Sem
// entidade ativa determinável na sessão, também nega (não há como saber se o
// módulo está habilitado sem uma entidade para consultar `ModuloEntidade`).
'use strict';

const { decodificarAccessToken, lerAccessTokenDoRequest } = require('../lib/hub-access-token');
const { obterModulosAtivosPorEntidade } = require('../lib/hub-rbac-cache');

/**
 * @param {string} codigoModulo - ex.: `usuarios`, `auditoria`, `admin`
 * @returns {import('express').RequestHandler}
 */
function requireModuloAtivo(codigoModulo) {
  return async function requireModuloAtivoMiddleware(req, res, next) {
    const payload = decodificarAccessToken(lerAccessTokenDoRequest(req));
    if (!payload || !payload.sub) {
      return res.status(401).json({ erro: 'NAO_AUTENTICADO' });
    }

    const entidadeAtiva = payload.entidade_ativa ? Number(payload.entidade_ativa) : null;
    if (!entidadeAtiva) {
      // Sem entidade ativa não há `ModuloEntidade` para consultar com
      // segurança — nega-por-padrão (mesmo espírito de FR-028/3.3.1).
      return res.status(403).json({ erro: 'MODULO_DESABILITADO' });
    }

    try {
      const modulosAtivos = await obterModulosAtivosPorEntidade(entidadeAtiva);
      if (!modulosAtivos || !modulosAtivos.has(codigoModulo)) {
        return res.status(403).json({ erro: 'MODULO_DESABILITADO' });
      }
      return next();
    } catch (e) {
      // Fail-closed: NUNCA next() aqui — qualquer exceção nega.
      console.error(
        `[hub-require-modulo] erro inesperado ao resolver modulo '${codigoModulo}' (fail-closed -> nega):`,
        e.message
      );
      return res.status(403).json({ erro: 'MODULO_DESABILITADO' });
    }
  };
}

module.exports = { requireModuloAtivo };
