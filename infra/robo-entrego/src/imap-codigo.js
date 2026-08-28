// imap-codigo.js (tasks.md FASE 3, 3.2) — leitura do código de 2FA via IMAP.
// Ref: research.md Decision 4 (+ hardening owasp-security).
//
// Este módulo NUNCA gerencia o ciclo de vida da conexão IMAP (connect/
// logout) — recebe um `client` ImapFlow já conectado (injeção de
// dependência), o que também o torna testável com um mock sem servidor IMAP
// real. Contrato real da lib (node_modules/imapflow/lib/imap-flow.d.ts):
// `search(query, {uid:true}) -> number[]|false`,
// `fetchOne(uid, query, {uid:true}) -> FetchMessageObject|false`.
'use strict';

/** Assunto exato observado no portal (ACHADOS-PORTAL.md §3, passo 3). */
const ASSUNTO_ESPERADO = 'Código de Acesso';

// Extração (localizar candidato) e validação (aceitar/rejeitar) são
// deliberadamente 2 regex distintas (research.md Decision 4, hardening):
// localizar um token de 6 dígitos isolado por fronteira de palavra no corpo
// do e-mail, depois validar esse candidato contra o formato ESTRITO exigido
// pela spec antes de aceitar. Nunca repassa texto livre do corpo para o
// formulário do portal.
const REGEX_CODIGO_CANDIDATO = /\b(\d{6})\b/;
const REGEX_CODIGO_ESTRITO = /^\d{6}$/;

/**
 * Extrai e valida um código de 6 dígitos de um texto livre (assunto+corpo).
 * @param {string} texto
 * @returns {string|null} o código, ou null se não encontrado/inválido
 */
function extrairCodigo(texto) {
  if (typeof texto !== 'string') return null;
  const match = REGEX_CODIGO_CANDIDATO.exec(texto);
  if (!match) return null;
  const candidato = match[1];
  return REGEX_CODIGO_ESTRITO.test(candidato) ? candidato : null;
}

/**
 * Lê o código de acesso (2FA) recebido por e-mail após `aposTimestamp`.
 * @param {object} client - instância ImapFlow já conectada (o caller decide
 *   connect()/logout(); este módulo só abre o mailbox e lê)
 * @param {Date} aposTimestamp - timestamp do disparo de
 *   `POST authentication/validate` (ACHADOS-PORTAL.md §3, passo 2)
 * @param {object} [opts]
 * @param {string} [opts.mailbox] default 'INBOX'
 * @param {string} [opts.assunto] default ASSUNTO_ESPERADO
 * @returns {Promise<string>} o código de 6 dígitos
 * @throws {Error} nenhuma mensagem válida encontrada após o timestamp, ou
 *   mensagem mais recente sem código no formato esperado
 */
async function lerCodigoAcesso(client, aposTimestamp, { mailbox = 'INBOX', assunto = ASSUNTO_ESPERADO } = {}) {
  if (!(aposTimestamp instanceof Date) || Number.isNaN(aposTimestamp.getTime())) {
    throw new Error('imap-codigo: aposTimestamp inválido (esperado instância de Date)');
  }

  // Modo read-only (\Peek do protocolo) — hardening owasp-security: a
  // credencial dá acesso à caixa inteira; nunca marcar como lida, mover ou
  // deletar (least privilege de COMPORTAMENTO mesmo com escopo amplo).
  const lock = await client.getMailboxLock(mailbox, { readOnly: true });
  try {
    // SINCE do protocolo IMAP só tem granularidade de DIA — o filtro fino
    // por timestamp exato (abaixo) é feito client-side por envelope.date,
    // nunca confiado só ao SEARCH do servidor.
    const uids = await client.search({ subject: assunto, since: aposTimestamp }, { uid: true });
    if (!uids || uids.length === 0) {
      throw new Error(`imap-codigo: nenhuma mensagem encontrada com assunto "${assunto}"`);
    }

    const candidatos = [];
    for (const uid of uids) {
      const msg = await client.fetchOne(uid, { envelope: true, source: true }, { uid: true });
      if (!msg) continue;
      const dataRecebimento = msg.envelope && msg.envelope.date ? new Date(msg.envelope.date) : null;
      if (!dataRecebimento || Number.isNaN(dataRecebimento.getTime()) || dataRecebimento <= aposTimestamp) {
        continue; // mensagem ANTES (ou sem data) do timestamp — ignorada (edge case da spec)
      }
      const corpo = msg.source ? msg.source.toString() : '';
      candidatos.push({ uid, data: dataRecebimento, corpo });
    }

    if (candidatos.length === 0) {
      throw new Error('imap-codigo: nenhuma mensagem recebida após o timestamp informado');
    }

    // múltiplas mensagens não lidas -> usa a MAIS RECENTE (edge case da spec)
    candidatos.sort((a, b) => b.data - a.data);
    const maisRecente = candidatos[0];
    const codigo = extrairCodigo(maisRecente.corpo);
    if (!codigo) {
      throw new Error('imap-codigo: mensagem mais recente não contém código no formato esperado (^\\d{6}$) — rejeitada');
    }
    return codigo;
  } finally {
    lock.release();
  }
}

module.exports = { lerCodigoAcesso, extrairCodigo, ASSUNTO_ESPERADO };
