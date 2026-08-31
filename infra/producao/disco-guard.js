#!/usr/bin/env node
/**
 * disco-guard — avisa ANTES de o disco encher.
 *
 * ── Por que existe ──────────────────────────────────────────────────────────
 * Em 2026-08-30 o `/` (150 GB) chegou a 100% e derrubou o Postgres de produção:
 * `FATAL: could not write lock file "postmaster.pid": No space left on device`.
 * A primeira notícia do problema foi o banco caindo. O rito de build passou a
 * exigir `df -h /` (CLAUDE.md), mas isso só cobre builds — qualquer outra coisa
 * que encha o disco (log, dump, volume) continuaria sem aviso.
 *
 * ── Decisões ────────────────────────────────────────────────────────────────
 * - Reusa o SMTP do robô (`infra/robo-entrego/src/alerta-email.js` + o `.env` de
 *   /var/lib/hub_secrets/robo-entrego). Um segundo canal de e-mail seria uma
 *   segunda coisa para configurar, quebrar e esquecer.
 * - Sai com código 1 quando alerta: o systemd marca a unidade como `failed`, o
 *   que deixa rastro em `systemctl list-timers`/`status` mesmo se o e-mail falhar.
 * - Anti-spam por ARQUIVO DE ESTADO: rodando de hora em hora, um disco baixo
 *   geraria 24 e-mails/dia até alguém agir — e e-mail repetido vira ruído que se
 *   aprende a ignorar, que é o oposto de um alarme. Reavisa só quando PIORA de
 *   faixa ou depois de `REAVISO_HORAS`.
 * - Sem dependência nova: `df -P` (POSIX) em vez de lib de filesystem.
 *
 * Uso: node disco-guard.js [--dry-run]
 * Env (todas opcionais): DISCO_ALVO (/), DISCO_LIMIAR_GB (20),
 *   DISCO_LIMIAR_CRITICO_GB (8), REAVISO_HORAS (6), DISCO_ESTADO (arquivo).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const ENV_ROBO = '/var/lib/hub_secrets/robo-entrego/.env';
const ALVO = process.env.DISCO_ALVO || '/';
const LIMIAR_GB = Number(process.env.DISCO_LIMIAR_GB || 20);
const CRITICO_GB = Number(process.env.DISCO_LIMIAR_CRITICO_GB || 8);
const REAVISO_HORAS = Number(process.env.REAVISO_HORAS || 6);
const ESTADO = process.env.DISCO_ESTADO || '/var/lib/hub_secrets/disco-guard-estado.json';
const DRY_RUN = process.argv.includes('--dry-run');

/** `df -P` (POSIX: 1 linha por filesystem, colunas fixas) -> GB livres e uso %. */
function medirDisco(alvo) {
  const saida = execFileSync('df', ['-P', '-k', alvo], { encoding: 'utf8' });
  const linha = saida.trim().split('\n').pop().split(/\s+/);
  const totalKb = Number(linha[1]);
  const livreKb = Number(linha[3]);
  if (!Number.isFinite(totalKb) || !Number.isFinite(livreKb)) {
    throw new Error(`df devolveu algo inesperado para ${alvo}: ${saida.trim()}`);
  }
  return {
    livreGb: livreKb / 1024 / 1024,
    totalGb: totalKb / 1024 / 1024,
    usoPct: Math.round(((totalKb - livreKb) / totalKb) * 100),
  };
}

/** ok | alerta | critico — faixa atual, que é o que decide reavisar. */
function faixaDe(livreGb) {
  if (livreGb < CRITICO_GB) return 'critico';
  if (livreGb < LIMIAR_GB) return 'alerta';
  return 'ok';
}

function lerEstado() {
  try {
    return JSON.parse(fs.readFileSync(ESTADO, 'utf8'));
  } catch (_e) {
    return { faixa: 'ok', avisadoEm: null };
  }
}

function gravarEstado(estado) {
  try {
    fs.mkdirSync(path.dirname(ESTADO), { recursive: true });
    fs.writeFileSync(ESTADO, JSON.stringify(estado), { mode: 0o600 });
  } catch (e) {
    console.error(`[disco-guard] não consegui gravar o estado em ${ESTADO}: ${e.message}`);
  }
}

/** Avisa na 1a vez, quando PIORA de faixa, e a cada REAVISO_HORAS enquanto durar. */
function deveAvisar(faixa, anterior, agoraMs) {
  if (faixa === 'ok') return false;
  if (anterior.faixa === 'ok') return true;
  if (faixa === 'critico' && anterior.faixa === 'alerta') return true;
  if (!anterior.avisadoEm) return true;
  return agoraMs - new Date(anterior.avisadoEm).getTime() >= REAVISO_HORAS * 3600 * 1000;
}

/** Lê o `.env` do robô só para as 3 chaves de e-mail (sem dependência de dotenv). */
function lerEnvRobo() {
  const out = {};
  try {
    for (const linha of fs.readFileSync(ENV_ROBO, 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(linha.trim());
      if (m) out[m[1]] = m[2];
    }
  } catch (e) {
    console.error(`[disco-guard] não li ${ENV_ROBO}: ${e.message}`);
  }
  return out;
}

function corpoDoAlerta(m, faixa) {
  const linhas = [
    `Disco ${ALVO} em ${m.usoPct}% de uso.`,
    `Livre: ${m.livreGb.toFixed(1)} GB de ${m.totalGb.toFixed(0)} GB.`,
    `Limiar de alerta: ${LIMIAR_GB} GB. Crítico: ${CRITICO_GB} GB.`,
    '',
    faixa === 'critico'
      ? 'CRÍTICO: com o disco cheio o Postgres NÃO sobe (foi o incidente de 2026-08-30).'
      : 'Aja antes de chegar ao crítico — builds e dumps consomem GB rápido.',
    '',
    'O que costuma liberar espaço com segurança:',
    '  docker builder prune -f      # só cache de build',
    '  docker image prune -f        # só imagens SEM tag (nunca use -a)',
    '',
    'NUNCA: docker system prune -a (apaga as imagens de rollback locais)',
    'NUNCA: --volumes (destrói envio_massa_hub_uploads, com os arquivos importados)',
  ];
  return linhas.join('\n');
}

async function main() {
  const m = medirDisco(ALVO);
  const faixa = faixaDe(m.livreGb);
  const anterior = lerEstado();
  const agoraMs = Date.now();
  const resumo = `${ALVO} ${m.usoPct}% usado, ${m.livreGb.toFixed(1)} GB livres (faixa: ${faixa})`;

  if (faixa === 'ok') {
    if (anterior.faixa !== 'ok') console.log(`[disco-guard] normalizado — ${resumo}`);
    gravarEstado({ faixa, avisadoEm: null });
    return 0;
  }

  console.error(`[disco-guard] ${faixa.toUpperCase()} — ${resumo}`);
  if (!deveAvisar(faixa, anterior, agoraMs)) {
    console.error('[disco-guard] e-mail suprimido (já avisado nesta faixa) — ver REAVISO_HORAS');
    return 1; // segue failed no systemd: o problema não passou
  }

  if (DRY_RUN) {
    console.error('[disco-guard] --dry-run: e-mail NÃO enviado. Corpo:\n' + corpoDoAlerta(m, faixa));
    return 1;
  }

  const env = lerEnvRobo();
  const destinatarios = (env.ALERTA_DESTINATARIOS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!env.GMAIL_EMAIL || !env.GMAIL_APP_PASSWORD || destinatarios.length === 0) {
    console.error('[disco-guard] SMTP/destinatários ausentes no .env do robô — alerta ficou só no journal');
    return 1;
  }

  const { criarTransportador } = require(path.join(RAIZ, 'infra/robo-entrego/src/alerta-email.js'));
  const transportador = criarTransportador({
    gmailEmail: env.GMAIL_EMAIL,
    gmailAppPassword: env.GMAIL_APP_PASSWORD,
  });
  await transportador.sendMail({
    from: env.GMAIL_EMAIL,
    to: destinatarios.join(', '),
    subject: `[VPSTodo] Disco ${faixa === 'critico' ? 'CRÍTICO' : 'baixo'}: ${m.livreGb.toFixed(1)} GB livres`,
    text: corpoDoAlerta(m, faixa),
  });
  console.error(`[disco-guard] alerta enviado para ${destinatarios.length} destinatário(s)`);
  gravarEstado({ faixa, avisadoEm: new Date(agoraMs).toISOString() });
  return 1;
}

if (require.main === module) {
  main()
    .then((codigo) => process.exit(codigo))
    .catch((e) => {
      // Falha do próprio guard nunca pode passar por "disco ok".
      console.error(`[disco-guard] ERRO: ${e.message}`);
      process.exit(2);
    });
}

module.exports = { medirDisco, faixaDe, deveAvisar, corpoDoAlerta };
