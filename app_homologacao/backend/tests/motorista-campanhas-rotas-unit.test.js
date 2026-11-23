'use strict';
/** routes/motorista-campanhas.js — node --test tests/motorista-campanhas-rotas-unit.test.js */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('module');

let chamadas = [];
let respostas = {};
const originalLoad = Module._load;
Module._load = function (request) {
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
  return originalLoad.apply(this, arguments);
};
const express = require('express');
const { router } = require('../routes/motorista-campanhas.js');
Module._load = originalLoad;

const app = express();
app.use(express.json());
// Simula authenticateMotorista: sem o header x-test-cnpj => 401 (sem sessão).
app.use('/motorista', (req, res, next) => {
  const cnpj = req.headers['x-test-cnpj'];
  if (!cnpj) return res.status(401).json({ erro: 'NAO_AUTENTICADO' });
  req.motorista = { cnpjPrestador: cnpj };
  return next();
}, router);

let server; let baseUrl;
before(async () => { await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); baseUrl = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());
beforeEach(() => { chamadas = []; respostas = {}; });

function get(path, headers = { 'x-test-cnpj': '11111111000191' }) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, baseUrl);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(parts);
        let json = null;
        try { json = JSON.parse(buf.toString()); } catch (_) { /* binário */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw: buf });
      });
    }).on('error', reject);
  });
}

const ITEM = {
  id: 12, nome: 'Rei do Jantar', situacao: 'em_andamento', data_inicio: '2026-11-10', data_fim: '2026-11-30',
  minha_posicao: 7, total: 184, minha_situacao: 'classificado', na_zona_premio: true,
};

describe('motorista-campanhas', () => {
  test('sem sessão -> 401 e nenhuma RPC', async () => {
    const r = await get('/motorista/campanhas', {});
    assert.equal(r.status, 401);
    assert.equal(chamadas.length, 0);
  });

  test('lista: camelCase com todos os campos do contrato (inclui dataInicio) e identidade SÓ da claim', async () => {
    respostas['rpc/hub_motorista_campanhas'] = [ITEM];
    const r = await get('/motorista/campanhas?cnpj=99999999000199&id_empresa=9&entregadorId=5', { 'x-test-cnpj': '22222222000191' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.itens[0], {
      id: 12, nome: 'Rei do Jantar', situacao: 'em_andamento', dataInicio: '2026-11-10', dataFim: '2026-11-30',
      minhaPosicao: 7, total: 184, minhaSituacao: 'classificado', naZonaPremio: true,
    });
    assert.deepEqual(chamadas[0].claims, { motoristaCnpj: '22222222000191' });
    assert.deepEqual(chamadas[0].body, {}, 'nada da query vai para a RPC');
  });

  test('lista vazia / resposta nula -> itens []', async () => {
    respostas['rpc/hub_motorista_campanhas'] = null;
    assert.deepEqual((await get('/motorista/campanhas')).body, { itens: [] });
  });

  test('detalhe: camelização profunda, eu=null preservado, id só da URL', async () => {
    respostas['rpc/hub_motorista_campanha'] = {
      campanha: { id: 12, nome: 'N', data_fim: '2026-11-30', min_turnos: 5, dados_ate: null, fechada_em: null },
      premios: [{ id: 3, posicao_de: 1, posicao_ate: 1, tipo: 'objeto', descricao: 'x', valor_centavos: null, tem_foto: true }],
      eu: null, lider: { pedidos: 412 }, top10: [{ posicao: 1, nome: 'Marcos V.', nota: 97.3, sou_eu: false }], total_classificados: 184,
    };
    const r = await get('/motorista/campanhas/12');
    assert.equal(r.status, 200);
    assert.equal(r.body.eu, null);
    assert.equal(r.body.campanha.minTurnos, 5);
    assert.equal(r.body.premios[0].temFoto, true);
    assert.equal(r.body.top10[0].souEu, false);
    assert.equal(r.body.totalClassificados, 184);
    assert.deepEqual(chamadas[0].body, { p_id: 12 });
  });

  test('detalhe: id malformado -> 404 sem RPC; RPC nula -> 404; SEM_VINCULO -> 404; CAMPANHA_NAO_ENCONTRADA -> 404', async () => {
    assert.equal((await get('/motorista/campanhas/abc')).status, 404);
    assert.equal((await get('/motorista/campanhas/0')).status, 404);
    assert.equal(chamadas.length, 0);
    assert.equal((await get('/motorista/campanhas/5')).status, 404);
    for (const token of ['SEM_VINCULO', 'CAMPANHA_NAO_ENCONTRADA']) {
      respostas['rpc/hub_motorista_campanha'] = Object.assign(new Error('x'), { body: JSON.stringify({ message: token }) });
      const r = await get('/motorista/campanhas/5');
      assert.deepEqual([r.status, r.body.erro], [404, token]);
    }
  });

  test('erro de infra -> 502 INDISPONIVEL', async () => {
    respostas['rpc/hub_motorista_campanhas'] = Object.assign(new Error('timeout'), { status: 503, body: 'upstream' });
    const r = await get('/motorista/campanhas');
    assert.deepEqual([r.status, r.body], [502, { erro: 'INDISPONIVEL' }]);
  });

  test('foto: headers do plano e bytes do banco; mime inválido do banco -> 404', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    respostas['rpc/hub_motorista_campanha_foto'] = [{ mime: 'image/png', base64: png.toString('base64') }];
    const r = await get('/motorista/campanhas/12/premios/3/foto');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/png');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['cache-control'], 'private, max-age=300');
    assert.ok(r.raw.equals(png));
    assert.deepEqual(chamadas[0].body, { p_campanha_id: 12, p_premio_id: 3 });
    assert.deepEqual(chamadas[0].claims, { motoristaCnpj: '11111111000191' });
    respostas['rpc/hub_motorista_campanha_foto'] = [{ mime: 'image/svg+xml', base64: 'PHN2Zy8+' }];
    assert.equal((await get('/motorista/campanhas/12/premios/3/foto')).status, 404);
    respostas['rpc/hub_motorista_campanha_foto'] = [];
    assert.equal((await get('/motorista/campanhas/12/premios/3/foto')).status, 404);
  });
});

describe('extrato no app', () => {
  const EXTRATO = {
    campanha: { id: 3, nome: 'Extrato', tipo: 'extrato', minTurnosBase: 'validos' },
    // o banco só manda posição + nome; o stub injeta lixo para provar que o servidor corta
    top10: [{ posicao: 1, nomeAbreviado: 'Ana R.', valorCentavos: 9999, centavos: 1, nota: 90, turnos: 4, souEu: true }],
    podio: [{ posicao: 1, nomeAbreviado: 'Ana R.', valor: 5, valorTotal: 1, notaFinal: 3, turnosValidos: 2 }],
    eu: { situacao: 'classificado', posicao: 1, turnos: 4, turnosValidos: 3, valorCentavos: 1000 },
    lider: { pedidos: 50 },
  };

  test('top10/podio do extrato saem só com posicao e nomeAbreviado (nenhuma chave de valor/centavos/nota/turnos)', async () => {
    respostas['rpc/hub_motorista_campanha'] = EXTRATO;
    const r = await get('/motorista/campanhas/3');
    assert.equal(r.status, 200);
    for (const k of ['top10', 'podio']) {
      assert.deepEqual(r.body[k], [{ posicao: 1, nomeAbreviado: 'Ana R.' }]);
      assert.ok(!/valor|centavos|nota|turnos/i.test(JSON.stringify(r.body[k])));
    }
    assert.equal(r.body.lider, null);
    assert.equal(r.body.eu.valorCentavos, 1000, 'os dados do PRÓPRIO motorista seguem');
    assert.equal(r.body.campanha.minTurnosBase, 'validos');
  });

  test('nota: payload intocado (souEu e nota do top10 seguem)', async () => {
    respostas['rpc/hub_motorista_campanha'] = { campanha: { id: 1, tipo: 'nota' }, top10: [{ posicao: 1, nome: 'A', nota: 90, souEu: true }] };
    const r = await get('/motorista/campanhas/1');
    assert.deepEqual(r.body.top10, [{ posicao: 1, nome: 'A', nota: 90, souEu: true }]);
  });

  test('turnos: só da claim, id inteiro; SEM_VINCULO -> 404; id malformado -> 404 sem RPC; sem sessão -> 401', async () => {
    respostas['rpc/hub_motorista_campanha_turnos'] = [{ data: '2026-12-01', turno: 'Jantar', valido: true, temValor: true, valorCentavos: 100, motivos: [] }];
    const r = await get('/motorista/campanhas/3/turnos?cnpj=9', { 'x-test-cnpj': '33333333000191' });
    assert.equal(r.status, 200);
    assert.equal(r.body.itens[0].temValor, true);
    assert.deepEqual(chamadas[0].body, { p_campanha_id: 3 });
    assert.deepEqual(chamadas[0].claims, { motoristaCnpj: '33333333000191' });
    chamadas = [];
    assert.equal((await get('/motorista/campanhas/abc/turnos')).status, 404);
    assert.equal(chamadas.length, 0);
    assert.equal((await get('/motorista/campanhas/3/turnos', {})).status, 401);
    respostas['rpc/hub_motorista_campanha_turnos'] = Object.assign(new Error('x'), { body: JSON.stringify({ message: 'SEM_VINCULO' }) });
    assert.equal((await get('/motorista/campanhas/3/turnos')).status, 404);
  });
});
