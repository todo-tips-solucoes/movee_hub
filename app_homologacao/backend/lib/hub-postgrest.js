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
 *   FASE 5 (hub-importacoes, tasks.md 5.1.1 — paginação Range PostgREST):
 *   @param {boolean} [opts.count] - quando `true`, adiciona
 *     `Prefer: count=exact` E MUDA O RETORNO da função para
 *     `{ data, total }` (`total` extraído do header `Content-Range`
 *     `<from>-<to>/<total>`). Aditivo: callers que NUNCA passam `opts.count`
 *     continuam recebendo só o corpo, como antes (nenhum caller existente
 *     quebra — grep confirma nenhum uso prévio de `opts.count`).
 *   @param {{from:number,to:number}} [opts.range] - vira os headers
 *     `Range-Unit: items` + `Range: <from>-<to>` (paginação PostgREST nativa,
 *     0-indexed, inclusive em ambas as pontas).
 *   F4 (pós-review PR #57, F1.2) — watchdog do pipeline de importações:
 *   @param {AbortSignal} [opts.signal] - repassado direto a `fetch`; permite
 *     ao caller (lib/hub-import-processor.js) abortar uma chamada pendente
 *     depois de `TIMEOUT_IMPORTACAO_MS` em vez de deixá-la pendurada
 *     indefinidamente (o cenário que motivou o registro travado em
 *     `validating`/`processing` — ver cabeçalho de hub-import-processor.js).
 * @returns {Promise<any>} corpo JSON parseado (ou null em 204/corpo vazio);
 *   `{ data, total }` quando `opts.count` é `true`.
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
  if (opts && opts.count) {
    preferencias.push('count=exact');
  }
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    Prefer: preferencias.join(','),
    'Cache-Control': 'no-cache',
  };
  if (opts && opts.range) {
    headers['Range-Unit'] = 'items';
    headers.Range = `${opts.range.from}-${opts.range.to}`;
  }

  const response = await fetch(`${baseUrl}/${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
    ...(opts && opts.signal ? { signal: opts.signal } : {}),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    const err = new Error(`hub-postgrest: ${response.status} ${response.statusText} — ${errBody}`);
    err.status = response.status;
    err.body = errBody;
    throw err;
  }

  const contentRange = response.headers.get('content-range');
  const status = response.status;

  let data = null;
  if (status !== 204) {
    const text = await response.text();
    data = text ? JSON.parse(text) : null;
  }

  if (opts && opts.count) {
    // F9 (pós-review PR #57) — Content-Range ausente OU terminado em `*`
    // (PostgREST devolve `*` quando não consegue contar, ex.: query custosa
    // sob certas configs) NÃO pode virar `total: 0` — isso faz a paginação
    // "sumir" na UI (ex.: total=0 com `data.length>0` esconde linhas
    // reais). Fallback: `offset + data.length` (o mínimo comprovadamente
    // existente pelas linhas já retornadas) — nunca menor que o real.
    let total;
    let totalAproximado = false;
    const linhasRetornadas = Array.isArray(data) ? data.length : 0;
    const m = contentRange && contentRange.match(/\/(\d+|\*)$/);
    if (m && m[1] !== '*') {
      total = parseInt(m[1], 10);
    } else {
      totalAproximado = true;
      const offsetAtual = (opts.range && Number.isFinite(opts.range.from)) ? opts.range.from : 0;
      total = offsetAtual + linhasRetornadas;
    }
    if (totalAproximado && !hubPostgrestRequest._avisouContentRangeAusente) {
      hubPostgrestRequest._avisouContentRangeAusente = true;
      console.warn('[hub-postgrest] Content-Range ausente/`*` em resposta com count=exact — usando fallback offset+data.length (total pode estar subestimado se houver mais páginas além da atual).');
    }
    return { data, total };
  }

  return data;
}

module.exports = { hubPostgrestRequest };
