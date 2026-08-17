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

// hub-auditoria-admin FASE 2.3 (CHK006/SC-006) — checagem por PADRÃO no
// VALOR, camada ADITIVA ao filtro por NOME de chave acima. Gap real que
// motivou esta camada: um campo com nome inócuo (ex.: `observacao`,
// `linha_bruta`, `detalhe_erro`) pode carregar, em texto livre, um CPF/CNPJ/
// e-mail que o filtro por chave nunca pegaria. Padrões aceitam com e sem
// formatação (pontuação opcional via `?`).
const REGEX_CPF = /\d{3}\.?\d{3}\.?\d{3}-?\d{2}/;
const REGEX_CNPJ = /\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/;
const REGEX_EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/**
 * Confirma se um VALOR (string) contém CPF, CNPJ ou e-mail em texto livre.
 * Só inspeciona valores string — `detalhes` de auditoria é sempre um objeto
 * raso (chave -> valor primitivo), nenhum ponto de escrita atual usa objeto/
 * array aninhado como valor (mesmo padrão dos callers existentes de
 * `registrarAuditoria`); array/objeto aninhado passa sem checagem por esta
 * função (limitação documentada — decisão de escopo desta FASE, ver Decisão
 * "mecanismo SC-006" registrada no state.json do feature-00c).
 * @param {*} valor
 * @returns {boolean}
 */
function valorContemPadraoSensivel(valor) {
  if (typeof valor !== 'string') return false;
  return REGEX_CPF.test(valor) || REGEX_CNPJ.test(valor) || REGEX_EMAIL.test(valor);
}

/**
 * scrubDetalhes: 2 camadas aditivas (2.3.3 — a camada por VALOR NÃO
 * substitui, apenas soma-se à camada por NOME de chave já existente):
 *   1. NOME da chave contém termo de `CHAVES_PROIBIDAS` -> omitido (FR-025).
 *   2. VALOR (string) casa CPF/CNPJ/e-mail -> omitido (CHK006/SC-006).
 * Em AMBOS os casos o comportamento é IDÊNTICO e MUST: o campo é OMITIDO por
 * completo, nunca mascarado/redigido parcialmente nem apenas logado como
 * aviso (2.3.2) — omitir é a única forma de garantir 0% de exposição
 * (SC-006) sem risco de uma máscara mal-calibrada vazar parte do dado.
 *
 * Decisão de escopo (2.3.2, registrada como Decisão auditável no
 * orquestrador feature-00c): a checagem por VALOR se aplica a QUALQUER
 * chave, INCLUSIVE chaves cujo propósito legítimo é carregar um e-mail
 * (ex.: `email` num evento `usuario_criado`). Diverge da leitura anterior
 * (que preservava a chave `email` como contexto legítimo do evento, ver
 * teste unitário histórico) porque SC-006 exige 0% de exposição verificado
 * por checagem automatizada — aceitar a chave "email" como exceção
 * reabriria exatamente o gap que motivou o CHK006 (checagem por padrão no
 * valor, não por nome da chave). Efeito colateral aceito: eventos como
 * `usuario_criado` deixam de exibir o e-mail em `detalhes`; a
 * rastreabilidade do RECURSO afetado permanece garantida por
 * `recurso`/`recursoId` (FR-006), que não passam por `scrubDetalhes`.
 */
function scrubDetalhes(detalhes) {
  if (!detalhes || typeof detalhes !== 'object') return {};
  const out = {};
  for (const [chave, valor] of Object.entries(detalhes)) {
    const chaveLower = chave.toLowerCase();
    if (CHAVES_PROIBIDAS.some((proibida) => chaveLower.includes(proibida))) {
      continue; // nunca inclui — nem mascarado, simplesmente omitido
    }
    if (valorContemPadraoSensivel(valor)) {
      continue; // CHK006/SC-006 — padrão sensível no VALOR, omitido (nunca só logado)
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
 * @param {object} [evento.claims] - repassado a hubPostgrestRequest (FASE 5,
 *   0006_rls_policies.sql). A policy de INSERT em Auditoria libera linhas com
 *   `id_empresa IS NULL` (eventos globais: login/logout/recuperação — sem
 *   entidade ainda escolhida) incondicionalmente; quando `idEmpresa` é
 *   informado (ex.: troca_entidade_ativa), o caller MUST passar
 *   `claims: { usuarioId, empresaAtiva: idEmpresa, escopo: [idEmpresa] }` —
 *   caso contrário o INSERT é negado pela policy (nega-por-padrão, FR-028).
 */
/**
 * Marcador estável para a perda de um evento. Existe para ser grepado e
 * alertado: `docker logs ... | grep AUDITORIA_PERDIDA`. NÃO mudar o texto sem
 * atualizar quem alerta em cima dele.
 */
const MARCADOR_PERDA = 'AUDITORIA_PERDIDA';

/**
 * Contagem de perdas desde que o processo subiu. Em memória de propósito:
 * persistir isso exigiria... escrever no banco, que é justamente o que acabou
 * de falhar. Serve para responder "está perdendo agora?" e "perdeu quanto?"
 * sem depender de agregar log.
 */
const perdas = { total: 0, porAcao: new Map(), primeira: null, ultima: null };

/** Fotografia das perdas — para diagnóstico e para o teste desta política. */
function estatisticasAuditoria() {
  return {
    total: perdas.total,
    porAcao: Object.fromEntries(perdas.porAcao),
    primeira: perdas.primeira,
    ultima: perdas.ultima,
  };
}

/** Só para teste: zera o contador entre casos. */
function _zerarEstatisticasAuditoria() {
  perdas.total = 0;
  perdas.porAcao = new Map();
  perdas.primeira = null;
  perdas.ultima = null;
}

const ESPERA_RETRY_MS = 120;

async function registrarAuditoria(evento) {
  const {
    idEmpresa = null,
    usuarioId = null,
    acao,
    recurso,
    recursoId = null,
    detalhes = {},
    ip = null,
    claims = {},
  } = evento || {};

  if (!acao || !recurso) {
    console.error('[hub-auditoria] evento sem acao/recurso — ignorado:', { acao, recurso });
    return { ok: false, erro: 'EVENTO_INVALIDO' };
  }

  try {
    // FASE 6 (achado E2E, dec-070): `return=representation` (default de
    // hubPostgrestRequest) faz o PostgREST reavaliar a policy FOR SELECT
    // sobre a linha recém-inserida para poder devolvê-la no RETURNING — não
    // basta satisfazer o WITH CHECK do INSERT. Desde a migration 0035
    // (auditoria_select_por_escopo passou a exigir `id_empresa IS NOT NULL
    // AND id_empresa=ANY(escopo)` para quem não tem a claim
    // admin_plataforma), TODO evento global (`id_empresa IS NULL` — login_
    // sucesso/login_falha/logout/recuperacao_senha_solicitada/
    // senha_redefinida, tasks.md 6.1) passou a falhar com "42501 new row
    // violates row-level security policy" na hora do RETURNING, mesmo o
    // INSERT em si sendo permitido pelo WITH CHECK (0009) — silenciado pelo
    // catch best-effort abaixo, sem nenhum caller notar. Nenhum código
    // consome o retorno de `registrarAuditoria` (best-effort, ver cabeçalho
    // do arquivo) — `returnMinimal` evita o RETURNING por completo, sem
    // qualquer mudança de postura de RLS/visibilidade (SELECT continua
    // negando evento global para quem não é admin_plataforma).
    await gravarComRetry({
      id_empresa: idEmpresa,
      usuario_id: usuarioId,
      acao,
      recurso,
      recurso_id: recursoId !== null && recursoId !== undefined ? String(recursoId) : null,
      detalhes: scrubDetalhes(detalhes),
      ip,
    }, claims);
    return { ok: true };
  } catch (e) {
    // SEGUE best-effort: 38 chamadores em 9 rotas, incluindo `login_falha` e
    // `login_sucesso`. Falhar fechado faria uma indisponibilidade da auditoria
    // derrubar o LOGIN do produto inteiro — trocar perda de trilha por perda de
    // acesso é um negócio pior.
    //
    // O que mudou é que a perda deixou de ser SILENCIOSA. O `catch` anterior
    // escondeu um defeito sistêmico real: desde a migration 0035, TODO evento
    // global (login_sucesso/login_falha/logout/recuperacao_senha_solicitada/
    // senha_redefinida) falhava com 42501 no RETURNING, e ninguém percebeu até
    // um E2E tropeçar — está documentado algumas linhas acima, no comentário
    // do `returnMinimal`. Um marcador grepável e um contador transformam meses
    // de silêncio em uma linha de log e um número.
    perdas.total += 1;
    perdas.porAcao.set(acao, (perdas.porAcao.get(acao) || 0) + 1);
    const agora = new Date().toISOString();
    if (!perdas.primeira) perdas.primeira = agora;
    perdas.ultima = agora;

    console.error(
      `[hub-auditoria] ${MARCADOR_PERDA} evento não registrado (fluxo NÃO bloqueado)`,
      JSON.stringify({
        marcador: MARCADOR_PERDA,
        acao,
        recurso,
        recursoId: recursoId !== null && recursoId !== undefined ? String(recursoId) : null,
        idEmpresa,
        usuarioId,
        erro: e.message,
        perdasNoProcesso: perdas.total,
      })
    );
    return { ok: false, erro: e.message };
  }
}

/**
 * Uma tentativa, e mais uma. A causa mais comum de perda é oscilação de rede
 * ou do PostgREST — um retry curto recupera isso sem sustentar a requisição do
 * usuário por muito tempo. Falha de POLÍTICA (RLS) não melhora com retry, e é
 * por isso que ele é único: insistir mais seria só atrasar a resposta.
 */
async function gravarComRetry(linha, claims) {
  try {
    await hubPostgrestRequest('Auditoria', 'POST', linha, claims, { returnMinimal: true });
  } catch (primeiraFalha) {
    await new Promise((r) => setTimeout(r, ESPERA_RETRY_MS));
    try {
      await hubPostgrestRequest('Auditoria', 'POST', linha, claims, { returnMinimal: true });
    } catch {
      // Propaga a PRIMEIRA falha: é a que descreve a causa original. A segunda
      // costuma ser a mesma coisa, e trocar uma pela outra confunde quem lê.
      throw primeiraFalha;
    }
  }
}

module.exports = {
  registrarAuditoria,
  scrubDetalhes,
  valorContemPadraoSensivel,
  estatisticasAuditoria,
  MARCADOR_PERDA,
  _zerarEstatisticasAuditoria,
};
