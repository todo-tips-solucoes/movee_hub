// hub-fundacoes (FASE 3) — lib/hub-postgrest-jwt.js
//
// Evolução ISOLADA do JWT do PostgREST usado exclusivamente pelo backend do hub
// (research.md Decision 3). A função legada `generatePostgrestJWT()`
// (server.js:99-106) NÃO é editada — continua gerando um token estático sem
// claims para a produção. Este módulo é 100% novo.
//
// IMPORTANTE (Decision 3 + compose.hub.*.yml): o segredo correto para assinar
// é `PGRST_JWT_SECRET` — é o que o container `postgrest` de fato valida
// (`PGRST_JWT_SECRET: "${PGRST_JWT_SECRET:?}"` em infra/hub/compose.hub.*.yml).
// `POSTGREST_API_KEY` é um env legado, mantido por paridade de nomenclatura com
// server.js, mas NÃO é o segredo do PostgREST do hub.
//
// FASE 3 (autenticação) só precisa do papel `authenticated` sem claims de
// escopo — RLS/claims de entidade (`empresa_ativa`, `escopo`) chegam na FASE 5
// (0006_rls_policies.sql). Por isso os parâmetros de claim são opcionais aqui:
// nesta fase o caller chama `generateHubPostgrestJWT()` sem argumentos.
'use strict';

const jwt = require('jsonwebtoken');

/**
 * Gera um JWT do PostgREST do hub, por request.
 * @param {object} [claims]
 * @param {number|string} [claims.usuarioId] - vira `sub` (FASE 3+)
 * @param {number|string} [claims.empresaAtiva] - vira `empresa_ativa` (FASE 5)
 * @param {Array<number|string>} [claims.escopo] - vira `escopo` (FASE 5)
 * @returns {string} JWT assinado (HS256)
 */
function generateHubPostgrestJWT(claims = {}) {
  const payload = { role: 'authenticated' };
  if (claims.usuarioId !== undefined && claims.usuarioId !== null) {
    payload.sub = String(claims.usuarioId);
  }
  if (claims.empresaAtiva !== undefined && claims.empresaAtiva !== null) {
    payload.empresa_ativa = claims.empresaAtiva;
  }
  if (claims.escopo !== undefined && claims.escopo !== null) {
    payload.escopo = claims.escopo;
  }

  const secret = process.env.PGRST_JWT_SECRET;
  if (!secret) {
    throw new Error('PGRST_JWT_SECRET ausente no ambiente do hub.');
  }

  // Decision 12 (owasp-security): pinagem de algoritmo mesmo na ASSINATURA —
  // não deixamos a lib escolher o default implicitamente.
  return jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn: '30m' });
}

module.exports = { generateHubPostgrestJWT };
