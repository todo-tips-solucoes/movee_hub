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
/**
 * Extrai o código de 6 dígitos do e-mail.
 *
 * ⚠️ O argumento costuma ser `msg.source`, que é o e-mail RAW INTEIRO — com
 * cabeçalhos MIME. Message-ID, boundaries, DKIM e datas estão cheios de
 * sequências de 6 dígitos, e a versão anterior (`/\b(\d{6})\b/` sobre o texto
 * todo) devolvia a PRIMEIRA delas: um pedaço de cabeçalho, não o código.
 * O portal então respondia 401 em `authentication/token` — sintoma observado
 * na execução assistida de 2026-08-28.
 *
 * Ordem de tentativa:
 *   1. descarta os cabeçalhos (tudo até a primeira linha em branco);
 *   2. procura um 6-dígitos ANCORADO em contexto ("código", "code", "acesso");
 *   3. só então cai no primeiro 6-dígitos do corpo.
 */
function extrairCodigo(texto) {
  if (typeof texto !== 'string') return null;

  // 1. corpo = tudo após a primeira linha em branco (fim dos cabeçalhos).
  //    Se não houver separador, o texto já é o corpo.
  const sep = texto.search(/\r?\n\r?\n/);
  let corpo = sep >= 0 ? texto.slice(sep) : texto;
  // tags HTML viram espaço para não colarem dígitos de atributos no texto
  corpo = corpo.replace(/<[^>]*>/g, ' ');

  // 2. ancorado em contexto — o mais confiável
  const contextual = /(?:c[óo]digo|code|acesso|valida[çc][ãa]o)[^0-9]{0,40}(\d{6})\b/i.exec(corpo)
    || /\b(\d{6})\b[^0-9]{0,40}(?:é o seu c[óo]digo|is your code)/i.exec(corpo);
  if (contextual && REGEX_CODIGO_ESTRITO.test(contextual[1])) return contextual[1];

  // 3. fallback: primeiro 6-dígitos do CORPO (nunca dos cabeçalhos)
  const match = REGEX_CODIGO_CANDIDATO.exec(corpo);
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
/**
 * Lê o código esperando ele CHEGAR (execução assistida 2026-08-28).
 *
 * A versão anterior buscava UMA vez, imediatamente após o clique que dispara o
 * e-mail — e falhava sempre, porque o envio pelo portal + a entrega no Gmail
 * levam alguns segundos. O robô procurava antes de a mensagem existir.
 * Agora repete a busca até `timeoutMs`, devolvendo o último erro se estourar.
 *
 * O lock do mailbox é adquirido e liberado A CADA tentativa de propósito:
 * mantê-lo aberto pode congelar a visão da caixa e esconder mensagens novas.
 */
async function lerCodigoAcesso(
  client,
  aposTimestamp,
  // timeoutMs = 5min: MEDIDO em 2026-08-28 — os códigos levaram entre 2 e 3
  // minutos para chegar na caixa (envio do portal + entrega do Gmail). Com os
  // 120s originais o robô desistia pouco antes de a mensagem chegar, e o
  // sintoma ("nenhuma mensagem recebida") era idêntico ao de um portal que
  // parou de enviar. Se o código expirar antes disso, o portal recusa em
  // authentication/token e o erro fica explícito ali.
  // `margemMs` (2 min): tolerância no recorte por data. Em 2026-08-29 as
  // rodadas de 13h e 14h falharam com "nenhuma mensagem recebida após o
  // timestamp" enquanto o e-mail ESTAVA na caixa, chegado ~2 min antes de o
  // polling começar. A causa exata do descompasso não foi determinada (o log
  // não registrava o timestamp de disparo — corrigido agora), então esta
  // margem é um PALIATIVO FUNDAMENTADO, não a correção da causa raiz.
  // Seguro: as janelas do robô são espaçadas em horas, então 2 min não alcança
  // o código de uma rodada anterior.
  { mailbox = 'INBOX', assunto = ASSUNTO_ESPERADO, timeoutMs = 300000, intervaloMs = 5000, margemMs = 120000, dormir, agora } = {}
) {
  if (!(aposTimestamp instanceof Date) || Number.isNaN(aposTimestamp.getTime())) {
    throw new Error('imap-codigo: aposTimestamp inválido (esperado instância de Date)');
  }
  const corteComMargem = new Date(aposTimestamp.getTime() - margemMs);
  const _dormir = dormir || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const _agora = agora || Date.now;
  const limite = _agora() + timeoutMs;
  const inicioPolling = new Date(_agora());
  let ultimoDiag = null;

  for (;;) {
    try {
      return await _lerUmaVez(client, corteComMargem, {
        mailbox, assunto, diag: (d) => { ultimoDiag = d; },
      });
    } catch (e) {
      // "ainda não chegou" é transitório e merece nova tentativa; formato de
      // código inválido é definitivo — insistir não muda o conteúdo.
      const definitivo = /não contém código no formato esperado/.test(String(e.message));
      if (definitivo || _agora() >= limite) {
        // Os 3 dados cuja ausência impediu diagnosticar as falhas de 13h/14h
        // em 2026-08-29: quando disparamos, qual corte foi usado, e o que
        // HAVIA na caixa. Sem eles, "nenhuma recebida após" é indistinguível
        // de "o portal não enviou".
        e.diagnosticoImap = {
          disparo: aposTimestamp.toISOString(),
          corte_com_margem: corteComMargem.toISOString(),
          polling_iniciou: inicioPolling.toISOString(),
          polling_terminou: new Date(_agora()).toISOString(),
          mensagens_com_assunto: ultimoDiag ? ultimoDiag.encontradas : null,
          mais_recente: ultimoDiag ? ultimoDiag.maisRecente : null,
        };
        e.message += ultimoDiag && ultimoDiag.maisRecente
          ? ` [disparo=${aposTimestamp.toISOString()} corte=${corteComMargem.toISOString()} msg_mais_recente=${ultimoDiag.maisRecente}]`
          : ` [disparo=${aposTimestamp.toISOString()} nenhuma mensagem com o assunto na janela]`;
        throw e;
      }
      await _dormir(intervaloMs);
    }
  }
}

async function _lerUmaVez(client, aposTimestamp, { mailbox, assunto, diag } = {}) {

  // Modo read-only (\Peek do protocolo) — hardening owasp-security: a
  // credencial dá acesso à caixa inteira; nunca marcar como lida, mover ou
  // deletar (least privilege de COMPORTAMENTO mesmo com escopo amplo).
  const lock = await client.getMailboxLock(mailbox, { readOnly: true });
  try {
    // SINCE do protocolo IMAP só tem granularidade de DIA — o filtro fino
    // por timestamp exato (abaixo) é feito client-side por envelope.date,
    // nunca confiado só ao SEARCH do servidor.
    // `since` recuado 1 DIA de propósito. O SINCE do IMAP tem granularidade de
    // DIA e o servidor o resolve no fuso DELE: com `since` = agora, perto da
    // virada de dia a janela exclui mensagens recém-chegadas.
    // MEDIDO em 2026-08-29T00:30Z: `since=agora` devolvia 0 mensagens enquanto
    // `since=ontem` devolvia 6 — incluindo o código que chegara 8 min antes.
    // Alargar aqui é seguro porque o recorte fino é feito CLIENT-SIDE logo
    // abaixo, por `envelope.date > aposTimestamp` — nenhuma mensagem antiga
    // passa por causa disto.
    const sinceComMargem = new Date(aposTimestamp.getTime() - 24 * 60 * 60 * 1000);
    const uids = await client.search({ subject: assunto, since: sinceComMargem }, { uid: true });
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
      // Reporta o que HAVIA na caixa — sem isto, "nenhuma recebida após" é
      // indistinguível de "o portal não enviou" (confusão real de 2026-08-29).
      if (typeof diag === 'function') {
        let maisRecente = null;
        for (const uid of uids) {
          const m = await client.fetchOne(uid, { envelope: true }, { uid: true });
          const d = m && m.envelope && m.envelope.date ? new Date(m.envelope.date) : null;
          if (d && (!maisRecente || d > maisRecente)) maisRecente = d;
        }
        diag({ encontradas: uids.length, maisRecente: maisRecente ? maisRecente.toISOString() : null });
      }
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
