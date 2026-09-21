#!/usr/bin/env node
/**
 * e2e-guard — roda o E2E do hub quando a `main` mudou, e avisa se quebrou.
 *
 * ── Por que existe ──────────────────────────────────────────────────────────
 * Em 2026-09-20 o `hub-shell-e2e-browser.sh` fechava 133 passed / 5 failed. A
 * última execução arquivada era de 21/08, com 138/0. No intervalo entrou a
 * feature de adiantamento inteira (PRs #182–#192) e ninguém rodou o E2E: as
 * falhas ficaram invisíveis por UM MÊS. Duas eram feature entregue sem
 * acabamento (módulo/permissão novos sem rótulo nem descrição) e duas eram
 * premissa de teste que envelheceu junto com decisão de produto deliberada.
 *
 * Nenhuma era difícil de corrigir. Todas foram difíceis de DESCOBRIR — e a
 * causa disso é simples: **nada obriga esse E2E a rodar**. Corrigir as quatro
 * (PRs #196/#197/#199) zerou os sintomas, não a causa. Este guard é a causa.
 * Detalhe em docs/plans/e2e-hub-falhas-herdadas/BRIEFING.md §6 item 4.
 *
 * ── Decisões ────────────────────────────────────────────────────────────────
 * - **Dispara por SHA da `main`, não por relógio.** A dívida nasce de ENTREGA,
 *   não da passagem do tempo: rodar com a main parada gastaria ~8 min de CPU e
 *   ~2 GB de disco para reprovar o que já passou. Main igual à última testada
 *   -> sai 0 sem fazer nada.
 * - **Rebuilda o frontend do hub antes de testar.** O driver NÃO builda (aponta
 *   para o projeto `hub-homolog` vivo). Sem rebuildar, o guard rodaria contra o
 *   binário antigo e passaria verde ignorando exatamente o código novo que ele
 *   existe para vigiar — teste oco, e pior que não ter guard.
 * - **Confere disco ANTES de buildar.** O build custa ~2 GB e este host já foi
 *   derrubado por disco cheio (2026-08-30) e por starvation (2026-06-11). Disco
 *   abaixo do limiar -> não builda, avisa e sai 2. Um alarme nunca pode ser o
 *   que derruba o host.
 * - **Restaura `package-lock.json` e os prints de evidência no fim.** O
 *   container do Playwright reescreve o lock a cada execução (npm de outra
 *   versão, via bind mount; 1027 linhas em 2026-09-20) e sobrescreve PNGs
 *   versionados. Sem isto o guard sujaria o repo toda noite, e o ruído
 *   ensinaria todo mundo a ignorar `git status`.
 * - **Repete a execução antes de acusar.** O E2E tem flake medido (5 testes
 *   diferentes falharam uma vez cada em 2026-09-20/21). Alertar na primeira
 *   falha encheria a caixa de flake até o alarme virar ruído ignorado — que é o
 *   mesmo que não ter alarme. A 2ª rodada não rebuilda: a imagem já é a certa.
 * - **Anti-spam por SHA**, não por tempo: avisa uma vez por commit quebrado. Se
 *   a main não andou, o problema é o mesmo e já foi avisado.
 * - Reusa o SMTP do robô, como cert-guard e disco-guard. Um segundo canal de
 *   e-mail seria mais uma coisa para configurar, quebrar e esquecer.
 * - `exit 1` = E2E falhou. `exit 2` = o próprio guard não conseguiu medir
 *   (disco, build, ambiente). Nunca confundir os dois com "E2E ok".
 *
 * Uso: node e2e-guard.js [--dry-run] [--forcar]
 * Env (todas opcionais): E2E_GUARD_ESTADO, E2E_GUARD_DISCO_MIN_GB (23),
 *   E2E_GUARD_TIMEOUT_MS (2_400_000), ALERTA_DESTINATARIOS.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const ENV_ROBO = '/var/lib/hub_secrets/robo-entrego/.env';
const ESTADO = process.env.E2E_GUARD_ESTADO || '/var/lib/hub_secrets/e2e-guard.estado.json';
/**
 * 23 GB: o build do frontend custa ~2 GB (medido), e o piso do CLAUDE.md para
 * buildar neste host é 20 GB — 23 termina em ~21 e ainda sobra folga. Calibrado
 * contra a realidade: o host vive entre 21 e 30 GB livres, então um limiar de
 * 25 faria o guard se recusar a rodar em dia normal, e um guard que nunca roda
 * é pior que não ter guard (dá sensação de cobertura).
 */
const DISCO_MIN_GB = Number(process.env.E2E_GUARD_DISCO_MIN_GB || 23);
const TIMEOUT_MS = Number(process.env.E2E_GUARD_TIMEOUT_MS || 2_400_000);

const DRIVER = 'infra/hub/testes/hub-shell-e2e-browser.sh';
const COMPOSE = 'infra/hub/compose.hub.homolog.yml';
const ENV_HUB = '/var/lib/hub_secrets/.env.hub.homolog';
/** O E2E suja estes caminhos por bind mount — restaurados no fim, sempre. */
const SUJOS = [
  'app_homologacao/frontend_v2/package-lock.json',
  'docs/plans/hub-frota/evidencias/S3',
];

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: RAIZ, encoding: 'utf8', ...opts });
}

/** SHA curto da `main` local. */
function shaDaMain() {
  return sh('git', ['rev-parse', '--short', 'main']).trim();
}

/** GB livres em `/`, via `df -P` (POSIX) — sem dependência nova. */
function discoLivreGb() {
  const linha = sh('df', ['-Pk', '/']).trim().split('\n').pop();
  return Number(linha.split(/\s+/)[3]) / 1024 / 1024;
}

function lerEstado() {
  try {
    return JSON.parse(fs.readFileSync(ESTADO, 'utf8'));
  } catch {
    return {};
  }
}

function gravarEstado(dados) {
  try {
    fs.mkdirSync(path.dirname(ESTADO), { recursive: true });
    fs.writeFileSync(ESTADO, JSON.stringify(dados, null, 2) + '\n');
  } catch (e) {
    console.error(`[e2e-guard] não consegui gravar estado: ${e.message}`);
  }
}

/**
 * Extrai o placar do log do Playwright. Devolve `null` quando não encontra —
 * que é DIFERENTE de 0 falhas: log sem placar significa que o driver morreu
 * antes de testar (build, seeds, ambiente), e isso não pode virar "tudo ok".
 */
function placarDe(saida) {
  const passed = saida.match(/(\d+) passed/);
  const failed = saida.match(/(\d+) failed/);
  if (!passed && !failed) return null;
  return { passed: Number(passed?.[1] || 0), failed: Number(failed?.[1] || 0) };
}

function corpoDoAlerta({ sha, placar, trecho }) {
  const l = [];
  l.push(`E2E do hub falhou na main ${sha}.`);
  l.push('');
  if (placar) l.push(`Placar: ${placar.passed} passed / ${placar.failed} failed.`);
  else l.push('O driver não chegou a produzir placar — provável falha de build, seed ou ambiente.');
  l.push('');
  l.push('Reproduzir (rebuildar o frontend do hub ANTES, o driver não builda):');
  l.push(`  cd ${RAIZ}`);
  l.push(`  DOCKER_BUILDKIT=0 docker compose -f ${COMPOSE} -p hub-homolog \\`);
  l.push(`    --env-file ${ENV_HUB} build --memory=2g frontend`);
  l.push(`  docker compose -f ${COMPOSE} -p hub-homolog --env-file ${ENV_HUB} up -d frontend`);
  l.push(`  ${DRIVER}`);
  l.push('');
  l.push('Baseline: 139 passed / 0 failed (2026-09-21). Qualquer falha é regressão.');
  l.push('O E2E tem flake conhecido: repetir a execução antes de tratar falha isolada');
  l.push('como real — ver docs/plans/e2e-hub-falhas-herdadas/BRIEFING.md §4.');
  if (trecho) {
    l.push('');
    l.push('Últimas linhas:');
    l.push(trecho);
  }
  return l.join('\n');
}

/** Devolve os cookies do repo ao estado do HEAD — o E2E suja por bind mount. */
function limparSujeira() {
  for (const alvo of SUJOS) {
    try {
      sh('git', ['checkout', '--', alvo]);
    } catch {
      /* arquivo pode não existir ainda; não é motivo para falhar o guard */
    }
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const forcar = process.argv.includes('--forcar');

  const sha = shaDaMain();
  const estado = lerEstado();

  if (!forcar && estado.sha === sha) {
    console.log(`[e2e-guard] main ${sha} já testada (${estado.resultado}) — nada a fazer.`);
    return 0;
  }

  const livre = discoLivreGb();
  if (livre < DISCO_MIN_GB) {
    // Não é "E2E ok" nem "E2E quebrado": é o guard se recusando a agir. Sai 2
    // para a unidade ficar `failed` e o rastro existir mesmo sem e-mail.
    console.error(
      `[e2e-guard] disco com ${livre.toFixed(1)} GB livres (< ${DISCO_MIN_GB}) — NÃO vou buildar.`
    );
    return 2;
  }

  console.log(`[e2e-guard] main ${sha} é nova; disco ${livre.toFixed(1)} GB. Rebuildando frontend…`);
  try {
    sh(
      'docker',
      ['compose', '-f', COMPOSE, '-p', 'hub-homolog', '--env-file', ENV_HUB,
       'build', '--memory=2g', 'frontend'],
      { env: { ...process.env, DOCKER_BUILDKIT: '0' }, stdio: 'pipe', timeout: TIMEOUT_MS }
    );
    sh(
      'docker',
      ['compose', '-f', COMPOSE, '-p', 'hub-homolog', '--env-file', ENV_HUB, 'up', '-d', 'frontend'],
      { stdio: 'pipe', timeout: 300_000 }
    );
  } catch (e) {
    console.error(`[e2e-guard] build/up do frontend falhou: ${e.message}`);
    return 2;
  }

  // Aquecimento: logo após o `up`, a primeira requisição do Next standalone é
  // lenta e derruba o `global-setup` por timeout — falha que PARECE quebra de
  // login e é só cold start (medido em 2026-09-20).
  try {
    sh('curl', ['-sk', '-o', '/dev/null', '--max-time', '90', 'https://localhost:8443/hub/login']);
  } catch {
    /* o driver reclama melhor do que nós se o ambiente estiver fora */
  }

  // Uma execução não basta para acusar. O E2E tem flake medido (`rodada8:21`,
  // `rodada10:58`, `rodada9:61`, `rodada9:32`, `sidebar-colapso:58` falharam
  // uma vez cada, em execuções diferentes, em 2026-09-20/21). Alertar na
  // primeira falha encheria a caixa de e-mail de flake até alguém aprender a
  // ignorar o alarme — e aí ele deixa de existir na prática. Na 2ª rodada NÃO
  // se rebuilda: a imagem já é a certa, e repetir o build só gastaria disco.
  const rodar = () => {
    try {
      return { saida: sh('bash', [DRIVER], { stdio: 'pipe', timeout: TIMEOUT_MS }), falhou: false };
    } catch (e) {
      return { saida: `${e.stdout || ''}${e.stderr || ''}`, falhou: true };
    } finally {
      limparSujeira();
    }
  };

  let { saida, falhou } = rodar();
  let placar = placarDe(saida);
  let ok = !falhou && placar && placar.failed === 0;

  if (!ok) {
    console.error(
      `[e2e-guard] 1ª execução: ${placar ? `${placar.passed}/${placar.failed}` : 'sem placar'}` +
      ' — repetindo antes de acusar (flake conhecido).'
    );
    ({ saida, falhou } = rodar());
    placar = placarDe(saida);
    ok = !falhou && placar && placar.failed === 0;
    if (ok) console.log('[e2e-guard] 2ª execução passou — 1ª foi flake, sem alerta.');
  }

  if (ok) {
    console.log(`[e2e-guard] main ${sha}: ${placar.passed} passed / 0 failed.`);
    gravarEstado({ sha, resultado: 'ok', placar, em: new Date().toISOString() });
    return 0;
  }

  const trecho = saida.split('\n').slice(-25).join('\n');
  const corpo = corpoDoAlerta({ sha, placar, trecho });

  if (dryRun) {
    console.error('[e2e-guard] --dry-run: e-mail NÃO enviado. Corpo:\n' + corpo);
    return 1;
  }

  // Grava ANTES de enviar: se o SMTP falhar, o SHA já está marcado como
  // avisado e a próxima execução não repete o e-mail. O rastro do problema
  // fica na unidade `failed`, que não depende de e-mail nenhum.
  gravarEstado({ sha, resultado: 'falhou', placar, em: new Date().toISOString() });

  try {
    const env = Object.fromEntries(
      fs.readFileSync(ENV_ROBO, 'utf8')
        .split('\n')
        .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
        .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
    );
    const destinatarios = (process.env.ALERTA_DESTINATARIOS || env.ALERTA_DESTINATARIOS || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (!destinatarios.length) {
      console.error('[e2e-guard] sem ALERTA_DESTINATARIOS — alerta só no journal.');
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
      subject: `[VPSTodo] E2E do hub falhou na main ${sha}`,
      text: corpo,
    });
    console.error(`[e2e-guard] alerta enviado para ${destinatarios.length} destinatário(s)`);
  } catch (e) {
    console.error(`[e2e-guard] e-mail não saiu (${e.message}) — alerta fica no journal.`);
  }
  return 1;
}

if (require.main === module) {
  main()
    .then((codigo) => process.exit(codigo))
    .catch((e) => {
      console.error(`[e2e-guard] ERRO: ${e.message}`);
      process.exit(2);
    });
}

module.exports = { placarDe, corpoDoAlerta };
