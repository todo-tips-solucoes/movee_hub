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
 * - **Distingue `flaky` de `failed`.** Desde 2026-10-10 o config do Playwright
 *   dá 2 retries por TESTE, então `failed` quer dizer "caiu 3 vezes seguidas" e
 *   `flaky` quer dizer "passou na retentativa". Antes disso os dois chegavam
 *   aqui com a mesma cara e o guard alertava sem haver defeito — 8 testes
 *   distintos falharam em 7 rodadas naquele dia, nenhum duas vezes. Flaky acima
 *   de `FLAKY_MAX` tem aviso PRÓPRIO: retry sem vigilância é tapete, não rede.
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
 * - **Cobre os 8 drivers de E2E de browser, com estado POR DRIVER (2026-10-11).**
 *   Até então só o `hub-shell` era vigiado, e por isso 7 drivers ficaram
 *   quebrados sem ninguém ver — um deles desde 15/08. Com um estado único, um
 *   driver vermelho conhecido cegaria os outros sete (em escala menor, foi
 *   exatamente o que aconteceu); com estado por driver, cada um tem o seu
 *   "último sha testado" e o seu próprio anti-spam.
 * - **Rebuilda o frontend UMA vez, roda os drivers em SEQUÊNCIA.** Nunca em
 *   paralelo: há incidente de starvation neste host, e duas rodadas simultâneas
 *   já produziram "browser has been closed". Um driver que cai não interrompe
 *   os seguintes, e o "repetir antes de acusar" é só do que caiu.
 * - **Um e-mail só, consolidado.** Oito e-mails numa manhã é o caminho mais
 *   curto para a caixa ser ignorada.
 * - **Quarentena declarada** (`QUARENTENA`, vazia por padrão): o driver roda e
 *   tem o resultado registrado, mas não gera e-mail. É a terceira opção entre
 *   receber alarme diário que se aprende a ignorar e desligar o guard e ficar
 *   cego — declarada no código, visível no log e no corpo do e-mail.
 *
 * Uso: node e2e-guard.js [--dry-run] [--forcar]
 * Env (todas opcionais): E2E_GUARD_ESTADO, E2E_GUARD_DISCO_MIN_GB (23),
 *   E2E_GUARD_TIMEOUT_MS (build, 2_400_000), ALERTA_DESTINATARIOS.
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
/** Timeout do build do frontend (um só por rodada). */
const TIMEOUT_MS = Number(process.env.E2E_GUARD_TIMEOUT_MS || 2_400_000);
/**
 * Teto de `flaky` tolerado por rodada. O config do Playwright passou a dar 2
 * retries por teste (2026-10-10), o que impede o ruído de derrubar o gate — mas
 * retry sem vigilância vira tapete: o ambiente degrada e ninguém vê. Medido no
 * dia: ~1 teste flaky por rodada em 142. Acima de 3 não é mais ruído de fundo,
 * é o ambiente piorando, e isso merece e-mail mesmo sem nenhum `failed`.
 */
const FLAKY_MAX = Number(process.env.E2E_GUARD_FLAKY_MAX || 3);
/** Relatório JSON que o `playwright.config.hub.ts` escreve a cada execução. */
const RELATORIO_JSON = path.join(
  RAIZ,
  'app_homologacao/frontend_v2/tests/e2e-hub-browser/.report.json'
);

/**
 * Timeout é POR DRIVER, não do conjunto: um driver travado consome só a
 * própria janela, nunca a dos outros. A conta (medida em 2026-10-11, 8 drivers
 * em sequência = 12–14 min):
 *   - hub-shell: o maior — ~4 min de Playwright + setup/seeds/`npm install`
 *     no container => ~6 min reais. 20 min = ~3,3x de folga.
 *   - os 7 restantes: ~1 a 3 min cada (os 4 que fazem `next build` dentro do
 *     container são os mais lentos). 10 min = >3x o mais lento deles.
 * Pior caso (todos travam e todos repetem) é longo, mas é o caso patológico; o
 * normal fecha em ~14 min + o rebuild.
 */
const TIMEOUT_SHELL_MS = 1_200_000;
const TIMEOUT_DEMAIS_MS = 600_000;
/** Ordem: hub-shell primeiro (o maior e o mais importante), depois os outros. */
const DRIVERS = [
  { nome: 'hub-shell', caminho: 'infra/hub/testes/hub-shell-e2e-browser.sh', timeout: TIMEOUT_SHELL_MS, relatorio: true },
  { nome: 'hub-adiantamentos', caminho: 'infra/hub/testes/hub-adiantamentos-e2e-browser.sh', timeout: TIMEOUT_DEMAIS_MS },
  { nome: 'hub-avisos', caminho: 'infra/hub/testes/hub-avisos-e2e-browser.sh', timeout: TIMEOUT_DEMAIS_MS },
  { nome: 'hub-motorista-360', caminho: 'infra/hub/testes/hub-motorista-360-e2e-browser.sh', timeout: TIMEOUT_DEMAIS_MS },
  { nome: 'motorista-adiantamento', caminho: 'infra/hub/testes/hub-motorista-adiantamento-e2e-browser.sh', timeout: TIMEOUT_DEMAIS_MS },
  { nome: 'motorista-push', caminho: 'infra/hub/testes/hub-motorista-push-e2e-browser.sh', timeout: TIMEOUT_DEMAIS_MS },
  { nome: 'envio-massa-a11y', caminho: 'infra/hub/testes/hub-envio-massa-a11y-smoke.sh', timeout: TIMEOUT_DEMAIS_MS },
  { nome: 'auditoria-admin-a11y', caminho: 'infra/hub/testes/hub-auditoria-admin-a11y-smoke.sh', timeout: TIMEOUT_DEMAIS_MS },
];
/**
 * Drivers em quarentena: rodam e têm o resultado gravado, mas NÃO geram e-mail.
 * Vazia por padrão — os 8 estão verdes desde o PR #267. Só entra aqui um driver
 * vermelho com correção a caminho; tirar da lista quando consertar.
 */
const QUARENTENA = [];
const COMPOSE = 'infra/hub/compose.hub.homolog.yml';
const ENV_HUB = '/var/lib/hub_secrets/.env.hub.homolog';
/** O E2E suja estes caminhos por bind mount — restaurados no fim, sempre. */
const SUJOS = [
  'app_homologacao/frontend_v2/package-lock.json',
  'docs/plans/hub-frota/evidencias/S3',
  // Os smokes de a11y regravam estes JSONs versionados (medido em 2026-10-11).
  'docs/specs/hub-envio-massa/evidencias/5.2.1-tab-walk.json',
  'docs/specs/hub-envio-massa/evidencias/5.2.2-aria-hub-vs-legado.json',
  'docs/specs/hub-auditoria-admin/evidencias/6.3.1-tab-walk.json',
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

/**
 * Normaliza o conteúdo do arquivo de estado para `{ [nomeDoDriver]: {...} }`.
 * O formato antigo (um driver só: `{sha, resultado, placar, flaky, em}` na raiz)
 * é o estado do `hub-shell` — migrado sem perder dado. Um guard que perde o
 * estado volta a testar o que já testou e manda alarme repetido.
 */
function migrarEstado(dados) {
  if (!dados || typeof dados !== 'object' || Array.isArray(dados)) return {};
  if (typeof dados.sha === 'string') return { 'hub-shell': dados };
  return dados;
}

function lerEstado(arquivo = ESTADO) {
  try {
    return migrarEstado(JSON.parse(fs.readFileSync(arquivo, 'utf8')));
  } catch {
    return {};
  }
}

function gravarEstado(estado, arquivo = ESTADO) {
  try {
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    fs.writeFileSync(arquivo, JSON.stringify(estado, null, 2) + '\n');
  } catch (e) {
    console.error(`[e2e-guard] não consegui gravar estado: ${e.message}`);
  }
}

/** Grava o estado de UM driver, preservando os dos outros. */
function gravarEstadoDoDriver(nome, dados, arquivo = ESTADO) {
  gravarEstado({ ...lerEstado(arquivo), [nome]: dados }, arquivo);
}

/**
 * Extrai o placar do log do Playwright. Devolve `null` quando não encontra —
 * que é DIFERENTE de 0 falhas: log sem placar significa que o driver morreu
 * antes de testar (build, seeds, ambiente), e isso não pode virar "tudo ok".
 */
function placarDe(saida) {
  const passed = saida.match(/(\d+) passed/);
  const failed = saida.match(/(\d+) failed/);
  // `flaky` = passou numa retentativa. É o sinal que faltava: antes dos
  // retries, ruído e regressão chegavam aqui com a mesma cara (`failed`), e o
  // guard não tinha como distinguir — foi o que o cegou.
  const flaky = saida.match(/(\d+) flaky/);
  if (!passed && !failed && !flaky) return null;
  return {
    passed: Number(passed?.[1] || 0),
    failed: Number(failed?.[1] || 0),
    flaky: Number(flaky?.[1] || 0),
  };
}

/**
 * Nomes dos testes `flaky`, lidos do relatório JSON que o próprio config do
 * Playwright já escreve (`reporter: [['list'], ['json', …]]`). Preferido ao
 * regex sobre o texto do `list`: o JSON traz o status por teste, e um dia em
 * que o reporter mudar de formato não vira "nenhum flaky" em silêncio.
 *
 * Devolve `null` quando o relatório não existe ou não é legível — quem chama
 * decide o que fazer, e nunca lê isso como "zero flaky".
 */
function flakyDoRelatorio(arquivo = RELATORIO_JSON) {
  let dados;
  try {
    dados = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  } catch {
    return null;
  }
  const nomes = [];
  const andar = (suites = []) => {
    for (const s of suites) {
      for (const spec of s.specs || []) {
        for (const teste of spec.tests || []) {
          if (teste.status === 'flaky') nomes.push(`${s.file || spec.file}:${spec.line} › ${spec.title}`);
        }
      }
      andar(s.suites);
    }
  };
  andar(dados.suites);
  return nomes;
}

/**
 * Envia o alerta por e-mail. Extraída quando passou a existir um segundo
 * motivo de aviso (flaky acima do teto) — duplicar o SMTP em dois lugares é
 * como se esquece de corrigir um deles.
 *
 * Nunca lança: e-mail que não sai é degradação do aviso, não do guard. O
 * rastro do problema fica no journal e na unidade, que não dependem de SMTP
 * (ver [[smtp-saida-vpstodo]]: alerta que falha calado parece "sem falha").
 * Devolve true só quando o `sendMail` completou.
 */
async function enviarAlerta(assunto, corpo) {
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
      return false;
    }
    const { criarTransportador } = require(path.join(RAIZ, 'infra/robo-entrego/src/alerta-email.js'));
    const transportador = criarTransportador({
      gmailEmail: env.GMAIL_EMAIL,
      gmailAppPassword: env.GMAIL_APP_PASSWORD,
    });
    await transportador.sendMail({
      from: env.GMAIL_EMAIL,
      to: destinatarios.join(', '),
      subject: `[VPSTodo] ${assunto}`,
      text: corpo,
    });
    console.error(`[e2e-guard] alerta enviado para ${destinatarios.length} destinatário(s)`);
    return true;
  } catch (e) {
    console.error(`[e2e-guard] e-mail não saiu (${e.message}) — alerta fica no journal.`);
    return false;
  }
}

/**
 * Corpo ÚNICO do alerta. `resultados`: [{nome, caminho, ok, placar, flaky,
 * trecho}]. Falhas e flaky acima do teto de drivers em `quarentena` vão numa
 * seção própria (informativa); os demais entram nas seções de alarme. Drivers
 * que passaram limpos não são citados.
 */
function corpoConsolidado({ sha, resultados, quarentena = QUARENTENA, flakyMax = FLAKY_MAX }) {
  const emQ = (r) => quarentena.includes(r.nome);
  const falhou = (r) => !r.ok;
  const flakyDemais = (r) => r.ok && r.placar && r.placar.flaky > flakyMax;
  const caiu = resultados.filter((r) => falhou(r) && !emQ(r));
  const instaveis = resultados.filter((r) => flakyDemais(r) && !emQ(r));
  const quarentenados = resultados.filter((r) => emQ(r) && (falhou(r) || flakyDemais(r)));

  const l = [];
  l.push(`E2E do hub na main ${sha}: ${caiu.length} driver(s) falharam, ${instaveis.length} flaky acima do teto.`);

  if (caiu.length) {
    l.push('', '== FALHARAM ==');
    for (const r of caiu) {
      l.push('', `-- ${r.nome} (${r.caminho})`);
      if (r.placar) l.push(`Placar: ${r.placar.passed} passed / ${r.placar.failed} failed.`);
      else l.push('O driver não chegou a produzir placar — provável falha de build, seed ou ambiente.');
      if (r.trecho) l.push('Últimas linhas:', r.trecho);
    }
    l.push('', 'Reproduzir (rebuildar o frontend do hub ANTES, o driver não builda):');
    l.push(`  cd ${RAIZ}`);
    l.push(`  DOCKER_BUILDKIT=0 docker compose -f ${COMPOSE} -p hub-homolog \\`);
    l.push(`    --env-file ${ENV_HUB} build --memory=2g frontend`);
    l.push(`  docker compose -f ${COMPOSE} -p hub-homolog --env-file ${ENV_HUB} up -d frontend`);
    l.push('  bash <caminho do driver acima>');
    l.push('');
    l.push('Com 2 retries por teste ligados, um `failed` aqui significa que o MESMO');
    l.push('teste caiu três vezes seguidas (e o driver inteiro foi repetido) — isso');
    l.push('não é mais flake, trate como regressão. Baseline do hub-shell: 142 passed');
    l.push('(2026-10-10).');
  }

  if (instaveis.length) {
    l.push('', '== FLAKY ACIMA DO TETO ==', '');
    l.push('Nenhuma regressão (todos passaram numa retentativa), mas o ambiente de');
    l.push('teste está degradando — e flaky demais vira failed quando os retries não');
    l.push('bastarem mais.');
    for (const r of instaveis) {
      l.push(`  - ${r.nome}: ${r.placar.flaky} flaky (teto ${flakyMax})`);
      for (const n of Array.isArray(r.flaky) ? r.flaky : []) l.push(`      ${n}`);
    }
    l.push('', `Ajustar o teto: E2E_GUARD_FLAKY_MAX (hoje ${flakyMax}).`);
  }

  if (quarentenados.length) {
    l.push('', '== EM QUARENTENA (não geram alarme) ==', '');
    for (const r of quarentenados) {
      l.push(`  - ${r.nome}: ${falhou(r) ? 'falhou' : 'flaky acima do teto'}` +
        (r.placar ? ` (${r.placar.passed} passed / ${r.placar.failed} failed / ${r.placar.flaky} flaky)` : ''));
    }
    l.push('', 'Tirar da lista QUARENTENA em e2e-guard.js quando o driver for consertado.');
  }
  return l.join('\n');
}

/** Há algo que mereça e-mail? Quarentena e drivers limpos não contam. */
function precisaAlarme(resultados, quarentena = QUARENTENA, flakyMax = FLAKY_MAX) {
  return resultados.some((r) =>
    !quarentena.includes(r.nome) && (!r.ok || (r.placar && r.placar.flaky > flakyMax)));
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

  // Só roda o que ainda não foi testado nesta main (estado POR driver).
  const pendentes = DRIVERS.filter((d) => forcar || estado[d.nome]?.sha !== sha);
  if (!pendentes.length) {
    console.log(`[e2e-guard] main ${sha} já testada nos ${DRIVERS.length} drivers — nada a fazer.`);
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

  console.log(
    `[e2e-guard] main ${sha} é nova para ${pendentes.length}/${DRIVERS.length} driver(s); ` +
    `disco ${livre.toFixed(1)} GB. Rebuildando frontend…`
  );
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

  // Uma execução não basta para acusar. O E2E tem flake medido (5 testes
  // diferentes falharam uma vez cada em 2026-09-20/21; o motorista-360 caiu com
  // "browser has been closed" e passou na rodada seguinte). A 2ª rodada é só do
  // driver que caiu e NÃO rebuilda: a imagem já é a certa.
  const rodar = (d) => {
    try {
      return { saida: sh('bash', [d.caminho], { stdio: 'pipe', timeout: d.timeout }), falhou: false };
    } catch (e) {
      return { saida: `${e.stdout || ''}${e.stderr || ''}`, falhou: true };
    } finally {
      limparSujeira();
    }
  };

  const resultados = [];
  // SEQUÊNCIA, nunca paralelo (starvation); um driver que cai não para os outros.
  for (const d of pendentes) {
    const quarentena = QUARENTENA.includes(d.nome);
    console.log(`[e2e-guard] >>> ${d.nome}${quarentena ? ' (EM QUARENTENA)' : ''}`);
    const t0 = Date.now();
    let { saida, falhou } = rodar(d);
    let placar = placarDe(saida);
    // O relatório JSON só existe para o config do hub-shell; ler logo após a
    // execução dele, antes que outro driver faça qualquer coisa.
    let flaky = d.relatorio ? flakyDoRelatorio() : null;
    let ok = !falhou && !!placar && placar.failed === 0;

    if (!ok) {
      console.error(
        `[e2e-guard] ${d.nome}: 1ª execução ${placar ? `${placar.passed}/${placar.failed}` : 'sem placar'}` +
        ' — repetindo SÓ este driver antes de acusar (flake conhecido).'
      );
      ({ saida, falhou } = rodar(d));
      placar = placarDe(saida);
      flaky = d.relatorio ? flakyDoRelatorio() : null;
      ok = !falhou && !!placar && placar.failed === 0;
      if (ok) console.log(`[e2e-guard] ${d.nome}: 2ª execução passou — 1ª foi flake.`);
    }

    // Duração por driver no log: é a medição que calibra os timeouts acima.
    console.log(`[e2e-guard] ${d.nome}: ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    const demais = ok && placar.flaky > FLAKY_MAX;
    if (ok) {
      console.log(`[e2e-guard] ${d.nome}: ${placar.passed} passed / 0 failed / ${placar.flaky} flaky.`);
      if (Array.isArray(flaky)) for (const n of flaky) console.log(`[e2e-guard]   flaky: ${n}`);
    } else {
      console.error(`[e2e-guard] ${d.nome}: FALHOU${quarentena ? ' (quarentena, sem e-mail)' : ''}.`);
    }

    resultados.push({
      nome: d.nome, caminho: d.caminho, ok, placar, flaky,
      trecho: ok ? '' : saida.split('\n').slice(-25).join('\n'),
    });

    // Em --dry-run, falha não é gravada: marcaria o sha como "avisado" e
    // suprimiria o e-mail real da próxima execução.
    if (ok || !dryRun) {
      gravarEstadoDoDriver(d.nome, {
        sha,
        resultado: ok ? (demais ? 'ok-flaky-acima-do-teto' : 'ok') : (quarentena ? 'falhou-quarentena' : 'falhou'),
        placar,
        flaky: flaky ?? (d.relatorio ? 'relatorio-ilegivel' : 'sem-relatorio'),
        em: new Date().toISOString(),
      });
    }
  }

  if (precisaAlarme(resultados)) {
    const corpo = corpoConsolidado({ sha, resultados });
    const nCaiu = resultados.filter((r) => !r.ok && !QUARENTENA.includes(r.nome)).length;
    if (dryRun) {
      console.error('[e2e-guard] --dry-run: e-mail NÃO enviado. Corpo:\n' + corpo);
    } else {
      // O estado já foi gravado por driver ANTES do envio: se o SMTP falhar, o
      // sha já está marcado como avisado e a próxima execução não repete.
      await enviarAlerta(`E2E do hub: ${nCaiu} driver(s) falharam na main ${sha}`, corpo);
    }
  }

  const quebrados = resultados.filter((r) => !r.ok && !QUARENTENA.includes(r.nome));
  console.log(
    `[e2e-guard] resumo main ${sha}: ` +
    resultados.map((r) => `${r.nome}=${r.ok ? 'ok' : 'FALHOU'}`).join(' ')
  );
  return quebrados.length ? 1 : 0;
}

if (require.main === module) {
  main()
    .then((codigo) => process.exit(codigo))
    .catch((e) => {
      console.error(`[e2e-guard] ERRO: ${e.message}`);
      process.exit(2);
    });
}

module.exports = {
  placarDe, flakyDoRelatorio, corpoConsolidado, precisaAlarme,
  migrarEstado, lerEstado, gravarEstadoDoDriver, FLAKY_MAX,
};
