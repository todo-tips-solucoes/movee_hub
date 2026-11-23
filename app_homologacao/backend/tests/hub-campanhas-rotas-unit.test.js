'use strict';
/** routes/hub-campanhas.js — node --test tests/hub-campanhas-rotas-unit.test.js */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-unit-hub-campanhas';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const Module = require('module');
const XLSX = require('xlsx');

let permissoes = new Set();
let modulos = new Set(['campanhas']);
let chamadas = [];
let respostas = {};
let auditorias = [];
const TODAS = ['campanhas.consultar', 'campanhas.gerir', 'campanhas.entregar'];

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === '../lib/hub-rbac-cache') {
    return {
      obterPermissoesEfetivas: async () => permissoes,
      obterPermissoesEfetivasPorEntidade: async () => permissoes,
      obterModulosAtivosPorEntidade: async () => modulos,
    };
  }
  if (request === '../lib/hub-postgrest') {
    return {
      hubPostgrestRequest: async (endpoint, method, body, claims) => {
        chamadas.push({ endpoint, method, body, claims });
        const r = respostas[endpoint];
        if (r instanceof Error) throw r;
        return typeof r === 'function' ? r(body) : (r === undefined ? null : r);
      },
    };
  }
  if (request === '../lib/hub-auditoria') {
    return { registrarAuditoria: async (e) => { auditorias.push(e); return { ok: true }; } };
  }
  return originalLoad.apply(this, arguments);
};
const express = require('express');
const cookieParser = require('cookie-parser');
const { router } = require('../routes/hub-campanhas.js');
Module._load = originalLoad;

const app = express();
app.use(express.json()); // igual ao server.js: o parser global NÃO pode atrapalhar a foto
app.use(cookieParser());
app.use('/api/v1/hub/campanhas', router);

let server; let baseUrl; let sub = 9000;
before(async () => { await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); baseUrl = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());
beforeEach(() => { chamadas = []; respostas = {}; auditorias = []; permissoes = new Set(TODAS); modulos = new Set(['campanhas']); });

/** sub novo por chamada: o rate limit é por usuário. */
function cookie(extra = {}, fixoSub) {
  const token = jwt.sign({ sub: fixoSub || sub++, entidade_ativa: 6, ...extra }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
  return `hub_accessToken=${token}`;
}

function req(method, path, { json, raw, contentType, ck = cookie() } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, baseUrl);
    const headers = {};
    let corpo;
    if (json !== undefined) { corpo = Buffer.from(JSON.stringify(json)); headers['Content-Type'] = 'application/json'; }
    if (raw) { corpo = raw; headers['Content-Type'] = contentType; }
    if (corpo) headers['Content-Length'] = corpo.length;
    if (ck) headers.Cookie = ck;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(parts);
        let body = null;
        try { body = JSON.parse(buf.toString()); } catch (_) { body = buf.toString(); }
        resolve({ status: res.statusCode, headers: res.headers, body, raw: buf });
      });
    });
    r.on('error', reject);
    if (corpo) r.write(corpo);
    r.end();
  });
}
const rpcErr = (token) => Object.assign(new Error('x'), { status: 400, body: JSON.stringify({ message: token }) });

const FORM = {
  nome: 'Rei do Jantar', descricao: '', dataInicio: '2026-11-10', dataFim: '2026-11-30', pracas: null, turnos: null, modais: null, minTurnos: 5,
  pesos: { aceitacao: 30, conclusao: 30, tempo: 20, pedidos: 20 }, cortes: { aceitacao: 0.8, conclusao: null, tempo: null, pedidos: null },
  premios: [{ posicaoDe: 1, posicaoAte: 1, tipo: 'objeto', descricao: 'Moto', valorCentavos: 1600000 }], avisar: true,
};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), Buffer.alloc(100)]);

describe('guardas', () => {
  test('sem cookie -> 401; módulo inativo -> 403 MODULO_DESABILITADO', async () => {
    assert.equal((await req('GET', '/api/v1/hub/campanhas', { ck: null })).status, 401);
    modulos = new Set();
    const r = await req('GET', '/api/v1/hub/campanhas');
    assert.deepEqual([r.status, r.body.erro], [403, 'MODULO_DESABILITADO']);
    assert.equal(chamadas.length, 0);
  });

  test('permissão negada em cada rota -> 403 PERMISSAO_NEGADA, sem RPC', async () => {
    const casos = [
      ['GET', '/', 'campanhas.consultar'], ['GET', '/opcoes', 'campanhas.gerir'], ['POST', '/', 'campanhas.gerir'],
      ['PUT', '/1', 'campanhas.gerir'], ['POST', '/1/lancar', 'campanhas.gerir'], ['POST', '/1/cancelar', 'campanhas.gerir'],
      ['POST', '/1/fechar', 'campanhas.gerir'], ['GET', '/1', 'campanhas.consultar'], ['GET', '/1/ranking', 'campanhas.consultar'],
      ['GET', '/1/ranking.csv', 'campanhas.consultar'], ['GET', '/1/vencedores', 'campanhas.consultar'],
      ['POST', '/1/vencedores/1/entrega', 'campanhas.entregar'], ['POST', '/1/premios-dinheiro.xlsx', 'campanhas.entregar'],
      ['PUT', '/1/premios/2/foto', 'campanhas.gerir'], ['GET', '/1/premios/2/foto', 'campanhas.consultar'],
    ];
    for (const [m, p, perm] of casos) {
      permissoes = new Set(TODAS.filter((x) => x !== perm));
      const r = await req(m, `/api/v1/hub/campanhas${p === '/' ? '' : p}`, { json: m === 'GET' ? undefined : {} });
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal(r.body.erro, 'PERMISSAO_NEGADA', `${m} ${p}`);
    }
    assert.equal(chamadas.length, 0);
  });

  test('entidade ativa sempre do token: idEmpresa no corpo/query é ignorado', async () => {
    respostas['rpc/hub_campanha_salvar'] = 12;
    const r = await req('POST', '/api/v1/hub/campanhas?idEmpresa=77', { json: { ...FORM, idEmpresa: 77, id_empresa: 77 } });
    assert.equal(r.status, 201);
    const c = chamadas[0];
    assert.equal(c.body.p_id_empresa, 6);
    assert.deepEqual(c.claims.escopo, [6]);
    assert.equal(JSON.stringify(c.body.p_dados).includes('77'), false);
  });
});

describe('criar / editar / transições', () => {
  test('POST cria (201 {id}, p_id null) e audita; PUT edita (200, p_id da URL)', async () => {
    respostas['rpc/hub_campanha_salvar'] = 12;
    const a = await req('POST', '/api/v1/hub/campanhas', { json: FORM });
    assert.deepEqual([a.status, a.body], [201, { id: 12 }]);
    assert.equal(chamadas[0].body.p_id, null);
    assert.equal(chamadas[0].body.p_dados.pesos.aceitacao, 30);
    const b = await req('PUT', '/api/v1/hub/campanhas/12', { json: FORM });
    assert.deepEqual([b.status, b.body], [200, { id: 12 }]);
    assert.equal(chamadas[1].body.p_id, 12);
    assert.deepEqual(auditorias.map((x) => x.acao), ['campanha.criada', 'campanha.editada']);
    assert.equal(auditorias[0].idEmpresa, 6);
  });

  test('formulário inválido -> 422 {erro,campo} sem RPC (pesos 99, faixas sobrepostas, dinheiro acima do teto)', async () => {
    let r = await req('POST', '/api/v1/hub/campanhas', { json: { ...FORM, pesos: { aceitacao: 30, conclusao: 30, tempo: 20, pedidos: 19 } } });
    assert.deepEqual([r.status, r.body.erro, r.body.campo], [422, 'PESOS_INVALIDOS', 'pesos']);
    const p = (de, ate) => ({ posicaoDe: de, posicaoAte: ate, tipo: 'objeto', descricao: 'x' });
    r = await req('POST', '/api/v1/hub/campanhas', { json: { ...FORM, premios: [p(1, 2), p(2, 3)] } });
    assert.equal(r.body.erro, 'FAIXAS_SOBREPOSTAS');
    r = await req('PUT', '/api/v1/hub/campanhas/1', { json: { ...FORM, premios: [{ posicaoDe: 1, posicaoAte: 1, tipo: 'dinheiro', descricao: 'R$', valorCentavos: 500001 }] } });
    assert.deepEqual([r.status, r.body.erro], [422, 'VALIDACAO']);
    assert.equal(chamadas.length, 0);
  });

  test('lançar: confirmo ausente/false/"true" -> 422 CONFIRMACAO_AUSENTE sem RPC; confirmo:true -> 204 e auditoria', async () => {
    for (const json of [{}, { confirmo: false }, { confirmo: 'true' }]) {
      const r = await req('POST', '/api/v1/hub/campanhas/5/lancar', { json });
      assert.deepEqual([r.status, r.body.erro], [422, 'CONFIRMACAO_AUSENTE']);
    }
    assert.equal(chamadas.length, 0);
    const ok = await req('POST', '/api/v1/hub/campanhas/5/lancar', { json: { confirmo: true } });
    assert.equal(ok.status, 204);
    assert.deepEqual(chamadas[0].body, { p_id: 5 });
    assert.equal(auditorias[0].acao, 'campanha.lancada');
  });

  test('cancelar: motivo 4 e 501 caracteres -> 422; válido -> 204 com p_motivo e auditoria; fechar -> 204', async () => {
    for (const motivo of ['abcd', 'x'.repeat(501), undefined, 42]) {
      assert.equal((await req('POST', '/api/v1/hub/campanhas/5/cancelar', { json: { motivo } })).status, 422);
    }
    assert.equal(chamadas.length, 0);
    assert.equal((await req('POST', '/api/v1/hub/campanhas/5/cancelar', { json: { motivo: '  prêmio errado ' } })).status, 204);
    assert.deepEqual(chamadas[0].body, { p_id: 5, p_motivo: 'prêmio errado' });
    assert.equal((await req('POST', '/api/v1/hub/campanhas/5/fechar')).status, 204);
    assert.deepEqual(auditorias.map((x) => x.acao), ['campanha.cancelada', 'campanha.fechada']);
  });

  const esperado = {
    CAMPANHA_NAO_ENCONTRADA: 404, CAMPANHA_IMUTAVEL: 409, CAMPANHA_SITUACAO_INVALIDA: 409, TETO_CAMPANHAS_ATIVAS: 409,
    PEDIDOS_SEM_COBERTURA: 422, INICIO_NO_PASSADO: 422, FAIXAS_SOBREPOSTAS: 422, PESOS_INVALIDOS: 422, CORTE_SEM_PESO: 422,
    OPCAO_DESCONHECIDA: 422, FECHAMENTO_ANTECIPADO: 409, FOTO_INVALIDA: 422,
  };
  for (const [token, status] of Object.entries(esperado)) {
    test(`token ${token} da RPC -> ${status} (lançar)`, async () => {
      respostas['rpc/hub_campanha_lancar'] = rpcErr(token);
      const r = await req('POST', '/api/v1/hub/campanhas/5/lancar', { json: { confirmo: true } });
      assert.deepEqual([r.status, r.body], [status, { erro: token }]);
      assert.equal(auditorias.length, 0, 'não audita ação que falhou');
    });
  }

  test('VALIDACAO do banco (defesa em profundidade) leva o campo do DETAIL para o 422', async () => {
    respostas['rpc/hub_campanha_salvar'] = Object.assign(new Error('x'), { status: 400, body: JSON.stringify({ message: 'VALIDACAO', details: 'dataFim' }) });
    const r = await req('POST', '/api/v1/hub/campanhas', { json: FORM });
    assert.deepEqual([r.status, r.body], [422, { erro: 'VALIDACAO', campo: 'dataFim' }]);
  });

  test('erro de infra -> 500 ERRO_SERVIDOR; id malformado -> 404 sem RPC', async () => {
    respostas['rpc/hub_campanha_fechar'] = Object.assign(new Error('boom'), { status: 503, body: 'x' });
    assert.equal((await req('POST', '/api/v1/hub/campanhas/5/fechar')).status, 500);
    chamadas = [];
    assert.equal((await req('POST', '/api/v1/hub/campanhas/abc/fechar')).status, 404);
    assert.equal((await req('GET', '/api/v1/hub/campanhas/99999999999')).status, 404);
    assert.equal(chamadas.length, 0);
  });
});

describe('leituras', () => {
  test('opcoes: canoniza a query, camelCase na resposta', async () => {
    respostas['rpc/hub_campanha_opcoes'] = { pracas: ['SP'], turnos: [], modais: ['MOTO'], cobertura_pedidos: 0.97, alcance: { rodaram: 10, sem_modal: 2 } };
    const r = await req('GET', '/api/v1/hub/campanhas/opcoes?pracas=sp, rj&modais=moto');
    assert.deepEqual(r.body, { pracas: ['SP'], turnos: [], modais: ['MOTO'], coberturaPedidos: 0.97, alcance: { rodaram: 10, semModal: 2 } });
    assert.deepEqual(chamadas[0].body, { p_id_empresa: 6, p_pracas: ['SP', 'RJ'], p_turnos: null, p_modais: ['MOTO'] });
  });

  test('lista: situacao inválida -> 422; válida vai para a RPC; itens mapeados', async () => {
    assert.equal((await req('GET', '/api/v1/hub/campanhas?situacao=xxx')).status, 422);
    respostas['rpc/hub_campanha_listar'] = [{ item: { id: 1, nome: 'N', situacao: 'rascunho', dataInicio: '2026-11-10', dataFim: '2026-11-30', minTurnos: 5, pesos: { aceitacao: 100, conclusao: 0, tempo: 0, pedidos: 0 }, contagem: {} } }];
    const r = await req('GET', '/api/v1/hub/campanhas?situacao=rascunho');
    assert.equal(r.body.itens[0].dataInicio, '2026-11-10');
    assert.deepEqual(chamadas[0].body, { p_id_empresa: 6, p_situacao: 'rascunho' });
  });

  test('detalhe: camelCase; RPC nula -> 404', async () => {
    assert.equal((await req('GET', '/api/v1/hub/campanhas/3')).status, 404);
    respostas['rpc/hub_campanha_detalhe'] = { id: 3, criada_por: 'Ana', premios: [{ id: 1, tem_foto: false }], nota_corte_top10: 80 };
    const r = await req('GET', '/api/v1/hub/campanhas/3');
    assert.deepEqual(r.body, { id: 3, criadaPor: 'Ana', premios: [{ id: 1, temFoto: false }], notaCorteTop10: 80 });
  });

  test('ranking: paginação de 50, situação padrão classificado, contagem em camelCase; situacao inválida -> 422', async () => {
    respostas['rpc/hub_campanha_ranking'] = [{ posicao: 51, entregador_id: 1, nome: 'A', situacao: 'classificado', motivo_corte: [] }];
    respostas['rpc/hub_campanha_ranking_contagem'] = { classificado: 120, abaixo_corte: 3, sem_minimo: 4, sem_modal: 5 };
    const r = await req('GET', '/api/v1/hub/campanhas/9/ranking?pagina=2');
    assert.equal(r.status, 200);
    assert.equal(r.body.pagina, 2);
    assert.equal(r.body.porPagina, 50);
    assert.deepEqual(r.body.contagem, { classificado: 120, abaixoCorte: 3, semMinimo: 4, semModal: 5 });
    assert.equal(r.body.itens[0].entregadorId, 1);
    const c = chamadas.find((x) => x.endpoint === 'rpc/hub_campanha_ranking');
    assert.deepEqual(c.body, { p_id: 9, p_situacao: 'classificado', p_limite: 50, p_offset: 50 });
    assert.equal((await req('GET', '/api/v1/hub/campanhas/9/ranking?situacao=outra')).status, 422);
    const p0 = await req('GET', '/api/v1/hub/campanhas/9/ranking?pagina=-3&situacao=abaixo_corte');
    assert.equal(p0.body.pagina, 1);
  });

  test('ranking.csv: cabeçalho, injeção de fórmula neutralizada, pagina o RPC em lotes', async () => {
    let n = 0;
    respostas['rpc/hub_campanha_ranking'] = () => {
      n += 1;
      if (n === 1) return Array.from({ length: 1000 }, (_, i) => ({ posicao: i + 1, nome: 'N', situacao: 'classificado', motivo_corte: [] }));
      return [{ posicao: 1001, nome: '=HYPERLINK("x")', modal: 'MOTO, X', situacao: 'abaixo_corte', motivo_corte: ['aceitacao', 'tempo'] }];
    };
    const r = await req('GET', '/api/v1/hub/campanhas/9/ranking.csv');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/csv/);
    const linhas = r.body.trim().split('\r\n');
    assert.equal(linhas.length, 1 + 1001);
    assert.match(linhas[0], /^Posição,Nome,Modal/);
    assert.match(linhas[1001], /'=HYPERLINK\(""x""\)"/);
    assert.match(linhas[1001], /"MOTO, X"/);
    assert.deepEqual(chamadas.map((c) => c.body.p_offset), [0, 1000]);
  });

  test('vencedores: shape do contrato', async () => {
    respostas['rpc/hub_campanha_vencedores'] = [{ posicao: 1, nome: 'Ana', cnpj: null, nota: 95, premio_tipo: 'objeto', premio_descricao: 'Moto', valor_centavos: null, entregue_em: null, entregue_por_nome: null, observacao: null, exportado_em: null }];
    const r = await req('GET', '/api/v1/hub/campanhas/9/vencedores');
    assert.deepEqual(r.body.itens[0], { posicao: 1, nome: 'Ana', nota: 95, premio: { tipo: 'objeto', descricao: 'Moto', valorCentavos: null }, entregueEm: null, entreguePor: null, observacao: null, exportadoEm: null, semCnpj: true });
  });

  test('entrega: 204 + auditoria; observação inválida -> 422; posição malformada -> 404', async () => {
    assert.equal((await req('POST', '/api/v1/hub/campanhas/9/vencedores/1/entrega', { json: { observacao: 'x'.repeat(501) } })).status, 422);
    assert.equal((await req('POST', '/api/v1/hub/campanhas/9/vencedores/abc/entrega', { json: {} })).status, 404);
    const ok = await req('POST', '/api/v1/hub/campanhas/9/vencedores/2/entrega', { json: { observacao: ' retirou ' } });
    assert.equal(ok.status, 204);
    assert.deepEqual(chamadas[0].body, { p_id: 9, p_posicao: 2, p_observacao: 'retirou' });
    assert.equal(auditorias[0].acao, 'campanha.entrega_registrada');
  });
});

describe('planilha de prêmios em dinheiro (A1/A2)', () => {
  const RPC = [
    { cnpj: '11222333000181', nome: 'Ana', valor_centavos: 10000, posicao: 1, data_pagamento: '2026-11-20', adiado: false },
    { cnpj: null, nome: 'Sem', valor_centavos: 5000, posicao: 2, data_pagamento: '2026-11-22', adiado: false },
    { cnpj: '44555666000199', nome: 'Adiado', valor_centavos: 3000, posicao: 3, data_pagamento: '2026-11-22', adiado: true },
  ];
  const aoaDe = (r) => { const wb = XLSX.read(r.raw, { type: 'buffer' }); return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }); };

  test('POST: cabeçalho do importador, data da linha vinda da RPC, adiado e sem CNPJ fora, X-Premios-Adiados, auditoria', async () => {
    const { CABECALHO_ESPERADO } = require('../lib/lancamento-externo');
    respostas['rpc/hub_campanha_marcar_exportado'] = RPC;
    const r = await req('POST', '/api/v1/hub/campanhas/9/premios-dinheiro.xlsx');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /spreadsheetml/);
    assert.match(r.headers['content-disposition'], /premios-campanha-9\.xlsx/);
    assert.equal(r.headers['x-premios-adiados'], '1');
    const aoa = aoaDe(r);
    assert.deepEqual(aoa[0], CABECALHO_ESPERADO);
    assert.equal(aoa.length, 2, 'só a Ana: adiado e sem CNPJ ficam fora');
    assert.equal(aoa[1][1], '2026-11-20', 'data = a do carimbo, não hoje');
    assert.equal(aoa[1][4], 'Prêmio campanha #9 — 1º');
    assert.deepEqual(chamadas[0].body, { p_id: 9 });
    assert.equal(auditorias[0].acao, 'campanha.planilha_exportada');
    assert.deepEqual([auditorias[0].detalhes.linhas, auditorias[0].detalhes.adiados], [1, 1]);
  });

  test('download repetido gera a MESMA data da 1ª exportação (a RPC devolve a data original)', async () => {
    respostas['rpc/hub_campanha_marcar_exportado'] = RPC;
    const a = aoaDe(await req('POST', '/api/v1/hub/campanhas/9/premios-dinheiro.xlsx'));
    const b = aoaDe(await req('POST', '/api/v1/hub/campanhas/9/premios-dinheiro.xlsx'));
    assert.deepEqual(a, b);
    assert.equal(b[1][1], '2026-11-20');
  });

  test('GET na rota da planilha não existe mais (404) e não chama a RPC que carimba', async () => {
    const r = await req('GET', '/api/v1/hub/campanhas/9/premios-dinheiro.xlsx');
    assert.ok([404, 405].includes(r.status), `status ${r.status}`);
    assert.equal(chamadas.length, 0);
  });
});

describe('foto do prêmio', () => {
  const put = (corpo, contentType, ck) => req('PUT', '/api/v1/hub/campanhas/9/premios/4/foto', { raw: corpo, contentType, ck });

  test('PNG válido com mime correto -> 204; RPC recebe mime detectado e base64; audita', async () => {
    const r = await put(PNG, 'image/png');
    assert.equal(r.status, 204);
    assert.deepEqual(chamadas[0].body, { p_campanha_id: 9, p_premio_id: 4, p_mime: 'image/png', p_base64: PNG.toString('base64') });
    assert.equal(auditorias[0].acao, 'campanha.foto_salva');
    assert.equal(auditorias[0].recursoId, 9, 'auditoria com o id da campanha da URL');
  });

  test('bytes de PNG com mime declarado jpeg -> 422 FOTO_INVALIDA', async () => {
    const r = await put(PNG, 'image/jpeg');
    assert.deepEqual([r.status, r.body.erro], [422, 'FOTO_INVALIDA']);
    assert.equal(chamadas.length, 0);
  });

  test('SVG (mime não aceito) e corpo JSON -> 422; bytes que não são imagem com mime image/png -> 422', async () => {
    let r = await put(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml');
    assert.deepEqual([r.status, r.body.erro], [422, 'FOTO_INVALIDA']);
    r = await put(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png');
    assert.equal(r.status, 422);
    assert.equal(chamadas.length, 0);
  });

  test('512001 bytes -> 422 pelo DTO; acima de 600 KB -> 422 pelo parser da rota (não 413 nem 500)', async () => {
    const png = (n) => Buffer.concat([PNG.subarray(0, 12), Buffer.alloc(n - 12)]);
    assert.equal((await put(png(512001), 'image/png')).status, 422);
    assert.equal((await put(png(512000), 'image/png')).status, 204);
    chamadas = [];
    const grande = await put(png(700 * 1024), 'image/png');
    assert.deepEqual([grande.status, grande.body.erro], [422, 'FOTO_INVALIDA']);
    assert.equal(chamadas.length, 0);
  });

  test('GET devolve Content-Type do banco + nosniff + cache privado; mime fora da lista -> 404', async () => {
    respostas['rpc/hub_campanha_premio_foto'] = [{ mime: 'image/webp', base64: PNG.toString('base64') }];
    const r = await req('GET', '/api/v1/hub/campanhas/9/premios/4/foto');
    assert.equal(r.headers['content-type'], 'image/webp');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['cache-control'], 'private, max-age=300');
    assert.ok(r.raw.equals(PNG));
    assert.deepEqual(chamadas[0].body, { p_campanha_id: 9, p_premio_id: 4 }, 'B2: o prêmio é conferido contra a campanha da URL');
    assert.equal(auditorias.length, 0);
    respostas['rpc/hub_campanha_premio_foto'] = [{ mime: 'text/html', base64: 'PGI+' }];
    assert.equal((await req('GET', '/api/v1/hub/campanhas/9/premios/4/foto')).status, 404);
  });
});

describe('rate limit de escrita por USUÁRIO', () => {
  test('o mesmo usuário esgota o balde (429); outro usuário no mesmo IP não é afetado', async () => {
    respostas['rpc/hub_campanha_fechar'] = null;
    const ck = cookie({}, 777777);
    let ultimo;
    for (let i = 0; i < 61; i += 1) ultimo = await req('POST', '/api/v1/hub/campanhas/5/fechar', { ck });
    assert.deepEqual([ultimo.status, ultimo.body.erro], [429, 'LIMITE_EXCEDIDO']);
    assert.equal((await req('POST', '/api/v1/hub/campanhas/5/fechar')).status, 204);
  });
});
