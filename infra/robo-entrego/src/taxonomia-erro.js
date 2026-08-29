// taxonomia-erro.js (tasks.md FASE 3, 3.1.1) — classificação de sinais em
// função pura, direto da tabela de research.md Decision 11 (docs/specs/
// robo-entrego/research.md). Nenhum I/O, nenhum estado — sinal -> classificação.
'use strict';

/** Classificações possíveis (research.md Decision 11, coluna "Classificação"). */
const CLASSIFICACAO = Object.freeze({
  TRANSITORIO: 'transitorio',
  NAO_E_FALHA: 'nao_e_falha',
  SUSPEITA_ANTIBOT: 'suspeita_antibot',
  SUCESSO: 'sucesso',
  SUCESSO_IDEMPOTENTE: 'sucesso_idempotente',
  FALHA_HUB: 'falha_hub',
  // O portal respondeu certo, mas o movimento do dia ainda não foi publicado.
  // NÃO é falha (nada quebrou) e NÃO é sucesso (não há o que importar): é
  // "tente de novo mais tarde". Antes disto, um relatório vazio virava
  // `TypeError: Cannot read properties of undefined` — mensagem que não diz
  // nada — ou, pior, uma importação de 0 linhas marcada como completed.
  SEM_DADOS: 'sem_dados',
});

// Mapa 1:1 com as linhas de research.md Decision 11 — cada chave é um sinal
// discreto que os módulos de FASE 3/4 (hub-client.js, entrego-portal.js)
// produzem ao observar rede/portal/hub.
const TABELA_SINAIS = Object.freeze({
  // "Timeout de rede, erro de conexão, 5xx do portal ou do hub" -> Transitório
  timeout_rede: CLASSIFICACAO.TRANSITORIO,
  erro_conexao: CLASSIFICACAO.TRANSITORIO,
  http_5xx_portal: CLASSIFICACAO.TRANSITORIO,
  http_5xx_hub: CLASSIFICACAO.TRANSITORIO,
  // "401 na chamada de sessão salva do EntreGô" -> Não é falha (login completo)
  sessao_expirada_401: CLASSIFICACAO.NAO_E_FALHA,
  // "Resposta estruturalmente diferente da mapeada em ACHADOS-PORTAL.md" -> Suspeita anti-bot
  schema_inesperado: CLASSIFICACAO.SUSPEITA_ANTIBOT,
  // "201 do POST /api/v1/importacoes" -> Sucesso (aceito, ainda pending)
  upload_201: CLASSIFICACAO.SUCESSO,
  // "409 CONFLITO do POST /api/v1/importacoes" -> Sucesso idempotente
  upload_409: CLASSIFICACAO.SUCESSO_IDEMPOTENTE,
  // "422 INVALIDO, ou status terminal failed/completed_with_errors" -> Falha do hub
  // Relatório ainda não publicado pelo portal (lista de urls vazia, ou CSV só
  // com cabeçalho). Retentável na próxima janela do dia — ver config.json.
  relatorio_sem_dados: CLASSIFICACAO.SEM_DADOS,
  upload_422: CLASSIFICACAO.FALHA_HUB,
  polling_failed: CLASSIFICACAO.FALHA_HUB,
  polling_completed_with_errors: CLASSIFICACAO.FALHA_HUB,
  // status terminal "completed" do polling (contracts/hub-api.md) -> Sucesso
  // (extensão direta da mesma linha "201" da tabela — completed é o desfecho
  // final de sucesso do mesmo fluxo; não é uma linha textual separada em
  // research.md Decision 11, mas a classificação segue idêntica).
  polling_completed: CLASSIFICACAO.SUCESSO,
});

/**
 * Classifica um sinal discreto (ver chaves de TABELA_SINAIS) na sua
 * classificação da taxonomia (research.md Decision 11).
 * @param {string} sinal
 * @returns {string} uma das CLASSIFICACAO.*
 * @throws {Error} sinal desconhecido — nunca classifica silenciosamente errado
 */
function classificarSinal(sinal) {
  if (!Object.prototype.hasOwnProperty.call(TABELA_SINAIS, sinal)) {
    throw new Error(`taxonomia-erro: sinal desconhecido "${sinal}"`);
  }
  return TABELA_SINAIS[sinal];
}

/**
 * Última linha de research.md Decision 11: "Esgotadas as 3 tentativas
 * transitórias, OU suspeita de anti-bot confirmada, OU falha estrutural do
 * hub sem retry aplicável" -> Falha definitiva da rodada (dispara as 3
 * reações de FR-013).
 * @param {object} estado
 * @param {boolean} [estado.tentativasEsgotadas]
 * @param {boolean} [estado.suspeitaAntibotConfirmada]
 * @param {boolean} [estado.falhaHubSemRetry]
 * @returns {boolean}
 */
function ehFalhaDefinitiva({ tentativasEsgotadas, suspeitaAntibotConfirmada, falhaHubSemRetry } = {}) {
  return Boolean(tentativasEsgotadas || suspeitaAntibotConfirmada || falhaHubSemRetry);
}

module.exports = { CLASSIFICACAO, classificarSinal, ehFalhaDefinitiva };
