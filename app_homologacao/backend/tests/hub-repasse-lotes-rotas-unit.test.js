/**
 * Testes unitários — routes/hub-repasse-lotes.js (F5, PLANO-F5-LOTE-REPASSE §3.2).
 * Mesma técnica de hub-adiantamentos-rotas-unit.test.js: express real +
 * accessToken JWT real, mock só da camada de dados via Module._load.
 *   node --test tests/hub-repasse-lotes-rotas-unit.test.js
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-unit-hub-repasse';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');

const PERMS = new Set([
  'adiantamentos.pagamentos_consultar', 'adiantamentos.lote_criar', 'adiantamentos.exportar',
  'adiantamentos.reprocessar', 'adiantamentos.pagamento_confirmar',
]);
let permissoes = new Set(PERMS);
let modulosAtivos = new Set(['adiantamentos']);
let chamadas = [];
let respostas = {}; // chave (caminho sem querystring) -> valor ou função(body) ; Error lança

function raise(msg, detail) {
  const e = new Error(msg);
  e.status = 400;
  e.body = JSON.stringify({ code: 'P0001', message: msg, details: detail ?? null });
  return e;
}

async function fakePostgrest(endpoint, method, body) {
  chamadas.push({ endpoint, method, body });
  const chave = endpoint.split('?')[0];
  const r = respostas[chave];
  if (r === undefined) throw new Error(`mock não suporta: ${endpoint}`);
  const v = typeof r === 'function' ? r(body, endpoint) : r;
  if (v instanceof Error) throw v;
  return v;
}

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../lib/hub-rbac-cache') {
    return {
      obterPermissoesEfetivas: async () => permissoes,
      obterPermissoesEfetivasPorEntidade: async () => permissoes,
      obterModulosAtivosPorEntidade: async () => modulosAtivos,
    };
  }
  if (request === './grupo') return { mesmoGrupoQue: async (id, _r, cache) => { cache.ids = new Set([6, 7]); return true; } };
  if (request === '../lib/hub-postgrest') return { hubPostgrestRequest: async (...a) => fakePostgrest(...a) };
  if (request === '../lib/hub-postgrest-lotes') return { buscarEmLotes: async () => [] };
  if (request === '../lib/hub-auditoria') return { registrarAuditoria: async () => ({ ok: true }) };
  return originalLoad.apply(this, arguments);
};

const express = require('express');
const cookieParser = require('cookie-parser');
const repasse = require('../routes/hub-repasse-lotes.js');
const { CABECALHO_ESPERADO, XLSX_MIME } = require('../lib/adiantamento-retorno-transfeera');
const XLSX = require('xlsx');

Module._load = originalLoad;

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1/adiantamentos/repasse', repasse.router);

let server;
let baseUrl;
const BASE = '/api/v1/adiantamentos/repasse';

function request(method, path, { body, cookie, raw, contentType } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const bodyStr = raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined);
    const headers = {};
    if (bodyStr !== undefined) {
      // `contentType: null` = sem cabeçalho nenhum.
      if (contentType !== null) headers['Content-Type'] = contentType || 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    if (cookie) headers.Cookie = cookie;
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const ct = res.headers['content-type'] || '';
        let parsed = buf;
        if (ct.includes('application/json')) { try { parsed = JSON.parse(buf.toString('utf8')); } catch { parsed = buf.toString('utf8'); } }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

let sub = 9000;
function cookie() {
  return `hub_accessToken=${jwt.sign({ sub: sub++, entidade_ativa: 6 }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' })}`;
}

before(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => {
  permissoes = new Set(PERMS);
  modulosAtivos = new Set(['adiantamentos']);
  chamadas = [];
  respostas = {};
});

const UUID = '3f2b8c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b';
const LOTE_ROW = { id: 77, id_empresa: 6, status: 'EXPORTADO', criado_por: 1, criado_em: '2026-10-12T10:00:00Z', quantidade: 2, valor_total: '300.00', downloads: 1 };

// ── Puros ────────────────────────────────────────────────────────────────
describe('traduzirErroRpc', () => {
  const cod = (c, detail) => repasse.traduzirErroRpc(raise(c, detail));
  test('mapeia cada código para o status do contrato', () => {
    assert.equal(cod('PREVIA_DESATUALIZADA').status, 409);
    assert.equal(cod('TRANSICAO_INVALIDA').status, 409);
    assert.equal(cod('PERMISSAO_NEGADA').status, 403);
    assert.equal(cod('NAO_ENCONTRADA').status, 404);
    assert.equal(cod('LOTE_ACIMA_DO_LIMITE').status, 422);
    assert.equal(cod('MOTIVO_OBRIGATORIO').status, 400);
  });
  test('ITENS_EM_OUTRO_LOTE -> 409 com os pares no corpo', () => {
    const t = cod('ITENS_EM_OUTRO_LOTE', '5:10,6:11');
    assert.equal(t.status, 409);
    assert.deepEqual(t.corpo.ids, [{ apuracaoId: 5, entregadorId: 10 }, { apuracaoId: 6, entregadorId: 11 }]);
  });
  test('erro desconhecido -> null (vira 500)', () => {
    assert.equal(repasse.traduzirErroRpc(new Error('boom')), null);
  });
});

describe('sanearMotivoDoArquivo', () => {
  test('motivo curto/vazio é completado, não recusado; longo é cortado em 500', () => {
    assert.match(repasse.sanearMotivoDoArquivo('AB'), /motivo não informado/);
    assert.match(repasse.sanearMotivoDoArquivo(''), /motivo não informado/);
    assert.equal(repasse.sanearMotivoDoArquivo('x'.repeat(900)).length, 500);
    assert.equal(repasse.sanearMotivoDoArquivo('  Conta encerrada '), 'Conta encerrada');
  });
});

describe('casarRetornoRepasse (prefixo REP)', () => {
  const linha = (id, status, valor) => ({ idIntegracao: id, status, statusConhecido: true, valorCentavos: valor, motivoFalha: '' });
  const itens = [
    { id: 41, col_id_integracao: 'REP-000041', situacao: 'incluido', valor: '100.00' },
    { id: 42, col_id_integracao: 'REP-000042', situacao: 'incluido', valor: '200.00' },
  ];
  test('REP-<id> casa e devolve o id do ITEM em solicitacaoId', () => {
    const r = repasse.casarRetornoRepasse([linha('REP-000041', 'Finalizada', 10000), linha('REP-000042', 'Finalizada', 20000)], itens);
    assert.deepEqual(r.aplicaveis.map((a) => a.solicitacaoId).sort(), [41, 42]);
    assert.equal(r.faltantes.length, 0);
  });
  test('valor ambíguo (1.234) é recusado mesmo se o valor lido bater com o item', () => {
    const ambigua = { ...linha('REP-000041', 'Finalizada', 123), valorAmbiguoTexto: '1.234' };
    const r = repasse.casarRetornoRepasse([ambigua], [{ id: 41, col_id_integracao: 'REP-000041', situacao: 'incluido', valor: '1.23' }]);
    assert.equal(r.aplicaveis.length, 0);
    assert.equal(r.ignoradas[0].motivo, 'VALOR_AMBIGUO:1.234');
  });
  test('linha ADV-<id> não casa (ID_INTEGRACAO_INVALIDO) e o item vira faltante', () => {
    const r = repasse.casarRetornoRepasse([linha('ADV-000041', 'Finalizada', 10000)], itens);
    assert.equal(r.aplicaveis.length, 0);
    assert.equal(r.ignoradas[0].motivo, 'ID_INTEGRACAO_INVALIDO');
    assert.deepEqual(r.faltantes.sort(), [41, 42]);
  });
});

describe('montagem de payload', () => {
  test('motivoParesInvalidos: cardinalidade, vazio, tipo, par repetido nomeado; sem teto', () => {
    assert.equal(repasse.motivoParesInvalidos([1, 2], [3, 4]), null);
    assert.equal(repasse.motivoParesInvalidos([1, 1], [3, 4]), null, 'mesma apuração, entregadores diferentes é válido');
    assert.equal(repasse.motivoParesInvalidos([1, 2], [3]), 'itens');
    assert.equal(repasse.motivoParesInvalidos([], []), 'itens');
    assert.equal(repasse.motivoParesInvalidos(undefined, [1]), 'itens');
    assert.equal(repasse.motivoParesInvalidos([1, 0], [1, 1]), 'itens');
    assert.equal(repasse.motivoParesInvalidos(['1'], [1]), 'itens');
    assert.match(repasse.motivoParesInvalidos([5, 6, 5], [9, 9, 9]), /par 5:9 .*repetido/);
    const muitos = Array.from({ length: 5001 }, (_, i) => i + 1);
    assert.equal(repasse.motivoParesInvalidos(muitos, muitos), null);
  });
  test('montarRespostaPrevia separa aptas e bloqueadas (com motivo) e soma em CENTAVOS (não em float)', () => {
    const base = { apuracao_id: 1, periodo_inicio: '2026-10-05', periodo_fim: '2026-10-11', apta: true, motivo_pendencia: null };
    // 3 x 0.145: em centavos (meio-centavo arredonda p/ cima, como o banco) = 15+15+15 = 0.45; em float = 0.435 -> "0.43".
    const r = montarComTres();
    function montarComTres() {
      return repasse.montarRespostaPrevia([
        { ...base, entregador_id: 1, entregador_nome: 'A', valor_pago: '0.145' },
        { ...base, entregador_id: 2, entregador_nome: 'B', valor_pago: '0.145' },
        { ...base, entregador_id: 3, entregador_nome: 'C', valor_pago: '0.145' },
        { ...base, entregador_id: 4, entregador_nome: 'D', valor_pago: '50.00', apta: false, motivo_pendencia: 'NOTA_PENDENTE' },
      ]);
    }
    assert.equal(r.quantidadeApta, 3);
    assert.equal(r.totalApto, '0.45');
    assert.equal(r.bloqueadas[0].motivo, 'NOTA_PENDENTE');
  });
  test('nomeArquivoRepasse', () => {
    assert.equal(repasse.nomeArquivoRepasse('2026-10-12', 7), 'transfeera_repasse_2026-10-12_lote-000007.xlsx');
  });
});

// ── HTTP ─────────────────────────────────────────────────────────────────
describe('guarda e validação de id', () => {
  test('sem módulo ativo -> 403', async () => {
    modulosAtivos = new Set();
    const r = await request('GET', `${BASE}/lotes`, { cookie: cookie() });
    assert.equal(r.status, 403);
  });
  test('permissão errada por rota: arquivo exige exportar', async () => {
    permissoes = new Set(['adiantamentos.pagamentos_consultar']);
    const r = await request('GET', `${BASE}/lotes/77/arquivo`, { cookie: cookie() });
    assert.equal(r.status, 403);
    assert.equal(r.body.erro, 'PERMISSAO_NEGADA');
  });
  test('retorno: sem módulo ou sem permissão a recusa vem ANTES do parser (10 MB+ não vira 413)', async () => {
    const grande = { raw: Buffer.alloc(10 * 1024 * 1024 + 1024, 0x50), contentType: XLSX_MIME };
    modulosAtivos = new Set();
    assert.equal((await request('POST', `${BASE}/lotes/77/retorno`, { ...grande, cookie: cookie() })).status, 403);
    modulosAtivos = new Set(['adiantamentos']);
    permissoes = new Set(['adiantamentos.pagamentos_consultar']);
    assert.equal((await request('POST', `${BASE}/lotes/77/retorno`, { ...grande, cookie: cookie() })).status, 403);
  });
  test('id não numérico -> 404 sem tocar o banco', async () => {
    const r = await request('GET', `${BASE}/lotes/abc`, { cookie: cookie() });
    assert.equal(r.status, 404);
    assert.equal(chamadas.length, 0);
  });
});

describe('escopo e segredo de leitura', () => {
  test('GET /lotes/:id filtra por id_empresa, não seleciona `arquivo` e 404 quando fora do escopo', async () => {
    respostas.RepasseLote = [];
    const r = await request('GET', `${BASE}/lotes/77`, { cookie: cookie() });
    assert.equal(r.status, 404);
    assert.match(chamadas[0].endpoint, /id_empresa=in\.\(6,7\)/);
    assert.ok(!/[,=]arquivo(,|$|&)/.test(chamadas[0].endpoint), 'select não pode conter a coluna arquivo');
  });
  test('GET /lotes/:id devolve itens com conta mascarada', async () => {
    respostas.RepasseLote = [LOTE_ROW];
    respostas.RepasseLoteItem = [{ id: 1, apuracao_id: 5, entregador_id: 9, col_nome: 'A', col_documento: '12345678901', col_conta: '00012345', col_digito: '7', col_agencia: '1', col_banco: 'B', col_tipo_conta: 'C', valor: '100.00', col_id_integracao: 'REP-000001', situacao: 'incluido' }];
    const r = await request('GET', `${BASE}/lotes/77`, { cookie: cookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.itens[0].apuracaoId, 5);
    assert.ok(!JSON.stringify(r.body).includes('00012345'));
  });
  test('arquivo de lote fora do escopo -> 404 e a RPC de download NÃO é chamada', async () => {
    respostas.RepasseLote = [];
    const r = await request('GET', `${BASE}/lotes/77/arquivo`, { cookie: cookie() });
    assert.equal(r.status, 404);
    assert.ok(!chamadas.some((c) => c.endpoint === 'rpc/hub_repasse_lote_download'));
  });
});

describe('POST /lotes', () => {
  const corpo = { apuracoes: [5], entregadores: [9], quantidadeEsperada: 1, totalEsperado: '100.00', chaveIdempotencia: UUID };
  test('chave que não é uuid -> 400', async () => {
    const r = await request('POST', `${BASE}/lotes`, { body: { ...corpo, chaveIdempotencia: 'abc' }, cookie: cookie() });
    assert.equal(r.status, 400);
  });
  test('PREVIA_DESATUALIZADA -> 409; ITENS_EM_OUTRO_LOTE -> 409 com ids', async () => {
    respostas['rpc/hub_repasse_lote_criar'] = raise('PREVIA_DESATUALIZADA');
    assert.equal((await request('POST', `${BASE}/lotes`, { body: corpo, cookie: cookie() })).status, 409);
    respostas['rpc/hub_repasse_lote_criar'] = raise('ITENS_EM_OUTRO_LOTE', '5:9');
    const r = await request('POST', `${BASE}/lotes`, { body: corpo, cookie: cookie() });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body.ids, [{ apuracaoId: 5, entregadorId: 9 }]);
  });
  test('cria: passa arrays posicionais, gera XLSX com REP-, grava via RPC com p_itens e devolve 201', async () => {
    respostas['rpc/hub_repasse_lote_criar'] = [{ id: 77, status: 'GERANDO', quantidade: 1, valor_total: '100.00', reutilizado: false }];
    respostas.RepasseLoteItem = [{ id: 1, col_nome: 'Joao da Silva Teste', col_documento: '123.456.789-01', col_email: '', col_banco: 'Banco', col_agencia: '1234', col_conta: '00012345', col_digito: '7', col_tipo_conta: 'Conta Corrente', valor: '100.00', col_id_integracao: 'REP-000001', col_data_agendamento: null, col_descricao_pix: 'Repasse {data_producao:DD.MM.AA} - {nome}', apuracao: { periodo_fim: '2026-10-11' } }];
    respostas['rpc/hub_repasse_lote_arquivo'] = [{ id: 77, status: 'GERADO' }];
    respostas.RepasseLote = [{ ...LOTE_ROW, status: 'GERADO' }];
    const r = await request('POST', `${BASE}/lotes`, { body: corpo, cookie: cookie() });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const criar = chamadas.find((c) => c.endpoint === 'rpc/hub_repasse_lote_criar');
    assert.deepEqual(criar.body, { p_apuracoes: [5], p_entregadores: [9], p_quantidade_esperada: 1, p_total_esperado: '100.00', p_chave: UUID });
    const arq = chamadas.find((c) => c.endpoint === 'rpc/hub_repasse_lote_arquivo').body;
    assert.deepEqual(Object.keys(arq).sort(), ['p_arquivo', 'p_bytes', 'p_itens', 'p_lote_id', 'p_nome', 'p_sha256']);
    assert.match(arq.p_nome, /^transfeera_repasse_\d{4}-\d{2}-\d{2}_lote-000077\.xlsx$/);
    assert.equal(arq.p_bytes, Buffer.from(arq.p_arquivo, 'base64').length);
  });
});

describe('POST /lotes/:id/retorno', () => {
  const linha = (over) => {
    const base = Object.fromEntries(CABECALHO_ESPERADO.map((c) => [c, '']));
    return { ...base, 'ID integração': 'REP-000041', Status: 'FINALIZADO', Valor: '100,00', ...over };
  };
  /** XLSX (Buffer) no contrato de 21 colunas; `cabecalho` permite quebrá-lo. */
  const xlsx = (linhas, cabecalho = CABECALHO_ESPERADO) => {
    const aoa = [cabecalho, ...linhas.map((l) => CABECALHO_ESPERADO.map((c) => l[c]))];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Transferências');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  };
  const corpo = (linhas) => ({ raw: xlsx(linhas), contentType: XLSX_MIME });
  const itens = [
    { id: 41, col_id_integracao: 'REP-000041', situacao: 'incluido', valor: '100.00' },
    { id: 42, col_id_integracao: 'REP-000042', situacao: 'incluido', valor: '200.00' },
  ];

  test('content-type JSON (corpo não é XLSX) -> 400 FORMATO_INVALIDO, nunca 500', async () => {
    const r = await request('POST', `${BASE}/lotes/77/retorno`, { body: { csv: 'x' }, cookie: cookie() });
    assert.equal(r.status, 400);
    assert.equal(r.body.erro, 'ARQUIVO_INVALIDO');
    assert.equal(r.body.motivo, 'FORMATO_INVALIDO');
  });
  for (const [rotulo, contentType] of [
    ['text/csv', 'text/csv'], ['text/plain', 'text/plain'],
    ['application/octet-stream', 'application/octet-stream'], ['ausente', null],
  ]) {
    test(`Content-Type ${rotulo} -> 400 ARQUIVO_INVALIDO/FORMATO_INVALIDO`, async () => {
      respostas.RepasseLoteItem = itens;
      const r = await request('POST', `${BASE}/lotes/77/retorno`, { raw: xlsx([linha({})]), contentType, cookie: cookie() });
      assert.equal(r.status, 400);
      assert.equal(r.body.erro, 'ARQUIVO_INVALIDO');
      assert.equal(r.body.motivo, 'FORMATO_INVALIDO');
      assert.ok(!chamadas.some((c) => c.endpoint.includes('hub_repasse_lote_confirmar')));
    });
  }
  test('corpo vazio com o mime XLSX -> 400 FORMATO_INVALIDO', async () => {
    const r = await request('POST', `${BASE}/lotes/77/retorno`, { raw: Buffer.alloc(0), contentType: XLSX_MIME, cookie: cookie() });
    assert.equal(r.status, 400);
    assert.equal(r.body.motivo, 'FORMATO_INVALIDO');
  });
  test('XLSX sem o cabeçalho esperado -> 400 ARQUIVO_INVALIDO/CABECALHO_INVALIDO', async () => {
    const r = await request('POST', `${BASE}/lotes/77/retorno`, {
      raw: xlsx([linha({})], ['a', 'b']), contentType: XLSX_MIME, cookie: cookie(),
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.erro, 'ARQUIVO_INVALIDO');
    assert.equal(r.body.motivo, 'CABECALHO_INVALIDO');
  });
  test('corpo acima de 10 MB -> 413 (paridade com a rota CSV anterior)', async () => {
    const r = await request('POST', `${BASE}/lotes/77/retorno`, {
      raw: Buffer.alloc(10 * 1024 * 1024 + 1024, 0x50), contentType: XLSX_MIME, cookie: cookie(),
    });
    assert.equal(r.status, 413);
  });
  test('XLSX acima de 100 KB chega à rota (parser binário próprio; o JSON global não se aplica)', async () => {
    respostas.RepasseLoteItem = [];
    // hex aleatório: não comprime, então o arquivo passa mesmo de 100 KB.
    const aleatorio = () => require('node:crypto').randomBytes(15_000).toString('hex');
    const grande = xlsx(Array.from({ length: 12 }, (_, i) => linha({ 'ID integração': `REP-9${i}`, Motivo: aleatorio() })));
    assert.ok(grande.length > 100 * 1024, `fixture de teste com ${grande.length} bytes`);
    const r = await request('POST', `${BASE}/lotes/77/retorno`, { raw: grande, contentType: XLSX_MIME, cookie: cookie() });
    assert.equal(r.status, 404); // passou o parse e parou no "lote sem itens no escopo"
  });
  test('ID ADV-... em lote de repasse -> nenhuma linha aplicada (US2-AS2)', async () => {
    respostas.RepasseLoteItem = [{ id: 41, col_id_integracao: 'REP-000041', situacao: 'incluido', valor: '100.00' }];
    const r = await request('POST', `${BASE}/lotes/77/retorno`, { ...corpo([linha({ 'ID integração': 'ADV-000041' })]), cookie: cookie() });
    assert.equal(r.status, 409); // o item REP-41 ficou sem cobertura: RETORNO_INCOMPLETO
    assert.deepEqual(r.body.faltantes, [41]);
    assert.ok(!chamadas.some((c) => c.endpoint.includes('hub_repasse_lote_confirmar')));
  });
  test('fixture real (IDs ADV-...) em lote de repasse via HTTP: nada aplicado, itens REP ficam faltantes', async () => {
    const bytes = require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 'retorno-transfeera-21col-exemplo.xlsx'));
    respostas.RepasseLoteItem = itens;
    const r = await request('POST', `${BASE}/lotes/77/retorno`, { raw: bytes, contentType: XLSX_MIME, cookie: cookie() });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body.faltantes, [41, 42]);
    assert.ok(!chamadas.some((c) => c.endpoint.includes('hub_repasse_lote_confirmar')));
  });
  test('faltante -> 409 RETORNO_INCOMPLETO com o id do item e nenhuma RPC de escrita', async () => {
    respostas.RepasseLoteItem = itens;
    const r = await request('POST', `${BASE}/lotes/77/retorno`, { ...corpo([linha({})]), cookie: cookie() });
    assert.equal(r.status, 409);
    assert.equal(r.body.erro, 'RETORNO_INCOMPLETO');
    assert.deepEqual(r.body.faltantes, [42]);
    assert.ok(!chamadas.some((c) => c.endpoint.includes('hub_repasse_lote_confirmar')));
  });
  // Mesmo defeito do adiantamento: o diagnóstico precisa atravessar o 409 por HTTP.
  test('célula de valor ambígua (1.234) -> 409 RETORNO_INCOMPLETO COM ignoradasPorMotivo VALOR_AMBIGUO, sem linhas cruas', async () => {
    respostas.RepasseLoteItem = [{ id: 41, col_id_integracao: 'REP-000041', situacao: 'incluido', valor: '1.23' }];
    const r = await request('POST', `${BASE}/lotes/77/retorno`, { ...corpo([linha({ Valor: '1.234' })]), cookie: cookie() });
    assert.equal(r.status, 409);
    assert.equal(r.body.erro, 'RETORNO_INCOMPLETO');
    assert.deepEqual(r.body.faltantes, [41]);
    assert.deepEqual(r.body.ignoradasPorMotivo, [{ motivo: 'VALOR_AMBIGUO:1.234', total: 1 }]);
    assert.equal(r.body.ignoradas, undefined, 'linhas cruas nunca saem');
    assert.ok(!chamadas.some((c) => c.endpoint.includes('hub_repasse_lote_confirmar')));
  });
  test('UMA só chamada atômica: p_falhas com as devoluções (motivo saneado, id do ITEM) e p_origem retorno', async () => {
    respostas.RepasseLoteItem = itens;
    respostas['rpc/hub_repasse_lote_confirmar'] = [{ id: 77, status: 'CONCLUIDO_COM_FALHAS' }];
    const r = await request('POST', `${BASE}/lotes/77/retorno`, {
      ...corpo([linha({}), linha({ 'ID integração': 'REP-000042', Status: 'Devolvida', Valor: '200,00', Motivo: 'XY' })]),
      cookie: cookie(),
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.aplicadas, 2);
    const escritas = chamadas.filter((c) => c.endpoint.startsWith('rpc/hub_repasse_lote_'));
    assert.equal(escritas.length, 1);
    const b = escritas[0].body;
    assert.equal(b.p_lote_id, 77);
    assert.equal(b.p_origem, 'retorno');
    assert.equal(b.p_falhas.length, 1);
    assert.equal(b.p_falhas[0].id, 42);
    assert.match(b.p_falhas[0].motivo, /motivo não informado/);
  });
  test('ITEM_FORA_DO_LOTE -> 400 e TRANSICAO_INVALIDA -> 409', async () => {
    respostas.RepasseLoteItem = itens;
    const xlsxOk = corpo([linha({}), linha({ 'ID integração': 'REP-000042', Valor: '200,00' })]);
    respostas['rpc/hub_repasse_lote_confirmar'] = raise('ITEM_FORA_DO_LOTE');
    assert.equal((await request('POST', `${BASE}/lotes/77/retorno`, { ...xlsxOk, cookie: cookie() })).status, 400);
    respostas['rpc/hub_repasse_lote_confirmar'] = raise('TRANSICAO_INVALIDA');
    assert.equal((await request('POST', `${BASE}/lotes/77/retorno`, { ...xlsxOk, cookie: cookie() })).status, 409);
  });
  test('erro inesperado do parser não vaza e.message no log', async () => {
    respostas.RepasseLoteItem = itens;
    const logs = [];
    const orig = console.error;
    const origSheet = XLSX.utils.sheet_to_json;
    console.error = (...a) => { logs.push(a.map(String).join(' ')); };
    XLSX.utils.sheet_to_json = () => { throw new TypeError('SEGREDO-NA-MENSAGEM-DO-PARSER'); };
    let r;
    try {
      r = await request('POST', `${BASE}/lotes/77/retorno`, { ...corpo([linha({})]), cookie: cookie() });
    } finally {
      console.error = orig;
      XLSX.utils.sheet_to_json = origSheet;
    }
    assert.equal(r.status, 400);
    assert.ok(!logs.some((l) => l.includes('SEGREDO-NA-MENSAGEM-DO-PARSER')), `log vazou: ${logs.join(' | ')}`);
  });
});

describe('POST /lotes/:id/confirmacao e cancelar', () => {
  test('confirmação: falha em item não `incluido` -> 400 sem RPC; válida = UMA chamada com p_falhas e origem manual', async () => {
    respostas.RepasseLoteItem = [{ id: 1, situacao: 'incluido' }, { id: 2, situacao: 'incluido' }, { id: 3, situacao: 'pago' }];
    respostas['rpc/hub_repasse_lote_confirmar'] = [{ id: 77, status: 'CONCLUIDO_COM_FALHAS' }];
    respostas.RepasseLote = [LOTE_ROW];
    const ruim = await request('POST', `${BASE}/lotes/77/confirmacao`, { body: { falhas: [{ id: 3, motivo: 'abc' }] }, cookie: cookie() });
    assert.equal(ruim.status, 400);
    assert.ok(!chamadas.some((c) => c.endpoint === 'rpc/hub_repasse_lote_confirmar'));
    const ok = await request('POST', `${BASE}/lotes/77/confirmacao`, { body: { falhas: [{ id: 2, motivo: 'Conta inválida' }] }, cookie: cookie() });
    assert.equal(ok.status, 200);
    const escritas = chamadas.filter((c) => c.endpoint === 'rpc/hub_repasse_lote_confirmar');
    assert.equal(escritas.length, 1);
    assert.deepEqual(escritas[0].body, { p_lote_id: 77, p_falhas: [{ id: 2, motivo: 'Conta inválida' }], p_origem: 'manual' });
  });
  test('confirmação sem item incluido -> 409 TRANSICAO_INVALIDA', async () => {
    respostas.RepasseLoteItem = [{ id: 3, situacao: 'pago' }];
    const r = await request('POST', `${BASE}/lotes/77/confirmacao`, { body: {}, cookie: cookie() });
    assert.equal(r.status, 409);
  });
  test('cancelar exige motivo (3..500) e traduz TRANSICAO_INVALIDA -> 409', async () => {
    respostas.RepasseLote = [LOTE_ROW];
    assert.equal((await request('POST', `${BASE}/lotes/77/cancelar`, { body: { motivo: 'ab' }, cookie: cookie() })).status, 400);
    respostas['rpc/hub_repasse_lote_cancelar'] = raise('TRANSICAO_INVALIDA');
    assert.equal((await request('POST', `${BASE}/lotes/77/cancelar`, { body: { motivo: 'motivo ok' }, cookie: cookie() })).status, 409);
  });
});

describe('descrição do PIX renderizada no Node', () => {
  const corpo = { apuracoes: [5], entregadores: [9], quantidadeEsperada: 1, totalEsperado: '100.00', chaveIdempotencia: UUID };
  const prepara = (modelo) => {
    respostas['rpc/hub_repasse_lote_criar'] = [{ id: 77, status: 'GERANDO', quantidade: 1, valor_total: '100.00', reutilizado: false }];
    respostas.RepasseLoteItem = [{ id: 1, col_nome: 'Joao da Silva Teste', col_documento: '123.456.789-01', col_email: '', col_banco: 'Banco', col_agencia: '1234', col_conta: '00012345', col_digito: '7', col_tipo_conta: 'Conta Corrente', valor: '100.00', col_id_integracao: 'REP-000001', col_data_agendamento: null, col_descricao_pix: modelo, apuracao: { periodo_fim: '2026-10-11' } }];
    respostas['rpc/hub_repasse_lote_arquivo'] = [{ id: 77, status: 'GERADO' }];
    respostas['rpc/hub_repasse_lote_cancelar'] = [{ id: 77, status: 'CANCELADO' }];
    respostas.RepasseLote = [{ ...LOTE_ROW, status: 'GERADO' }];
  };
  test('modelo + nome + periodo_fim -> texto renderizado na planilha e em p_itens', async () => {
    prepara('Repasse {data_producao:DD.MM.AA} - {nome}');
    const r = await request('POST', `${BASE}/lotes`, { body: corpo, cookie: cookie() });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const arq = chamadas.find((c) => c.endpoint === 'rpc/hub_repasse_lote_arquivo').body;
    const esperado = 'Repasse 11.10.26 - Joao da Silva Teste';
    assert.deepEqual(arq.p_itens, [{ id: 1, descricao: esperado }]);
    const XLSX = require('xlsx');
    const wb = XLSX.read(Buffer.from(arq.p_arquivo, 'base64'), { type: 'buffer' });
    const linhas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    assert.ok(linhas[2].includes(esperado), 'planilha deve conter a descrição renderizada');
    assert.ok(!JSON.stringify(linhas).includes('{nome}'));
  });
  test('placeholder não permitido ({cpf}) cancela o lote e NÃO grava arquivo', async () => {
    prepara('Repasse {cpf} - {nome}');
    const r = await request('POST', `${BASE}/lotes`, { body: corpo, cookie: cookie() });
    assert.equal(r.status, 500);
    assert.equal(r.body.erro, 'FALHA_GERACAO_ARQUIVO');
    assert.ok(!chamadas.some((c) => c.endpoint === 'rpc/hub_repasse_lote_arquivo'));
    const canc = chamadas.find((c) => c.endpoint === 'rpc/hub_repasse_lote_cancelar');
    assert.equal(canc.body.p_motivo, 'falha_geracao');
  });
});

describe('POST /lotes — limite, corrida de idempotência', () => {
  const corpo = { apuracoes: [5], entregadores: [9], quantidadeEsperada: 1, totalEsperado: '100.00', chaveIdempotencia: UUID };
  test('acima de 5000 itens: o Node não barra; a RPC recusa e o cliente recebe 422 LOTE_ACIMA_DO_LIMITE', async () => {
    respostas['rpc/hub_repasse_lote_criar'] = raise('LOTE_ACIMA_DO_LIMITE');
    const n = Array.from({ length: 5001 }, (_, i) => i + 1);
    const r = await request('POST', `${BASE}/lotes`, { body: { ...corpo, apuracoes: n, entregadores: n, quantidadeEsperada: 5001 }, cookie: cookie() });
    assert.equal(r.status, 422);
    assert.equal(r.body.erro, 'LOTE_ACIMA_DO_LIMITE');
    assert.equal(chamadas.filter((c) => c.endpoint === 'rpc/hub_repasse_lote_criar').length, 1);
  });
  test('5000 pares passam pelo express.json() global (< 100 KB) e chegam à RPC sem conversão', async () => {
    const ap = Array.from({ length: 5000 }, (_, i) => 100000 + i);
    const en = Array.from({ length: 5000 }, (_, i) => 200000 + i);
    const payload = { ...corpo, apuracoes: ap, entregadores: en, quantidadeEsperada: 5000, totalEsperado: '5000.00' };
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    assert.ok(bytes < 100 * 1024, `corpo de 5000 pares tem ${bytes} B; o express.json() global recusa acima de 100 KB`);
    respostas['rpc/hub_repasse_lote_criar'] = raise('PREVIA_DESATUALIZADA');
    const r = await request('POST', `${BASE}/lotes`, { body: payload, cookie: cookie() });
    assert.equal(r.status, 409, 'chegou à RPC (um 413 significaria que o formato engordou)');
    const b = chamadas.find((c) => c.endpoint === 'rpc/hub_repasse_lote_criar').body;
    assert.equal(b.p_apuracoes.length, 5000);
    assert.equal(b.p_entregadores[4999], 204999);
  });
  test('par repetido -> 400 nomeando o par, sem RPC; arrays de tamanhos diferentes -> 400', async () => {
    const r = await request('POST', `${BASE}/lotes`, { body: { ...corpo, apuracoes: [5, 6, 5], entregadores: [9, 9, 9] }, cookie: cookie() });
    assert.equal(r.status, 400);
    assert.match(r.body.motivo, /par 5:9/);
    const r2 = await request('POST', `${BASE}/lotes`, { body: { ...corpo, apuracoes: [5, 6], entregadores: [9] }, cookie: cookie() });
    assert.equal(r2.status, 400);
    assert.ok(!chamadas.some((c) => c.endpoint === 'rpc/hub_repasse_lote_criar'));
  });
  test('23505 (perdeu a corrida na UNIQUE): 2ª tentativa devolve o lote do vencedor (200, sem gerar arquivo)', async () => {
    let n = 0;
    respostas['rpc/hub_repasse_lote_criar'] = () => {
      n += 1;
      if (n === 1) { const e = new Error('duplicate key 23505'); e.body = '{"code":"23505"}'; return e; }
      return [{ id: 77, status: 'GERADO', quantidade: 1, valor_total: '100.00', reutilizado: true }];
    };
    respostas.RepasseLote = [{ ...LOTE_ROW, status: 'GERADO' }];
    const r = await request('POST', `${BASE}/lotes`, { body: corpo, cookie: cookie() });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(n, 2);
    assert.ok(!chamadas.some((c) => c.endpoint === 'rpc/hub_repasse_lote_arquivo'));
  });
  test('23505 nas duas tentativas: desiste (500), sem laço', async () => {
    respostas['rpc/hub_repasse_lote_criar'] = () => { const e = new Error('dup 23505'); e.body = '{"code":"23505"}'; return e; };
    const r = await request('POST', `${BASE}/lotes`, { body: corpo, cookie: cookie() });
    assert.equal(r.status, 500);
    assert.equal(chamadas.filter((c) => c.endpoint === 'rpc/hub_repasse_lote_criar').length, 2);
  });
});

describe('POST /lotes/previa por HTTP', () => {
  const rowApta = { apuracao_id: 1, entregador_id: 1, entregador_nome: 'A', periodo_inicio: '2026-10-05', periodo_fim: '2026-10-11', valor_pago: '10.00', apta: true, motivo_pendencia: null };
  test('sem `itens`: manda p_apuracoes/p_entregadores null (todas as elegíveis) e responde 200', async () => {
    respostas['rpc/hub_repasse_lote_previa'] = [rowApta];
    const r = await request('POST', `${BASE}/lotes/previa`, { body: {}, cookie: cookie() });
    assert.equal(r.status, 200);
    assert.deepEqual(chamadas[0].body, { p_apuracoes: null, p_entregadores: null });
    assert.equal(r.body.quantidadeApta, 1);
  });
  test('com os dois arrays: repassa à RPC; arrays inválidos -> 400 motivo itens, sem RPC', async () => {
    respostas['rpc/hub_repasse_lote_previa'] = [rowApta];
    const ok = await request('POST', `${BASE}/lotes/previa`, { body: { apuracoes: [1], entregadores: [1] }, cookie: cookie() });
    assert.equal(ok.status, 200);
    assert.deepEqual(chamadas[0].body, { p_apuracoes: [1], p_entregadores: [1] });
    chamadas = [];
    const ruim = await request('POST', `${BASE}/lotes/previa`, { body: { apuracoes: [], entregadores: [] }, cookie: cookie() });
    assert.equal(ruim.status, 400);
    assert.equal(ruim.body.motivo, 'itens');
    assert.equal(chamadas.length, 0);
  });
  test('só UM dos dois arrays -> 400; par repetido -> 400 nomeado; nunca chega à RPC', async () => {
    for (const body of [{ apuracoes: [1] }, { entregadores: [1] }, { apuracoes: [1, 2], entregadores: [3] }]) {
      const r = await request('POST', `${BASE}/lotes/previa`, { body, cookie: cookie() }); // eslint-disable-line no-await-in-loop
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    const rep = await request('POST', `${BASE}/lotes/previa`, { body: { apuracoes: [5, 5], entregadores: [9, 9] }, cookie: cookie() });
    assert.equal(rep.status, 400);
    assert.match(rep.body.motivo, /par 5:9/);
    assert.equal(chamadas.length, 0);
  });
  test('5000 pares passam pelo express.json() global (< 100 KB) e chegam à RPC sem conversão', async () => {
    const ap = Array.from({ length: 5000 }, (_, i) => 100000 + i);
    const en = Array.from({ length: 5000 }, (_, i) => 200000 + i);
    const bytes = Buffer.byteLength(JSON.stringify({ apuracoes: ap, entregadores: en }));
    assert.ok(bytes < 100 * 1024, `corpo de 5000 pares tem ${bytes} B; o express.json() global recusa acima de 100 KB`);
    respostas['rpc/hub_repasse_lote_previa'] = [];
    const r = await request('POST', `${BASE}/lotes/previa`, { body: { apuracoes: ap, entregadores: en }, cookie: cookie() });
    assert.equal(r.status, 200, 'um 413 significaria que o formato engordou');
    assert.equal(chamadas[0].body.p_apuracoes.length, 5000);
  });
  test('o limitador da prévia aguenta navegação repetida (>30 chamadas do mesmo usuário)', async () => {
    respostas['rpc/hub_repasse_lote_previa'] = [];
    const c = cookie();
    let ultimo;
    for (let i = 0; i < 40; i += 1) ultimo = await request('POST', `${BASE}/lotes/previa`, { body: {}, cookie: c }); // eslint-disable-line no-await-in-loop
    assert.equal(ultimo.status, 200);
  });
});

describe('GET /lotes', () => {
  test('lista com escopo, paginação e total; status fora da allowlist -> 400', async () => {
    let endpointVisto;
    respostas.RepasseLote = (_b, ep) => { endpointVisto = ep; return { data: [LOTE_ROW], total: 1 }; };
    const r = await request('GET', `${BASE}/lotes?status=exportado,xx&page=2&pageSize=5`, { cookie: cookie() });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.total, 1);
    assert.equal(r.body.page, 2);
    assert.equal(r.body.pageSize, 5);
    assert.match(endpointVisto, /id_empresa=in\.\(6,7\)/);
    assert.match(endpointVisto, /status=in\.\(EXPORTADO\)/);
    assert.ok(!/[,=]arquivo(,|$|&)/.test(endpointVisto));
    const ruim = await request('GET', `${BASE}/lotes?status=xx`, { cookie: cookie() });
    assert.equal(ruim.status, 400);
  });
});

describe('GET /lotes/:id/arquivo — integridade', () => {
  const bytes = Buffer.from('conteudo-xlsx-falso');
  const sha = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const download = (shaEnviado) => [{ arquivo_base64: bytes.toString('base64'), sha256: shaEnviado, nome: 'x.xlsx', downloads: 1 }];
  test('sha256 confere -> 200 com os bytes', async () => {
    respostas.RepasseLote = [LOTE_ROW];
    respostas['rpc/hub_repasse_lote_download'] = download(sha);
    const r = await request('GET', `${BASE}/lotes/77/arquivo`, { cookie: cookie() });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, bytes);
  });
  test('sha256 diverge -> 500 e NENHUM byte do arquivo sai', async () => {
    respostas.RepasseLote = [LOTE_ROW];
    respostas['rpc/hub_repasse_lote_download'] = download('0'.repeat(64));
    const r = await request('GET', `${BASE}/lotes/77/arquivo`, { cookie: cookie() });
    assert.equal(r.status, 500);
    assert.ok(!Buffer.isBuffer(r.body) || !r.body.includes(bytes));
  });
});

describe('POST /lotes/:id/confirmacao — id repetido', () => {
  test('mesmo id com dois motivos -> 400 nomeando o id, sem RPC de escrita', async () => {
    respostas.RepasseLoteItem = [{ id: 5, situacao: 'incluido' }, { id: 6, situacao: 'incluido' }];
    const r = await request('POST', `${BASE}/lotes/77/confirmacao`, { body: { falhas: [{ id: 5, motivo: 'motivo A' }, { id: 5, motivo: 'motivo B' }] }, cookie: cookie() });
    assert.equal(r.status, 400);
    assert.equal(r.body.erro, 'DADOS_INVALIDOS');
    assert.match(r.body.motivo, /id 5 repetido/);
    assert.ok(!chamadas.some((c) => c.endpoint === 'rpc/hub_repasse_lote_confirmar'));
  });
});
