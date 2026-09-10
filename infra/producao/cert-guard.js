#!/usr/bin/env node
/**
 * cert-guard — avisa ANTES de um certificado TLS expirar.
 *
 * ── Por que existe ──────────────────────────────────────────────────────────
 * Em 2026-09-09 os certificados de `app.moveelog.com.br` e
 * `app.motorista.moveelog.com.br` expiraram e os clientes passaram a ver aviso
 * de segurança do navegador. A primeira notícia do problema foram os usuários.
 * Pior: quatro domínios legados estavam expirados havia QUATRO MESES e ninguém
 * soube — o Traefik tentava renovar todo dia, falhava todo dia, e registrava a
 * falha num arquivo de log dentro do container que ninguém lê.
 *
 * ── Decisões ────────────────────────────────────────────────────────────────
 * - Mede o que o USUÁRIO recebe: abre um handshake TLS e lê o `notAfter` do
 *   certificado servido. Ler o `acme.json` diria o que o Traefik guardou, não
 *   o que ele entrega — e foi justamente essa diferença que criou o incidente.
 * - Conecta em 127.0.0.1:443 passando o domínio por SNI. Evita depender de DNS
 *   e do hairpin do VPSTodo (que já mediu ~28 s), e ainda assim exercita o
 *   mesmo caminho de TLS que o cliente externo percorre.
 * - Descobre os domínios sozinho, a partir das regras `Host(...)` dos serviços
 *   do Swarm. Lista fixa envelhece calada: um domínio novo entraria sem alarme,
 *   que é exatamente o buraco que este guard existe para fechar.
 * - Reusa o SMTP do robô (`infra/robo-entrego/src/alerta-email.js`), como o
 *   disco-guard. Um segundo canal de e-mail seria mais uma coisa para
 *   configurar, quebrar e esquecer.
 * - Sai com código 1 quando alerta: a unidade fica `failed` no systemd, que é
 *   rastro que sobrevive mesmo se o e-mail não sair.
 * - Anti-spam por arquivo de estado, igual ao disco-guard: reavisa quando PIORA
 *   de faixa ou depois de `REAVISO_HORAS`.
 *
 * Uso: node cert-guard.js [--dry-run]
 * Env (todas opcionais): CERT_LIMIAR_DIAS (21), CERT_LIMIAR_CRITICO_DIAS (7),
 *   CERT_DOMINIOS (lista separada por vírgula, ignora a descoberta),
 *   REAVISO_HORAS (12), CERT_ESTADO (arquivo), CERT_TIMEOUT_MS (8000).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const { execFileSync } = require('node:child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const ENV_ROBO = '/var/lib/hub_secrets/robo-entrego/.env';
const LIMIAR_DIAS = Number(process.env.CERT_LIMIAR_DIAS || 21);
const CRITICO_DIAS = Number(process.env.CERT_LIMIAR_CRITICO_DIAS || 7);
const REAVISO_HORAS = Number(process.env.REAVISO_HORAS || 12);
const ESTADO = process.env.CERT_ESTADO || '/var/lib/hub_secrets/cert-guard-estado.json';
const TIMEOUT_MS = Number(process.env.CERT_TIMEOUT_MS || 8000);
const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Extrai os domínios das regras `Host(...)` das labels do Swarm.
 * Aceita a saída bruta de `docker service inspect` — uma regra pode ter mais de
 * um Host e vir combinada com PathPrefix, então varre o texto inteiro.
 * `Host({host:.+})` (catch-all do dashboard do Traefik) não é domínio: fora.
 */
function dominiosDeLabels(texto) {
  const achados = new Set();
  for (const m of texto.matchAll(/Host\(`([^`]+)`\)/g)) {
    const d = m[1].trim();
    if (d.includes('{') || !d.includes('.')) continue;
    achados.add(d);
  }
  return [...achados].sort();
}

/** Domínios roteados pelo Swarm neste host. */
function descobrirDominios() {
  if (process.env.CERT_DOMINIOS) {
    return process.env.CERT_DOMINIOS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const nomes = execFileSync('docker', ['service', 'ls', '--format', '{{.Name}}'], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  let texto = '';
  for (const nome of nomes) {
    try {
      texto += execFileSync('docker', ['service', 'inspect', nome, '--format', '{{json .Spec.Labels}}'], { encoding: 'utf8' });
    } catch (e) {
      console.error(`[cert-guard] não inspecionei ${nome}: ${e.message}`);
    }
  }
  return dominiosDeLabels(texto);
}

/**
 * Handshake TLS local com SNI = domínio. `rejectUnauthorized: false` de
 * propósito: um certificado EXPIRADO é exatamente o que queremos medir, e a
 * validação padrão abortaria antes de nos deixar ler a data.
 */
function medirCertificado(dominio, agoraMs) {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: '127.0.0.1', port: 443, servername: dominio, rejectUnauthorized: false, timeout: TIMEOUT_MS },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || !cert.valid_to) {
          return resolve({ dominio, erro: 'sem certificado no handshake' });
        }
        const fimMs = new Date(cert.valid_to).getTime();
        resolve({
          dominio,
          cn: (cert.subject && cert.subject.CN) || '?',
          sans: cert.subjectaltname || '',
          expiraEm: cert.valid_to,
          dias: Math.floor((fimMs - agoraMs) / 86400000),
        });
      },
    );
    socket.setTimeout(TIMEOUT_MS, () => {
      socket.destroy();
      resolve({ dominio, erro: `timeout de ${TIMEOUT_MS} ms no handshake` });
    });
    socket.on('error', (e) => resolve({ dominio, erro: e.message }));
  });
}

/** ok | alerta | critico — um domínio que não respondeu conta como alerta. */
function faixaDe(medida) {
  if (medida.erro) return 'alerta';
  if (medida.dias < CRITICO_DIAS) return 'critico';
  if (medida.dias < LIMIAR_DIAS) return 'alerta';
  return 'ok';
}

/** A pior faixa entre todos os domínios é a faixa do host. */
function faixaGeral(medidas) {
  const faixas = medidas.map(faixaDe);
  if (faixas.includes('critico')) return 'critico';
  if (faixas.includes('alerta')) return 'alerta';
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
    console.error(`[cert-guard] não consegui gravar o estado em ${ESTADO}: ${e.message}`);
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

function corpoDoAlerta(medidas) {
  const ruins = medidas.filter((m) => faixaDe(m) !== 'ok');
  const linhas = [`${ruins.length} de ${medidas.length} domínio(s) precisam de atenção.`, ''];
  for (const m of ruins.sort((a, b) => (a.dias ?? -9999) - (b.dias ?? -9999))) {
    if (m.erro) {
      linhas.push(`  ${m.dominio}: NÃO MEDIDO — ${m.erro}`);
      continue;
    }
    const estado = m.dias < 0 ? `EXPIRADO há ${-m.dias} dia(s)` : `expira em ${m.dias} dia(s)`;
    linhas.push(`  ${m.dominio}: ${estado} (${m.expiraEm})`);
    // O incidente de 2026-09-09: o cert cobria também um nome já apagado do DNS,
    // e a renovação inteira falhava por causa dele. O SAN é o que denuncia isso.
    if (m.sans && m.sans.split(',').length > 1) {
      linhas.push(`      SANs: ${m.sans.replace(/DNS:/g, '')}`);
    }
  }
  linhas.push(
    '',
    'Onde olhar (o Traefik loga ACME em ARQUIVO, não no stdout — `docker logs` não mostra):',
    "  TID=$(docker ps -qf name=traefik_traefik | head -1)",
    '  docker exec $TID grep -i "Error renewing" /var/log/traefik/traefik.log | tail',
    '',
    'Causa mais provável (foi a de 2026-09-09): o certificado tem um SAN cujo nome',
    'saiu do DNS. A renovação pede TODOS os nomes do cert atual e falha inteira no',
    'nome morto. Corrigir = tirar o nome morto, não reemitir por cima.',
    '',
    'Runbook: docs/plans/infra-certificados/RUNBOOK-CORRECAO.md',
  );
  return linhas.join('\n');
}

async function main() {
  const agoraMs = Date.now();
  const dominios = descobrirDominios();
  if (dominios.length === 0) throw new Error('nenhum domínio descoberto — a descoberta por labels falhou');

  const medidas = [];
  for (const d of dominios) medidas.push(await medirCertificado(d, agoraMs));

  const faixa = faixaGeral(medidas);
  const anterior = lerEstado();
  const piores = medidas.filter((m) => faixaDe(m) !== 'ok').length;
  const resumo = `${medidas.length} domínio(s) medidos, ${piores} com problema (faixa: ${faixa})`;

  for (const m of medidas.sort((a, b) => (a.dias ?? -9999) - (b.dias ?? -9999))) {
    console.log(m.erro ? `  ${m.dominio}: ERRO ${m.erro}` : `  ${String(m.dias).padStart(5)} dias  ${m.dominio}`);
  }

  if (faixa === 'ok') {
    if (anterior.faixa !== 'ok') console.log(`[cert-guard] normalizado — ${resumo}`);
    gravarEstado({ faixa, avisadoEm: null });
    return 0;
  }

  console.error(`[cert-guard] ${faixa.toUpperCase()} — ${resumo}`);
  if (!deveAvisar(faixa, anterior, agoraMs)) {
    console.error('[cert-guard] e-mail suprimido (já avisado nesta faixa) — ver REAVISO_HORAS');
    return 1; // segue failed no systemd: o problema não passou
  }

  if (DRY_RUN) {
    console.error('[cert-guard] --dry-run: e-mail NÃO enviado. Corpo:\n' + corpoDoAlerta(medidas));
    return 1;
  }

  const env = lerEnvRobo();
  const destinatarios = (env.ALERTA_DESTINATARIOS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!env.GMAIL_EMAIL || !env.GMAIL_APP_PASSWORD || destinatarios.length === 0) {
    console.error('[cert-guard] SMTP/destinatários ausentes no .env do robô — alerta ficou só no journal');
    return 1;
  }

  const { criarTransportador } = require(path.join(RAIZ, 'infra/robo-entrego/src/alerta-email.js'));
  const transportador = criarTransportador({
    gmailEmail: env.GMAIL_EMAIL,
    gmailAppPassword: env.GMAIL_APP_PASSWORD,
  });
  const pior = medidas.filter((m) => !m.erro).sort((a, b) => a.dias - b.dias)[0];
  const assunto = pior && pior.dias < 0
    ? `[VPSTodo] Certificado EXPIRADO: ${pior.dominio}`
    : `[VPSTodo] Certificado expira em ${pior ? pior.dias : '?'} dia(s): ${pior ? pior.dominio : 'ver corpo'}`;
  await transportador.sendMail({
    from: env.GMAIL_EMAIL,
    to: destinatarios.join(', '),
    subject: assunto,
    text: corpoDoAlerta(medidas),
  });
  console.error(`[cert-guard] alerta enviado para ${destinatarios.length} destinatário(s)`);
  gravarEstado({ faixa, avisadoEm: new Date(agoraMs).toISOString() });
  return 1;
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
    console.error(`[cert-guard] não li ${ENV_ROBO}: ${e.message}`);
  }
  return out;
}

if (require.main === module) {
  main()
    .then((codigo) => process.exit(codigo))
    .catch((e) => {
      // Falha do próprio guard nunca pode passar por "certificados ok".
      console.error(`[cert-guard] ERRO: ${e.message}`);
      process.exit(2);
    });
}

module.exports = { dominiosDeLabels, faixaDe, faixaGeral, deveAvisar, corpoDoAlerta, medirCertificado };
