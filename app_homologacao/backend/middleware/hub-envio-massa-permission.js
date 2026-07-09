// hub-envio-massa (S8, tasks.md FASE 2.2) — middleware/hub-envio-massa-permission.js
//
// `hubEnvioMassaRequirePermission(codigo)` — gate de RBAC por ação, aplicado
// SOMENTE a sessões do hub (research.md Decision 3/5, contracts/
// legacy-endpoints.md). Posição na cadeia (research.md Decision 2):
// `authenticateToken` (legado, intocado) -> `hubEnvioMassaClaimsBridge` ->
// ESTE middleware -> handler da rota.
//
// Modo compatibilidade estrutural (Decision 5): sessão legada
// (`req.hubContext` indefinido, porque `hubEnvioMassaClaimsBridge` só seta
// `req.hubContext` no ramo hub) SEMPRE passa, independente da flag —
// NUNCA 403 para o painel legado (FR-018).
//
// Flag `HUB_RBAC_ENVIO` (Decision 6, FR-006): lida do env POR REQUEST (sem
// cache de processo), reversível sem restart de código (só restart do
// serviço/container, que já lê o `.env` de novo). `=== 'off'` desliga o
// gate para sessões hub (comportamento idêntico ao legado); qualquer outro
// valor (inclusive ausente/undefined) mantém o gate ligado — fail-safe por
// omissão (default ON).
//
// Fail-closed (achado `owasp-security`, mesmo padrão de
// `middleware/hub-require-permission.js` Decision 13): qualquer exceção na
// resolução de permissões NUNCA chama `next()` — sempre 403
// PERMISSAO_INSUFICIENTE.
'use strict';

const { obterPermissoesEfetivasPorEntidade } = require('../lib/hub-rbac-cache');

/**
 * @param {string} codigoPermissao - ex.: `envio_massa.consultar`
 * @returns {import('express').RequestHandler}
 */
function hubEnvioMassaRequirePermission(codigoPermissao) {
  return async function hubEnvioMassaRequirePermissionMiddleware(req, res, next) {
    // Sessão legada: hubEnvioMassaClaimsBridge não populou req.hubContext
    // neste caso (ramo 2, next() imediato) -> passa incondicionalmente,
    // independente da flag (Decision 5).
    if (!req.hubContext || req.hubContext.viaHub !== true) {
      return next();
    }

    // Leitura por request, sem cache de processo (Decision 6, FR-006).
    if (process.env.HUB_RBAC_ENVIO === 'off') {
      return next();
    }

    try {
      const usuarioId = req.hubContext.usuarioId;
      const empresaId = req.user && req.user.empresaId;
      const permissoes = await obterPermissoesEfetivasPorEntidade(usuarioId, empresaId);
      if (permissoes && permissoes.has(codigoPermissao)) {
        return next();
      }
      return res.status(403).json({ error: { code: 'PERMISSAO_INSUFICIENTE' } });
    } catch (e) {
      // Fail-closed: NUNCA next() aqui — qualquer exceção nega (mesmo
      // padrão de middleware/hub-require-permission.js Decision 13).
      console.error(
        `[hub-envio-massa-permission] erro inesperado ao resolver '${codigoPermissao}' (fail-closed -> nega):`,
        e && e.message
      );
      return res.status(403).json({ error: { code: 'PERMISSAO_INSUFICIENTE' } });
    }
  };
}

module.exports = { hubEnvioMassaRequirePermission };
