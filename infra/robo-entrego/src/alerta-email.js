// alerta-email.js (tasks.md FASE 3, 3.4) — alerta de falha definitiva (FR-013).
// Ref: research.md Decision 5 (SMTP Gmail, mesma senha de app do IMAP).
'use strict';

const nodemailer = require('nodemailer');
const { filtrarRelatorio } = require('./log-execucao');

/**
 * @param {object} opts
 * @param {string} opts.gmailEmail
 * @param {string} opts.gmailAppPassword - MESMA senha de app do IMAP (Decision 5)
 * @param {object} [opts.transporterCustom] - override para teste (sem SMTP real)
 */
function criarTransportador({ gmailEmail, gmailAppPassword, transporterCustom } = {}) {
  if (transporterCustom) return transporterCustom;
  // 🔴 587 + STARTTLS, NAO 465. O provedor da VPS filtra a saida nas portas
  // 25 e 465 (medido 2026-09-03: connect em 465 e 25 = timeout de 8s; 587 e
  // IMAP 993 conectam em 4ms). Com 465 o `sendMail` morria em ETIMEDOUT
  // dentro do `Promise.allSettled` de index.js e NENHUM alerta de falha
  // jamais saiu do host desde que a rotina entrou em operacao. Trocar de
  // volta para 465 desliga o alerta de novo, em silencio.
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: gmailEmail, pass: gmailAppPassword },
  });
}

/**
 * Corpo do alerta — reusa `filtrarRelatorio` de log-execucao.js (mesma
 * allowlist positiva) para nunca incluir `url_s3`/credencial (3.4.3).
 */
function montarCorpoAlerta({ execucaoId, resultado, motivoFalha, relatorios = [] }) {
  const linhasRelatorios = relatorios
    .map(filtrarRelatorio)
    .map((r) => `  - ${r.tipo_hub || r.tipo_portal || '?'}: status_hub=${r.status_hub || 'não tentado'} tentativas=${r.tentativas || 0}`);
  return [
    `Execução ${execucaoId} — resultado: ${resultado}`,
    motivoFalha ? `Motivo: ${motivoFalha}` : null,
    relatorios.length ? 'Relatórios:' : null,
    ...linhasRelatorios,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Envia o alerta (FR-013). `destinatarios`: string separada por vírgula
 * (ALERTA_DESTINATARIOS da configuração, suporte a múltiplos — 3.4.2).
 */
async function enviarAlerta({ transportador, remetente, destinatarios, execucaoId, resultado, motivoFalha, relatorios }) {
  const lista = String(destinatarios || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (lista.length === 0) {
    throw new Error('alerta-email: ALERTA_DESTINATARIOS vazio/não configurado');
  }
  const corpo = montarCorpoAlerta({ execucaoId, resultado, motivoFalha, relatorios });
  return transportador.sendMail({
    from: remetente,
    to: lista.join(', '),
    subject: `[robo-entrego] Falha na execução ${execucaoId} — ${resultado}`,
    text: corpo,
  });
}

module.exports = { criarTransportador, montarCorpoAlerta, enviarAlerta };
