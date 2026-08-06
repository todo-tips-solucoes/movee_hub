/**
 * hub-access-token.js — decodificação do `accessToken` do hub (JWT em cookie
 * httpOnly). Fonte única da verdade.
 *
 * Extraído de 8 cópias idênticas em `routes/hub-*.js` mais 2 variantes inline
 * em `middleware/hub-require-permission.js` e `middleware/hub-require-modulo.js`.
 * A duplicação era um risco concreto: a pinagem de algoritmo (`algorithms:
 * ['HS256']` — Decision 12 / owasp-security, obrigatória em TODO `jwt.verify`
 * do hub) precisava ser mantida em 10 lugares, e um único esquecido reabriria
 * a aceitação de `alg: none`.
 *
 * Módulo PURO (sem I/O, sem express): token → payload | null.
 *
 * Nomes de cookie: o hub usa `hub_accessToken`/`hub_refreshToken`. Até 2026-08-04
 * usava `accessToken`/`refreshToken` — os MESMOS nomes do painel legado, no mesmo
 * domínio (`app.moveelog.com.br`) e sem `path`. Logar num produto sobrescrevia a
 * sessão do outro, e o `authenticateToken` do legado (mesmo `JWT_SECRET`) aceitava
 * o token do hub, produzindo `req.user.empresaId === undefined` mundo afora.
 */

'use strict';

const jwt = require('jsonwebtoken');

/** Nome do cookie de access token do hub — NÃO colide com o do painel legado. */
const COOKIE_ACCESS = 'hub_accessToken';
/** Nome do cookie de refresh token do hub. */
const COOKIE_REFRESH = 'hub_refreshToken';

/** Lê o access token do hub de um request express. */
function lerAccessTokenDoRequest(req) {
  return (req && req.cookies && req.cookies[COOKIE_ACCESS]) || null;
}

/** Lê o refresh token do hub de um request express. */
function lerRefreshTokenDoRequest(req) {
  return (req && req.cookies && req.cookies[COOKIE_REFRESH]) || null;
}

/**
 * Verifica e decodifica o `accessToken`. Devolve o payload, ou `null` quando o
 * token está ausente, expirado, malformado, assinado com outra chave ou com
 * algoritmo fora da pinagem. NUNCA lança — todos os call sites tratam `null`
 * como "não autenticado".
 */
function decodificarAccessToken(accessToken) {
  if (!accessToken) return null;
  try {
    // Pinagem de algoritmo obrigatória (owasp-security) em TODO jwt.verify do hub.
    return jwt.verify(accessToken, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (_e) {
    return null;
  }
}

module.exports = {
  decodificarAccessToken,
  lerAccessTokenDoRequest,
  lerRefreshTokenDoRequest,
  COOKIE_ACCESS,
  COOKIE_REFRESH,
};
