// hub-fundacoes (FASE 3) — lib/hub-postgrest.js
//
// Helper genérico de acesso ao PostgREST do hub, compartilhado por
// routes/hub-auth.js (FASE 3), routes/hub-me.js e lib/hub-auditoria.js
// (FASE 4+). Espelha o padrão já usado por `postgrestRequest()` em
// server.js:116-154 (mesma forma de erro, mesmos headers), mas:
//   (a) usa `generateHubPostgrestJWT()` (lib/hub-postgrest-jwt.js) em vez de
//       `generatePostgrestJWT()` legada — token por request, isolado do hub;
//   (b) usa `fetch` global do Node 20 (Dockerfile.hub) em vez de `node-fetch`
//       — `node-fetch` é dependência TRANSITIVA (não declarada em
//       package.json), inadequada para código novo; o runtime do hub é
//       Node 20 LTS, que já expõe `fetch` nativo (sem nova dependência).
//
// NÃO edita `postgrestRequest()` legada — arquivo 100% novo (Decision 2).
'use strict';

const { generateHubPostgrestJWT } = require('./hub-postgrest-jwt');

/**
 * @param {string} endpoint - caminho relativo (ex.: `Usuario?email=eq.foo%40x.com`)
 * @param {string} [method]
 * @param {object|null} [body]
 * @param {object} [claims] - repassado a generateHubPostgrestJWT (FASE 5)
 * @param {object} [opts] - FASE 4 (hub-importacoes) — extensão ADITIVA,
 *   100% opcional, sem quebrar nenhum caller existente (padrão `{}`):
 *   @param {string} [opts.resolution] - vira `Prefer: resolution=<...>`
 *     (`merge-duplicates` para upsert de `Entregador` — research.md
 *     Decision 9; `ignore-duplicates` para `ON CONFLICT ... DO NOTHING` no
 *     bulk insert de fatos — Decision 6). Combina-se com `on_conflict=...`
 *     na query string do `endpoint` (convenção do próprio PostgREST).
 *   @param {boolean} [opts.returnMinimal] - troca `return=representation`
 *     por `return=minimal` (corpo de resposta vazio) quando o caller não
 *     precisa das linhas afetadas de volta.
 * @returns {Promise<any>} corpo JSON parseado (ou null em 204/corpo vazio)
 */
async function hubPostgrestRequest(endpoint, method = 'GET', body = null, claims = {}, opts = {}) {
  const baseUrl = process.env.POSTGREST_URL;
  if (!baseUrl) {
    throw new Error('POSTGREST_URL ausente no ambiente do hub.');
  }

  const token = generateHubPostgrestJWT(claims);
  const preferencias = [opts && opts.returnMinimal ? 'return=minimal' : 'return=representation'];
  if (opts && opts.resolution) {
    preferencias.push(`resolution=${opts.resolution}`);
  }
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    Prefer: preferencias.join(','),
    'Cache-Control': 'no-cache',
  };

  const response = await fetch(`${baseUrl}/${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    const err = new Error(`hub-postgrest: ${response.status} ${response.statusText} — ${errBody}`);
    err.status = response.status;
    err.body = errBody;
    throw err;
  }

  if (response.status === 204) return null;

  const text = await response.text();
  if (!text) return null;
  return JSON.parse(text);
}

module.exports = { hubPostgrestRequest };
