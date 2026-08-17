// impeccable r24 — a POLÍTICA de perda de evento de auditoria.
//
// O `catch` best-effort do `registrarAuditoria` já escondeu um defeito
// sistêmico real: desde a migration 0035, TODO evento global (login_sucesso,
// login_falha, logout, recuperacao_senha_solicitada, senha_redefinida) falhava
// com 42501 no RETURNING e ninguém percebeu até um E2E tropeçar. O que estes
// testes guardam não é a gravação — é que a PERDA nunca volte a ser silenciosa.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

/** Carrega o módulo com um `hubPostgrestRequest` controlado pelo teste. */
function carregarComPostgrest(fake) {
  const caminho = require.resolve('../lib/hub-auditoria');
  const caminhoPg = require.resolve('../lib/hub-postgrest');
  delete require.cache[caminho];
  const originalLoad = Module._load;
  Module._load = function (pedido, pai, ehMain) {
    if (pai && pai.filename === caminho && pedido === './hub-postgrest') {
      return { hubPostgrestRequest: fake };
    }
    return originalLoad(pedido, pai, ehMain);
  };
  try {
    delete require.cache[caminhoPg];
    return require('../lib/hub-auditoria');
  } finally {
    Module._load = originalLoad;
  }
}

const EVENTO = { idEmpresa: 1, usuarioId: 2, acao: 'teste_acao', recurso: 'Teste' };

test('sucesso na primeira tentativa: ok=true, nenhuma perda contada', async () => {
  let chamadas = 0;
  const mod = carregarComPostgrest(async () => { chamadas += 1; });
  mod._zerarEstatisticasAuditoria();

  const r = await mod.registrarAuditoria(EVENTO);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(chamadas, 1);
  assert.strictEqual(mod.estatisticasAuditoria().total, 0);
});

test('falha transitória é recuperada pelo retry — sem perda', async () => {
  let chamadas = 0;
  const mod = carregarComPostgrest(async () => {
    chamadas += 1;
    if (chamadas === 1) throw new Error('ECONNRESET');
  });
  mod._zerarEstatisticasAuditoria();

  const r = await mod.registrarAuditoria(EVENTO);
  assert.strictEqual(r.ok, true, 'a segunda tentativa gravou');
  assert.strictEqual(chamadas, 2);
  assert.strictEqual(mod.estatisticasAuditoria().total, 0);
});

test('falha nas duas tentativas: NÃO lança, mas devolve ok=false e conta a perda', async () => {
  const mod = carregarComPostgrest(async () => { throw new Error('42501 policy'); });
  mod._zerarEstatisticasAuditoria();

  const erros = [];
  const originalErro = console.error;
  console.error = (...a) => erros.push(a.join(' '));
  let r;
  try {
    r = await mod.registrarAuditoria(EVENTO);
  } finally {
    console.error = originalErro;
  }

  // Best-effort segue valendo: o fluxo do chamador NÃO é interrompido.
  assert.strictEqual(r.ok, false);
  assert.match(r.erro, /42501/);

  // Mas a perda é contada...
  const est = mod.estatisticasAuditoria();
  assert.strictEqual(est.total, 1);
  assert.strictEqual(est.porAcao.teste_acao, 1);
  assert.ok(est.primeira && est.ultima, 'janela da perda registrada');

  // ...e gritada com marcador estável, com o contexto para reconstruir o caso.
  const linha = erros.find((l) => l.includes(mod.MARCADOR_PERDA));
  assert.ok(linha, 'a perda precisa carregar o marcador grepável');
  assert.match(linha, /teste_acao/);
  assert.match(linha, /42501/);
});

test('a primeira causa é preservada, não a do retry', async () => {
  let chamadas = 0;
  const mod = carregarComPostgrest(async () => {
    chamadas += 1;
    throw new Error(chamadas === 1 ? 'CAUSA_ORIGINAL' : 'ruido_do_retry');
  });
  mod._zerarEstatisticasAuditoria();
  const originalErro = console.error;
  console.error = () => {};
  let r;
  try {
    r = await mod.registrarAuditoria(EVENTO);
  } finally {
    console.error = originalErro;
  }
  assert.match(r.erro, /CAUSA_ORIGINAL/);
});

test('evento sem acao/recurso é recusado sem contar como perda de trilha', async () => {
  const mod = carregarComPostgrest(async () => {});
  mod._zerarEstatisticasAuditoria();
  const originalErro = console.error;
  console.error = () => {};
  let r;
  try {
    r = await mod.registrarAuditoria({ acao: '', recurso: '' });
  } finally {
    console.error = originalErro;
  }
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.erro, 'EVENTO_INVALIDO');
  assert.strictEqual(mod.estatisticasAuditoria().total, 0);
});
