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
// FASE 3 (autenticação) só precisava do papel `authenticated` sem claims de
// escopo. A partir da FASE 5 (0006_rls_policies.sql), os callers que tocam
// tabelas cobertas por RLS (UsuarioEntidade/ModuloEntidade/Auditoria) MUST
// passar claims reais — ver lib/hub-rbac-cache.js, lib/hub-auditoria.js e
// routes/hub-me.js. Os parâmetros continuam opcionais aqui (não todo caller
// precisa de todos: UsuarioEntidade é escopado por `sub`, ModuloEntidade e
// Auditoria por `escopo`/`empresa_ativa` — ver research.md Decision 3/4 e
// infra/hub/migrations/0006_rls_policies.sql).
'use strict';

const jwt = require('jsonwebtoken');

/**
 * Gera um JWT do PostgREST do hub, por request.
 * @param {object} [claims]
 * @param {number|string} [claims.usuarioId] - vira `sub` (FASE 3+)
 * @param {number|string} [claims.empresaAtiva] - vira `empresa_ativa` (FASE 5)
 * @param {Array<number|string>} [claims.escopo] - vira `escopo` (FASE 5)
 * @param {boolean} [claims.hubBootRecovery] - vira `hub_boot_recovery`
 *   (pós-review PR #57, F1.3) — claim INTERNA emitida SÓ por
 *   `lib/hub-import-processor.js#recuperarImportacoesOrfas` (job de boot,
 *   nunca por uma rota que atende requisição de usuário). Habilita a
 *   policy `importacaoarquivo_update_recuperacao_orfa` (migration 0018),
 *   que permite APENAS a transição `validating`/`processing` -> `failed`
 *   em `ImportacaoArquivo`, cruzando tenants — necessário para destravar o
 *   mutex (índice único parcial, migration 0011) depois de um restart no
 *   meio do processamento. NÃO é um bypass geral de RLS: a policy não
 *   libera SELECT nem qualquer outra transição de status.
 * @param {boolean} [claims.origemImportacao] - vira `origem_importacao`
 *   (S5/hub-motoristas, tasks.md 8.2.4, block-004/dec-048) — claim INTERNA
 *   emitida SÓ por `lib/hub-import-processor.js#upsertEntregadoresDoLote`
 *   (pipeline de reimportação S4, nunca pelo PATCH manual de
 *   routes/hub-motoristas.js). Usada pelo trigger
 *   `trg_entregador_protege_nome` (migration 0019/0025,
 *   `hub_jwt_origem_importacao()`) para distinguir: reimportação S4 NUNCA
 *   sobrescreve um nome já editado manualmente; PATCH manual do operador
 *   (sem esta claim) sempre pode reeditar o nome, mesmo repetidamente.
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
  if (claims.hubBootRecovery === true) {
    payload.hub_boot_recovery = true;
  }
  if (claims.origemImportacao === true) {
    payload.origem_importacao = true;
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
