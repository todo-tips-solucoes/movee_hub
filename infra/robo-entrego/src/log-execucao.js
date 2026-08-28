// log-execucao.js (tasks.md FASE 3, 3.1.2) — escrita JSON Lines append-only
// da entidade "Execução Agendada" (docs/specs/robo-entrego/data-model.md).
// 1 linha `inicio` ao começar + 1 linha `fim` (mesmo execucao_id) ao
// terminar — nunca UPDATE in-place (Nota append-only do data-model.md).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** Caminho padrão (data-model.md §Entity: Execução Agendada). */
const LOG_PATH_DEFAULT = '/var/lib/hub_secrets/robo-entrego/log/execucoes.jsonl';

const RESULTADOS_VALIDOS = ['sucesso', 'falha_parcial', 'falha_total', 'pulado_lock'];

// Allowlist (3.1.4) — nunca campos de credencial. `url_s3` é tratado como
// sensível por design (data-model.md: URL pré-assinada = bearer token de
// curta duração para o objeto) e por isso NUNCA entra no log, mesmo sendo um
// campo legítimo de "Relatório do Franqueado".
const CAMPOS_RELATORIO_PERMITIDOS = Object.freeze([
  'tipo_portal',
  'tipo_hub',
  'data_referencia',
  'sha256',
  'importacao_id',
  'status_hub',
  'tentativas',
]);

/** Filtra um objeto "Relatório do Franqueado" pela allowlist antes de logar. */
function filtrarRelatorio(relatorio) {
  const out = {};
  if (!relatorio || typeof relatorio !== 'object') return out;
  for (const campo of CAMPOS_RELATORIO_PERMITIDOS) {
    if (Object.prototype.hasOwnProperty.call(relatorio, campo)) out[campo] = relatorio[campo];
  }
  return out;
}

function escreverLinha(caminho, objeto) {
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  fs.appendFileSync(caminho, `${JSON.stringify(objeto)}\n`, { mode: 0o600 });
}

/**
 * Escreve a linha `inicio` de uma nova execução.
 * @param {object} [opts]
 * @param {string} [opts.caminhoLog] override para teste (nunca aponta pro
 *   /var/lib/hub_secrets real fora de produção)
 * @returns {{execucaoId: string, disparadoEm: string}}
 */
function iniciarExecucao({ caminhoLog = LOG_PATH_DEFAULT } = {}) {
  const execucaoId = crypto.randomUUID();
  const disparadoEm = new Date().toISOString();
  escreverLinha(caminhoLog, { linha: 'inicio', execucao_id: execucaoId, disparado_em: disparadoEm });
  return { execucaoId, disparadoEm };
}

/**
 * Escreve a linha `fim` correspondente (mesmo execucao_id).
 * @param {object} opts
 * @param {string} opts.execucaoId
 * @param {'sucesso'|'falha_parcial'|'falha_total'|'pulado_lock'} opts.resultado
 * @param {object[]} [opts.relatorios] - filtrado pela allowlist antes de logar
 * @param {number} [opts.tentativasTotais]
 * @param {string|null} [opts.motivoFalha]
 * @param {string} [opts.caminhoLog]
 * @returns {object} a linha escrita
 */
function finalizarExecucao({
  execucaoId,
  resultado,
  relatorios = [],
  tentativasTotais = 0,
  motivoFalha = null,
  caminhoLog = LOG_PATH_DEFAULT,
}) {
  if (!execucaoId) throw new Error('log-execucao: execucaoId obrigatório');
  if (!RESULTADOS_VALIDOS.includes(resultado)) {
    throw new Error(`log-execucao: resultado inválido "${resultado}" (válidos: ${RESULTADOS_VALIDOS.join(', ')})`);
  }
  const linha = {
    linha: 'fim',
    execucao_id: execucaoId,
    concluido_em: new Date().toISOString(),
    resultado,
    relatorios: relatorios.map(filtrarRelatorio),
    tentativas_totais: tentativasTotais,
    motivo_falha: motivoFalha,
  };
  escreverLinha(caminhoLog, linha);
  return linha;
}

module.exports = {
  iniciarExecucao,
  finalizarExecucao,
  filtrarRelatorio,
  LOG_PATH_DEFAULT,
  CAMPOS_RELATORIO_PERMITIDOS,
  RESULTADOS_VALIDOS,
};
