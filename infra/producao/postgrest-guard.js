#!/usr/bin/env node
/**
 * postgrest-guard — avisa quando o PostgREST de produção para de falar com o banco.
 *
 * ── Por que existe ──────────────────────────────────────────────────────────
 * Em 2026-11-20, das 14:38 às 16:22 UTC, o `pgadmin_postgrest` (v14.1) ficou com
 * o pool "cheio" sem nenhuma conexão real e respondeu 503/504 a TUDO: login do
 * painel, do hub e do app motorista. Banco, disco, rede: tudo saudável. Não se
 * recuperou sozinho; voltou com `docker service update --force`. A primeira
 * notícia foi usuário reclamando, 1h45 depois.
 *
 * ── Decisões ────────────────────────────────────────────────────────────────
 * - Sinal = códigos PGRST000–003 no log do container (conexão/pool/schema cache).
 *   Em 6 semanas de log eles só apareceram na subida de 08/10 e no incidente;
 *   a queda crônica do LISTEN a cada ~2h NÃO gera esses códigos (reconecta em 1s).
 * - Não depende de tráfego de usuário: o adiantamento-worker do backend chama o
 *   PostgREST a cada 60s (4 RPCs), então um travamento às 3h da manhã também
 *   produz ~4 erros/min.
 * - Não usa rede externa nem a URL pública: lê `docker logs`. Um probe HTTP de
 *   fora confundiria Traefik/DNS/certificado com o PostgREST.
 * - Mesmo canal e mesmo anti-ruído do disco-guard (SMTP do robô, arquivo de
 *   estado, reaviso periódico, exit 1 = alerta, exit 2 = o guard falhou).
 * - Avisa também quando NORMALIZA: num apagão, saber que voltou importa tanto
 *   quanto saber que caiu.
 * - NÃO reinicia nada sozinho: restart é escrita em produção (rito, CLAUDE.md).
 *
 * Uso: node postgrest-guard.js [--dry-run]
 * Env (opcionais): POSTGREST_SERVICO (pgadmin_postgrest), POSTGREST_CONTAINER
 *   (id fixo — p/ testar contra um container parado), POSTGREST_JANELA_MIN (5),
 *   POSTGREST_LIMIAR (5), REAVISO_HORAS (1), POSTGREST_ESTADO (arquivo).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { lerEnvRobo } = require('./disco-guard');

const RAIZ = path.resolve(__dirname, '..', '..');
const SERVICO = process.env.POSTGREST_SERVICO || 'pgadmin_postgrest';
const CONTAINER_FIXO = process.env.POSTGREST_CONTAINER || '';
const JANELA_MIN = Number(process.env.POSTGREST_JANELA_MIN || 5);
const LIMIAR = Number(process.env.POSTGREST_LIMIAR || 5);
const REAVISO_HORAS = Number(process.env.REAVISO_HORAS || 1);
const ESTADO = process.env.POSTGREST_ESTADO || '/var/lib/hub_secrets/postgrest-guard-estado.json';
const DRY_RUN = process.argv.includes('--dry-run');

const RE_ERRO = /PGRST00[0-3]/;

/** Linhas de erro de conexão/pool no texto do log, com 1ª/última e contagem por código. */
function analisarLog(texto) {
  const linhas = texto.split('\n').filter((l) => RE_ERRO.test(l));
  const porCodigo = {};
  for (const l of linhas) {
    const c = l.match(RE_ERRO)[0];
    porCodigo[c] = (porCodigo[c] || 0) + 1;
  }
  return { total: linhas.length, porCodigo, primeira: linhas[0] || null, ultima: linhas[linhas.length - 1] || null };
}

/** 'ok' | 'fora' | 'ausente' (nenhum container do serviço rodando). */
function situacaoDe(containerId, analise, limiar = LIMIAR) {
  if (!containerId) return 'ausente';
  return analise.total >= limiar ? 'fora' : 'ok';
}

/** Avisa ao entrar em falha, ao trocar de tipo de falha, a cada REAVISO_HORAS, e ao normalizar. */
function deveAvisar(situacao, anterior, agoraMs, reavisoHoras = REAVISO_HORAS) {
  if (situacao === 'ok') return anterior.situacao !== 'ok';
  if (anterior.situacao !== situacao) return true;
  if (!anterior.avisadoEm) return true;
  return agoraMs - new Date(anterior.avisadoEm).getTime() >= reavisoHoras * 3600 * 1000;
}

function acharContainer() {
  if (CONTAINER_FIXO) return CONTAINER_FIXO;
  const out = execFileSync('docker', ['ps', '-q', '--filter', `name=${SERVICO}`, '--filter', 'status=running'], {
    encoding: 'utf8',
  });
  return out.trim().split('\n')[0] || '';
}

/** O PostgREST escreve em stdout E stderr — `docker logs` repassa os dois; contamos ambos. */
function lerLogCompleto(containerId) {
  const r = spawnSync('docker', ['logs', '--since', `${JANELA_MIN}m`, containerId], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`docker logs falhou (${r.status}): ${(r.stderr || '').trim().slice(0, 200)}`);
  return `${r.stdout}\n${r.stderr}`;
}

function lerEstado() {
  try {
    return JSON.parse(fs.readFileSync(ESTADO, 'utf8'));
  } catch (_e) {
    return { situacao: 'ok', avisadoEm: null, desde: null };
  }
}

function gravarEstado(estado) {
  try {
    fs.mkdirSync(path.dirname(ESTADO), { recursive: true });
    fs.writeFileSync(ESTADO, JSON.stringify(estado), { mode: 0o600 });
  } catch (e) {
    console.error(`[postgrest-guard] não consegui gravar o estado em ${ESTADO}: ${e.message}`);
  }
}

function assuntoDe(situacao, analise) {
  if (situacao === 'ok') return '[VPSTodo] PostgREST NORMALIZADO — produção voltou a responder';
  if (situacao === 'ausente') return `[VPSTodo] PostgREST FORA: nenhum container de ${SERVICO} rodando`;
  return `[VPSTodo] PostgREST FORA: ${analise.total} erros de conexão em ${JANELA_MIN} min — logins falhando`;
}

function corpoDoAlerta(situacao, analise, anterior) {
  if (situacao === 'ok') {
    return [
      `O PostgREST (${SERVICO}) voltou a responder: nenhum erro PGRST000–003 nos últimos ${JANELA_MIN} min.`,
      anterior.desde ? `Estava fora desde ${anterior.desde} (UTC).` : '',
      '',
      'Confirme com um login no painel e no app motorista.',
    ].join('\n');
  }
  const linhas = [
    situacao === 'ausente'
      ? `Nenhum container do serviço ${SERVICO} está rodando.`
      : `${analise.total} erros de conexão/pool no PostgREST (${SERVICO}) nos últimos ${JANELA_MIN} min (limiar: ${LIMIAR}).`,
    'Efeito: o backend recebe 503/504 e TODOS os logins (painel, hub, app motorista) dão "erro no servidor".',
    '',
  ];
  if (situacao === 'fora') {
    linhas.push(
      `Por código: ${Object.entries(analise.porCodigo).map(([c, n]) => `${c}=${n}`).join(', ')}`,
      `Primeira: ${analise.primeira}`,
      `Última:   ${analise.ultima}`,
      '',
    );
  }
  linhas.push(
    'Diagnóstico (incidente de 2026-11-20 — pool travado sem conexão real):',
    '  1. O banco está bem? docker exec <pgadmin_db> psql -U chatmasterveloz -d chatmasterveloz -c "select count(*) from pg_stat_activity"',
    '  2. Sockets REAIS do PostgREST até o banco:',
    '     nsenter -t $(docker inspect -f "{{.State.Pid}}" <cid postgrest>) -n ss -tn | grep 5432',
    '     Se o log diz "pool" (PGRST003) e só existe 1 socket (o LISTEN), o pool travou.',
    '',
    'Correção daquele incidente (escrita em produção — exige autorização pelo rito):',
    `  docker service update --force ${SERVICO}`,
    '  (mesma imagem e configuração; volta em ~10 s; conferir "Schema cache loaded" no log)',
  );
  return linhas.join('\n');
}

async function enviar(assunto, corpo) {
  const env = lerEnvRobo();
  const destinatarios = (env.ALERTA_DESTINATARIOS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!env.GMAIL_EMAIL || !env.GMAIL_APP_PASSWORD || destinatarios.length === 0) {
    throw new Error('SMTP/destinatários ausentes no .env do robô — alerta ficou só no journal');
  }
  const { criarTransportador } = require(path.join(RAIZ, 'infra/robo-entrego/src/alerta-email.js'));
  const transportador = criarTransportador({ gmailEmail: env.GMAIL_EMAIL, gmailAppPassword: env.GMAIL_APP_PASSWORD });
  await transportador.sendMail({ from: env.GMAIL_EMAIL, to: destinatarios.join(', '), subject: assunto, text: corpo });
  console.error(`[postgrest-guard] e-mail enviado para ${destinatarios.length} destinatário(s): ${assunto}`);
}

async function main() {
  const cid = acharContainer();
  const analise = cid ? analisarLog(lerLogCompleto(cid)) : analisarLog('');
  const situacao = situacaoDe(cid, analise);
  const anterior = lerEstado();
  const agoraMs = Date.now();
  const agoraIso = new Date(agoraMs).toISOString();
  const resumo = `${situacao} — ${analise.total} erro(s) PGRST000–003 em ${JANELA_MIN} min (container ${cid || 'nenhum'})`;
  const codigo = situacao === 'ok' ? 0 : 1;

  if (situacao !== 'ok') console.error(`[postgrest-guard] ${resumo}`);
  if (!deveAvisar(situacao, anterior, agoraMs)) {
    if (situacao !== 'ok') console.error('[postgrest-guard] e-mail suprimido (já avisado) — ver REAVISO_HORAS');
    return codigo;
  }

  const assunto = assuntoDe(situacao, analise);
  const corpo = corpoDoAlerta(situacao, analise, anterior);
  if (DRY_RUN) {
    console.error(`[postgrest-guard] --dry-run: e-mail NÃO enviado.\nAssunto: ${assunto}\n${corpo}`);
    return codigo;
  }

  await enviar(assunto, corpo);
  gravarEstado(
    situacao === 'ok'
      ? { situacao, avisadoEm: null, desde: null }
      : { situacao, avisadoEm: agoraIso, desde: anterior.situacao === 'ok' ? agoraIso : anterior.desde || agoraIso },
  );
  return codigo;
}

if (require.main === module) {
  main()
    .then((codigo) => process.exit(codigo))
    .catch((e) => {
      // Falha do próprio guard nunca pode passar por "PostgREST ok".
      console.error(`[postgrest-guard] ERRO: ${e.message}`);
      process.exit(2);
    });
}

module.exports = { analisarLog, situacaoDe, deveAvisar, corpoDoAlerta, assuntoDe };
