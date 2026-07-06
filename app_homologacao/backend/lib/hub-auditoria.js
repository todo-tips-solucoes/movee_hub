// hub-fundacoes — lib/hub-auditoria.js
//
// Helper único de escrita na trilha `Auditoria` (data-model.md §Auditoria,
// FR-023/FR-025). Concentra o scrub de dados sensíveis num só lugar para que
// NENHUMA rota precise lembrar de filtrar senha/hash/token manualmente
// (Decision 6 — reforço em duas camadas; esta é a camada de aplicação).
//
// Best-effort: uma falha ao gravar a auditoria (ex.: PostgREST momentaneamente
// fora) NUNCA derruba o fluxo principal (login/logout/etc. já concluíram sua
// própria escrita/decisão antes de chamar isto) — apenas loga o erro. A
// trilha é reforço de rastreabilidade, não uma trava de negócio.
'use strict';

const { hubPostgrestRequest } = require('./hub-postgrest');

// Chaves que NUNCA podem aparecer em `detalhes` (comparação por substring,
// case-insensitive) — FR-025.
const CHAVES_PROIBIDAS = [
  'senha',
  'password',
  'pass',
  'hash',
  'token',
  'secret',
  'segredo',
];

function scrubDetalhes(detalhes) {
  if (!detalhes || typeof detalhes !== 'object') return {};
  const out = {};
  for (const [chave, valor] of Object.entries(detalhes)) {
    const chaveLower = chave.toLowerCase();
    if (CHAVES_PROIBIDAS.some((proibida) => chaveLower.includes(proibida))) {
      continue; // nunca inclui — nem mascarado, simplesmente omitido
    }
    out[chave] = valor;
  }
  return out;
}

/**
 * Registra 1 linha em `Auditoria`. Nunca lança — falha é logada e engolida
 * (best-effort, ver cabeçalho do arquivo).
 *
 * @param {object} evento
 * @param {number|null} [evento.idEmpresa]
 * @param {number|null} [evento.usuarioId]
 * @param {string} evento.acao - ex.: login_sucesso|login_falha|logout|...
 * @param {string} evento.recurso - ex.: Usuario|SessaoRefresh
 * @param {number|string|null} [evento.recursoId]
 * @param {object} [evento.detalhes] - passa por scrubDetalhes antes de gravar
 * @param {string|null} [evento.ip]
 */
async function registrarAuditoria(evento) {
  const {
    idEmpresa = null,
    usuarioId = null,
    acao,
    recurso,
    recursoId = null,
    detalhes = {},
    ip = null,
  } = evento || {};

  if (!acao || !recurso) {
    console.error('[hub-auditoria] evento sem acao/recurso — ignorado:', { acao, recurso });
    return;
  }

  try {
    await hubPostgrestRequest('Auditoria', 'POST', {
      id_empresa: idEmpresa,
      usuario_id: usuarioId,
      acao,
      recurso,
      recurso_id: recursoId !== null && recursoId !== undefined ? String(recursoId) : null,
      detalhes: scrubDetalhes(detalhes),
      ip,
    });
  } catch (e) {
    // best-effort — nunca interrompe o fluxo chamador (ver cabeçalho)
    console.error('[hub-auditoria] falha ao registrar evento (nao bloqueia o fluxo):', acao, e.message);
  }
}

module.exports = { registrarAuditoria, scrubDetalhes };
