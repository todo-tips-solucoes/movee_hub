// Execução ASSISTIDA — primeira ida ao portal real do EntreGô.
//
// Reusa os módulos reais do robô (src/entrego-portal.js, src/imap-codigo.js),
// mas PARA ANTES DE IMPORTAR: baixa os CSVs para um diretório local e relata.
// Nada é enviado ao hub, nada é escrito em produção.
//
// Objetivo: descobrir como o PerimeterX reage a uma sessão automatizada real —
// o único trecho do caminho que nenhum teste conseguiu substituir.
//
// Uso (dentro do container Playwright, via scripts/rodar-assistida.sh):
//   node scripts/execucao-assistida.js [YYYY-MM-DD]
// Sem argumento, usa o dia anterior (D-1).

const fs = require('fs');
const path = require('path');

const SECRETS = process.env.ROBO_ENTREGO_SECRETS_DIR || '/var/lib/hub_secrets/robo-entrego';
const SAIDA = process.env.ROBO_ENTREGO_SAIDA || '/work/.execucao-assistida';

function lerEnv() {
  const p = path.join(SECRETS, '.env');
  return Object.fromEntries(
    fs.readFileSync(p, 'utf8').split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
  );
}

function dataAlvo() {
  if (process.argv[2] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2])) return process.argv[2];
  const d = new Date(Date.now() - 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

(async () => {
  const env = lerEnv();
  const DATA = dataAlvo();
  fs.mkdirSync(SAIDA, { recursive: true });

  const {
    garantirSessaoValida, buscarUrlsRelatorio, baixarCsv, carregarStorageState,
  } = require('/work/src/entrego-portal.js');
  const { lerCodigoAcesso } = require('/work/src/imap-codigo.js');
  const { chromium } = require('playwright');
  const { ImapFlow } = require('imapflow');

  const storageStatePath = path.join(SECRETS, 'entrego-session.json');
  const tinhaSessao = fs.existsSync(storageStatePath);
  console.log(`data alvo        : ${DATA}`);
  console.log(`sessão salva     : ${tinhaSessao ? 'existe — vai tentar reusar' : 'não existe — login completo será necessário'}`);
  console.log('');

  async function obterCodigo(timestampDisparo) {
    console.log('   … aguardando o código chegar por e-mail (IMAP)');
    const client = new ImapFlow({
      host: 'imap.gmail.com', port: 993, secure: true,
      auth: { user: env.GMAIL_EMAIL, pass: (env.GMAIL_APP_PASSWORD || '').replace(/\s/g, '') },
      logger: false,
    });
    await client.connect();
    try {
      const codigo = await lerCodigoAcesso(client, timestampDisparo);
      console.log('   ✓ código obtido do e-mail');
      return codigo;
    } finally { await client.logout(); }
  }

  const storageState = carregarStorageState(storageStatePath);
  const browser = await chromium.launch();
  const context = await browser.newContext(storageState ? { storageState } : {});
  const page = await context.newPage();

  // Rede: distingue "a requisição nem saiu" de "saiu e o portal recusou".
  // Sem isso, um clique sem efeito e uma credencial recusada são indistinguíveis.
  const rede = [];
  page.on('response', (r) => {
    const u = r.url();
    if (/entregolog\.com/.test(u) && !/\.(js|css|woff2?|png|svg|ico)/.test(u)) {
      rede.push(`${r.status()} ${r.request().method()} ${u.replace('https://api.entregolog.com/logistics-web-bff', '')}`);
    }
  });

  // Diagnóstico: em caso de falha, fotografa o estado REAL da página em vez de
  // deixar só o timeout. Sem isso, cada hipótese custa uma ida ao portal — e
  // cada ida gera sinal para o PerimeterX.
  async function diagnosticar(rotulo) {
    try {
      const info = await page.evaluate(() => ({
        url: location.href,
        titulo: document.title,
        inputs: [...document.querySelectorAll('input')].filter((e) => e.offsetParent)
          .map((e) => ({ id: e.id, type: e.type, valor_preenchido: !!e.value, testid: e.getAttribute('data-testid') })),
        // TODOS os botões — não `button[type="submit"]`, que volta vazio neste
        // portal (o React não renderiza o atributo). Foi esse mesmo engano que
        // quebrou os seletores do robô.
        botoes: [...document.querySelectorAll('button')].filter((e) => e.offsetParent)
          .map((e) => ({ texto: (e.innerText || '').trim().slice(0, 40), disabled: e.disabled })),
        // Mensagens de erro na tela (ex.: credencial recusada) — distingue
        // "o portal rejeitou" de "o seletor não encontrou".
        erros: [...document.querySelectorAll('[class*="rror"],[class*="lert"],[role="alert"]')]
          .filter((e) => e.offsetParent).map((e) => (e.innerText || '').trim().slice(0, 120)).filter(Boolean),
        textoTopo: (document.body.innerText || '').trim().slice(0, 400),
      }));
      console.log(`\n   ── diagnóstico (${rotulo}) ──`);
      console.log(`   url    : ${info.url}`);
      console.log(`   título : ${info.titulo}`);
      console.log(`   inputs : ${JSON.stringify(info.inputs)}`);
      console.log(`   botões : ${JSON.stringify(info.botoes)}`);
      if (info.erros.length) console.log(`   ERROS NA TELA: ${JSON.stringify(info.erros)}`);
      console.log(`   texto  : ${info.textoTopo.replace(/\n+/g, ' | ')}`);
      console.log('   ── rede (chamadas ao entregolog) ──');
      if (!rede.length) console.log('     (nenhuma) — o clique não disparou requisição alguma');
      else rede.slice(-12).forEach((l) => console.log(`     ${l}`));
      try {
        const shot = path.join(SAIDA, 'falha.png');
        await page.screenshot({ path: shot, fullPage: true });
        console.log(`   screenshot: ${shot}`);
      } catch { /* screenshot é bônus, não bloqueia */ }
    } catch (e) {
      console.log(`   (diagnóstico indisponível: ${String(e.message).slice(0, 100)})`);
    }
  }

  const resultados = [];
  try {
    console.log('1. garantindo sessão no portal (sonda + login se 401)…');
    const t0 = Date.now();
    await garantirSessaoValida(page, {
      email: env.ENTREGO_EMAIL, senha: env.ENTREGO_SENHA, obterCodigo, storageStatePath,
    });
    console.log(`   ✓ sessão válida em ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log('');

    for (const tipo of ['PERFORMANCE', 'FINANCE']) {
      console.log(`2. ${tipo}: gerando e buscando URLs…`);
      try {
        const itens = await buscarUrlsRelatorio(page, { tipo, dataInicial: DATA, dataFinal: DATA });
        console.log(`   ✓ ${itens.length} item(ns) — datas: ${itens.map((i) => i.date).join(', ')}`);
        for (const item of itens) {
          // baixarCsv devolve { buffer, sha256 } — o mesmo shape que index.js consome.
          const { buffer, sha256 } = await baixarCsv(item.url);
          const nome = `${tipo.toLowerCase()}_${item.date}.csv`;
          fs.writeFileSync(path.join(SAIDA, nome), buffer);
          const texto = buffer.toString('utf8');
          const linhas = texto.split('\n').filter((l) => l.trim()).length;
          const cabecalho = (texto.split('\n')[0] || '').split(';').length;
          console.log(`   ✓ ${nome} — ${buffer.length} bytes, ${linhas} linhas, ${cabecalho} colunas`);
          console.log(`     sha256 ${sha256.slice(0, 16)}… (é a chave de dedupe do hub)`);
          resultados.push({ tipo, date: item.date, nome, bytes: buffer.length, linhas, colunas: cabecalho });
        }
      } catch (e) {
        const m = String((e && e.message) || e);
        console.log(`   ❌ ${tipo} falhou: ${m.slice(0, 200)}`);
        if (/antibot|challenge|captcha|bloque/i.test(m)) {
          console.log('   🔴 SINAL DE ANTI-BOT — a rotina para aqui por desenho (FR-011).');
          console.log('      Não há contorno: é o comportamento correto.');
        }
        resultados.push({ tipo, erro: m.slice(0, 200) });
      }
      console.log('');
    }
  } catch (e) {
    console.log(`\n❌ falhou: ${String((e && e.message) || e).slice(0, 300)}`);
    await diagnosticar('estado no momento da falha');
    throw e;
  } finally {
    await context.close();
    await browser.close();
  }

  console.log('─'.repeat(60));
  const ok = resultados.filter((r) => !r.erro);
  console.log(`RESULTADO: ${ok.length} arquivo(s) baixado(s) em ${SAIDA}`);
  for (const r of resultados) {
    console.log(r.erro ? `  ❌ ${r.tipo}: ${r.erro}` : `  ✓ ${r.nome} (${r.linhas} linhas)`);
  }
  console.log('');
  console.log('NADA foi importado no hub — esta execução para antes disso, por desenho.');
  process.exit(ok.length ? 0 : 1);
})().catch((e) => {
  console.log('❌ erro inesperado:', String((e && e.stack) || e).slice(0, 500));
  process.exit(1);
});
