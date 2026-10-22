// Recuperação pontual de UM dia, fora da janela dos 7 dias do backfill
// automático (PR #252). Nasceu para o `performance` de 2026-09-13, perdido
// pelos 3 timeouts de 14/09.
//
//   node scripts/recuperar-dia-pontual.js 2026-09-13                        # consulta PERFORMANCE
//   node scripts/recuperar-dia-pontual.js 2026-09-13 --importar             # importa PERFORMANCE
//   node scripts/recuperar-dia-pontual.js 2026-10-21 FINANCE --importar     # importa FATURAMENTO
//
// O tipo é o 3º argumento (default PERFORMANCE, retrocompatível com as duas
// primeiras formas). ⚠️ Até 2026-10-22 o tipo era HARDCODED em PERFORMANCE e
// este script só recuperava METADE do trabalho do robô. Isso bastava quando o
// faturamento era só relatório — ele vem por PERÍODO e o dia seguinte cobre o
// buraco. Mas os ADIANTAMENTOS dependem do faturamento para acontecer, então
// "espera até amanhã" não é resposta: o dia tem de poder ser recuperado AGORA,
// nos dois tipos (incidente de 22/10, 3 ticks perdidos por colisão de lock).
//
// Rodar SEMPRE pelo mesmo flock do robô, senão colide com o import/enriquecimento.
'use strict';

const index = require('../src/index.js');
const { carregarStorageState, garantirSessaoValida, buscarUrlsRelatorio } = require('../src/entrego-portal.js');
const { criarClienteHub } = require('../src/hub-client.js');

(async () => {
  const dia = process.argv[2];
  const importar = process.argv.includes('--importar');
  // Os mesmos dois tipos que a rodada normal percorre (src/index.js:494).
  const TIPOS = ['PERFORMANCE', 'FINANCE'];
  const tipo = (process.argv.slice(3).find((a) => !a.startsWith('--')) || 'PERFORMANCE').toUpperCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia || '')) {
    console.error('uso: node scripts/recuperar-dia-pontual.js <yyyy-mm-dd> [PERFORMANCE|FINANCE] [--importar]');
    process.exit(2);
  }
  if (!TIPOS.includes(tipo)) {
    console.error(`tipo invalido: ${tipo} — use ${TIPOS.join(' ou ')}`);
    process.exit(2);
  }
  console.log(`tipo: ${tipo}`);

  index.carregarEnv();
  const config = index.lerConfiguracao();
  const { chromium } = require('playwright');
  const { ImapFlow } = require('imapflow');

  const storageState = carregarStorageState(config.storageStatePath);
  const browser = await chromium.launch();
  const context = await browser.newContext(storageState ? { storageState } : {});
  const page = await context.newPage();

  async function obterCodigo(ts) {
    const client = new ImapFlow({
      host: 'imap.gmail.com', port: 993, secure: true,
      auth: { user: config.gmailEmail, pass: config.gmailAppPassword }, logger: false,
    });
    await client.connect();
    try {
      return await require('../src/imap-codigo.js').lerCodigoAcesso(client, ts);
    } finally { await client.logout(); }
  }

  try {
    const { relogou, renovada } = await garantirSessaoValida(page, {
      email: config.entregoEmail, senha: config.entregoSenha, obterCodigo,
      storageStatePath: config.storageStatePath,
    });
    console.log(`sessão: ${relogou ? 'login completo' : renovada ? 'renovada' : 'reusada'}`);

    // 1. o portal AINDA tem esse dia?
    let itens = [];
    try {
      itens = await buscarUrlsRelatorio(page, {
        tipo, dataInicial: dia, dataFinal: dia, timeoutMs: 45_000,
      });
    } catch (e) {
      console.log(`portal: NÃO entregou o relatório de ${dia} — ${e.message}`);
      process.exit(1);
    }
    console.log(`portal: tem ${itens.length} relatório(s) para ${dia}`);
    if (itens.length === 0) process.exit(1);

    if (!importar) {
      console.log('(modo consulta — nada foi importado; repita com --importar)');
      return;
    }

    // 2. importa pelo caminho normal do robô (download + upload + polling)
    const clienteHub = criarClienteHub({ baseURL: config.hubBaseURL, idEmpresaEsperado: config.hubIdEmpresa });
    await clienteHub.login(config.hubServicoEmail, config.hubServicoSenha);
    const r = await index.processarRelatorio({
      tipo, dataAnterior: dia, page, clienteHub,
      entregoCredenciais: { email: config.entregoEmail, senha: config.entregoSenha },
      obterCodigo, storageStatePath: config.storageStatePath,
      dormir: (ms) => new Promise((r2) => setTimeout(r2, ms)),
    });
    console.log(`RESULTADO: importacao ${r.importacao_id} — status ${r.status_hub} (tentativas ${r.tentativas})`);
    if (r.alertas && r.alertas.length) console.log('ressalvas:', JSON.stringify(r.alertas));
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
