// hub-envio-massa-import-log.js — histórico leve de importação do módulo
// envio-massa (S8, FASE 4). Ref: contracts/claims-adapter.md "Contrato de
// log de importação"; research.md Decision 9; tasks.md 4.1.
//
// GRAVA SEMPRE em estado terminal (completed/completed_with_errors/failed),
// NUNCA em pending/validating/processing — ver research.md Decision 9 para o
// motivo (índice único parcial `importacaoarquivo_uma_ativa_por_tipo`
// rejeitaria uma 2ª importação concorrente da mesma empresa se o log
// reproduzisse o ciclo de vida pending->validating->processing do pipeline
// de importações em lote da S4; o upload de envio-massa é síncrono, não há
// "processamento em background" a rastrear).
//
// Best-effort, fire-and-forget (FR-011): NUNCA lança. Qualquer falha (hash,
// rede, INSERT — inclusive 409 de UNIQUE(id_empresa,tipo,hash_sha256) em
// reenvio idêntico) só loga via console.error e retorna, sem afetar a
// resposta HTTP do handler chamador.
//
// Guards de sessão (`req.hubContext.viaHub === true`) e de flag
// (`HUB_IMPORT_LOG_ENVIO`) — este último é checado NESTE helper (retorno
// silencioso, FR-010); o guard de sessão é responsabilidade do CALL SITE
// (contracts/claims-adapter.md — sessão legada não tem `criado_por` válido
// nem faz sentido aparecer no histórico do hub que ela não acessa).

'use strict';

const crypto = require('node:crypto');
const { hubPostgrestRequest } = require('./hub-postgrest');

/**
 * Deriva o status terminal a partir da contagem de linhas (research.md
 * Decision 9 / tasks.md 4.1.7): 100% válidas -> `completed`; parse concluiu
 * mas alguma linha (parcial ou total) é inválida -> `completed_with_errors`;
 * parse nem chegou a contar linhas (arquivo ilegível, planilha sem abas ou
 * vazia) -> `failed`.
 *
 * @param {number|null|undefined} totalLinhas
 * @param {number|null|undefined} linhasInvalidas
 * @returns {'completed'|'completed_with_errors'|'failed'}
 */
function derivarStatusImportacao(totalLinhas, linhasInvalidas) {
  if (!Number.isFinite(totalLinhas) || totalLinhas <= 0) return 'failed';
  if (!linhasInvalidas || linhasInvalidas <= 0) return 'completed';
  return 'completed_with_errors';
}

/**
 * Registra 1 linha de histórico de importação do envio-massa em
 * `ImportacaoArquivo` (tipo='envio_massa'), sempre em estado terminal.
 * Fire-and-forget: NUNCA lança, NUNCA bloqueia o handler chamador.
 *
 * @param {object} params
 * @param {number} params.empresaId - `req.user.empresaId` (pós-adaptador)
 * @param {number} params.usuarioId - `req.hubContext.usuarioId`
 * @param {string} [params.nomeArquivo] - `req.file.originalname`
 * @param {Buffer|null} [params.arquivo] - bytes do arquivo recebido (sha256
 *   do arquivo, não do conteúdo já extraído — mesmo critério de
 *   `routes/hub-importacoes.js`)
 * @param {number|null} [params.totalLinhas]
 * @param {number} [params.linhasValidas]
 * @param {number} [params.linhasInvalidas]
 * @param {string} [params.status] - se omitido, derivado via
 *   `derivarStatusImportacao(totalLinhas, linhasInvalidas)`
 * @returns {Promise<void>}
 */
async function registrarImportacaoEnvioMassa(params) {
  const {
    empresaId,
    usuarioId,
    nomeArquivo,
    arquivo,
    totalLinhas = null,
    linhasValidas = 0,
    linhasInvalidas = 0,
    status,
  } = params || {};

  if (process.env.HUB_IMPORT_LOG_ENVIO === 'off') {
    return;
  }

  try {
    const bufferParaHash = Buffer.isBuffer(arquivo) ? arquivo : Buffer.alloc(0);
    const hashSha256 = crypto.createHash('sha256').update(bufferParaHash).digest('hex');
    const statusFinal = status || derivarStatusImportacao(totalLinhas, linhasInvalidas);
    const claims = { usuarioId, empresaAtiva: empresaId, escopo: [empresaId] };

    await hubPostgrestRequest(
      'ImportacaoArquivo',
      'POST',
      {
        id_empresa: empresaId,
        tipo: 'envio_massa',
        nome_arquivo: nomeArquivo || null,
        hash_sha256: hashSha256,
        tamanho_bytes: Buffer.isBuffer(arquivo) ? arquivo.length : null,
        status: statusFinal,
        total_linhas: totalLinhas,
        linhas_validas: linhasValidas,
        linhas_invalidas: linhasInvalidas,
        criado_por: usuarioId,
      },
      claims,
      { returnMinimal: true }
    );
  } catch (err) {
    // FR-011: best-effort, nunca propaga. Cobre inclusive 409 de
    // UNIQUE(id_empresa,tipo,hash_sha256) em reenvio do mesmo arquivo —
    // skip silencioso é o comportamento aceitável aqui (não é uma API com
    // contrato de dedupe explícito como hub-importacoes.js).
    console.error(
      '[hub-envio-massa-import-log] falha ao registrar histórico de importação (best-effort, não propagada):',
      err && err.message
    );
  }
}

module.exports = { registrarImportacaoEnvioMassa, derivarStatusImportacao };
