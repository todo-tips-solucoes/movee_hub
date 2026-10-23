/**
 * Rotas de lançamento externo (feature lancamento-externo, tasks 5.1): roundtrip
 * XLSX -> leitor -> RPC (mockada) -> resposta. Mesma técnica de
 * tests/hub-adiantamentos-rotas-unit.test.js: express real + JWT real, só a camada
 * de dados mockada via Module._load. Fixtures 100% sintéticas.
 * Rodam com: node --test tests/hub-lancamento-externo-integration.test.js
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-unit-lancamento-externo';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const Module = require('module');

let permissoes = new Set();
let chamadasRpc = [];
let auditorias = [];
let respostaRpc = null; // function(args) -> rows | throw
let resumoRow = null;
let respostaListar = null; // function(args) -> rows | throw
let respostaExcluir = null; // function(args) -> rows | throw

const COMPLETAS = ['adiantamentos.consultar', 'adiantamentos.pagamentos_consultar', 'adiantamentos.pagamento_confirmar'];

function reset() {
  permissoes = new Set(COMPLETAS);
  chamadasRpc = [];
  auditorias = [];
  respostaRpc = (args) => args.p_linhas.map((l) => ({ idx: l.i, situacao: 'APLICADA' }));
  respostaListar = () => [];
  respostaExcluir = (a) => [{ lancamento_id: a.p_id, tipo_excluido: 'ADIANTAMENTO', valor_excluido: '30.00', data_excluida: '2026-09-17' }];
  resumoRow = { qtd_deducao: 2, total_deducao: '60.00', qtd_credito: 1, total_credito: '5.00', flag_desconto_ligada: false, qtd_negativo: 0, total_negativo: '0.00' };
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../lib/hub-rbac-cache') {
    return {
      obterPermissoesEfetivas: async () => permissoes,
      obterPermissoesEfetivasPorEntidade: async () => permissoes,
      obterModulosAtivosPorEntidade: async () => new Set(['adiantamentos']),
    };
  }
  if (request === './grupo') {
    return { mesmoGrupoQue: async (idEmpresa, _ref, cache) => { if (!cache.ids) cache.ids = new Set([6]); return cache.ids.has(Number(idEmpresa)); } };
  }
  if (request === '../lib/hub-postgrest') {
    return {
      hubPostgrestRequest: async (endpoint, method, body, claims) => {
        chamadasRpc.push({ endpoint, method, body, claims });
        if (endpoint === 'rpc/hub_lancamento_externo_aplicar') return respostaRpc(body);
        if (endpoint === 'rpc/hub_lancamento_externo_resumo') return [resumoRow];
        if (endpoint === 'rpc/hub_lancamento_externo_listar') return respostaListar(body);
        if (endpoint === 'rpc/hub_lancamento_externo_excluir') return respostaExcluir(body);
        throw new Error(`mock não suporta: ${endpoint}`);
      },
    };
  }
  if (request === '../lib/hub-postgrest-lotes') return { buscarEmLotes: async () => [] };
  if (request === '../lib/hub-auditoria') return { registrarAuditoria: async (e) => { auditorias.push(e); return { ok: true }; } };
  return originalLoad.apply(this, arguments);
};
const express = require('express');
const cookieParser = require('cookie-parser');
const { router } = require('../routes/hub-adiantamentos.js');
Module._load = originalLoad;

const { XLSX_MIME } = require('../lib/adiantamento-retorno-transfeera');
const { xlsxDeAoa, comCabecalho, cnpjSintetico, nomeSintetico, CABECALHO } = require('./helpers/xlsx-sintetico');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1/adiantamentos', router);
let server; let baseUrl;

function request(method, path, { raw, contentType, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const headers = {};
    if (raw !== undefined) { headers['Content-Type'] = contentType || XLSX_MIME; headers['Content-Length'] = raw.length; }
    if (cookie) headers.Cookie = cookie;
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let body = buf;
        if ((res.headers['content-type'] || '').includes('application/json')) { try { body = JSON.parse(buf.toString('utf8')); } catch { body = buf.toString('utf8'); } }
        resolve({ status: res.statusCode, body, texto: buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (raw !== undefined) req.write(raw);
    req.end();
  });
}
let sub = 8000;
const cookie = () => `hub_accessToken=${jwt.sign({ sub: sub++, entidade_ativa: 6 }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' })}`;
const BASE = '/api/v1/adiantamentos/repasse/lancamentos-externos';
const enviar = (aoa, tipo = 'ADIANTAMENTO', opts = {}) =>
  request('POST', `${BASE}?tipo=${tipo}`, { raw: xlsxDeAoa(aoa), cookie: cookie(), ...opts });

before(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(reset);

const boa = (i) => [cnpjSintetico(i), '2026-09-17', 30, nomeSintetico(i), 'obs'];

describe('POST /repasse/lancamentos-externos', () => {
  test('C12 roundtrip: 3 boas + 2 ruins -> RPC recebe SÓ as 3 válidas, resposta só com contagens', async () => {
    const r = await enviar(comCabecalho(boa(1), boa(2), ['123', '2026-09-17', 30], boa(3), [cnpjSintetico(9), '2026-09-17', 'abc']));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { aplicadas: 3, ignoradas: 2, ignoradasPorMotivo: [{ motivo: 'CNPJ_INVALIDO', total: 1 }, { motivo: 'VALOR_INVALIDO', total: 1 }], excedentes: [] });
    const rpc = chamadasRpc.find((c) => c.endpoint === 'rpc/hub_lancamento_externo_aplicar');
    assert.equal(rpc.body.p_tipo, 'ADIANTAMENTO');
    assert.deepEqual(rpc.body.p_linhas.map((l) => l.i), [0, 1, 3]);
    assert.deepEqual(Object.keys(rpc.body.p_linhas[0]).sort(), ['cnpj', 'data', 'i', 'obs', 'valor']); // sem Nome
  });

  test('C4: situações da RPC (CNPJ_SEM_MOTORISTA, JA_APLICADO...) entram na contagem por motivo', async () => {
    respostaRpc = (a) => a.p_linhas.map((l) => ({ idx: l.i, situacao: ['APLICADA', 'CNPJ_SEM_MOTORISTA', 'JA_APLICADO'][l.i] }));
    const r = await enviar(comCabecalho(boa(1), boa(2), boa(3)));
    assert.equal(r.body.aplicadas, 1);
    assert.equal(r.body.ignoradas, 2);
    assert.deepEqual(r.body.ignoradasPorMotivo.map((m) => m.motivo).sort(), ['CNPJ_SEM_MOTORISTA', 'JA_APLICADO']);
  });

  test('FR-031: a resposta e a auditoria NÃO contêm CNPJ nem nome', async () => {
    const r = await enviar(comCabecalho(boa(1), ['999', '2026-09-17', 30, nomeSintetico(7), '']));
    for (const s of [r.texto, JSON.stringify(auditorias)]) {
      assert.ok(!s.includes(cnpjSintetico(1)), 'CNPJ vazou');
      assert.ok(!s.includes('Motorista Teste'), 'nome vazou');
    }
    assert.equal(auditorias.length, 1);
    assert.deepEqual(auditorias[0].detalhes, { tipo: 'ADIANTAMENTO', aplicadas: 1, ignoradas: 1 });
  });

  test('C10: cabeçalho fora do contrato -> 400 com o esperado; NADA aplicado', async () => {
    const r = await enviar([['Cnpj', 'Data', 'Valor'], boa(1)]);
    assert.equal(r.status, 400);
    assert.equal(r.body.motivo, 'CABECALHO_INVALIDO');
    assert.deepEqual(r.body.esperado, CABECALHO);
    assert.equal(chamadasRpc.length, 0);
  });

  test('C10: só cabeçalho -> ARQUIVO_VAZIO; tipo inválido -> TIPO_INVALIDO; content-type errado -> FORMATO_INVALIDO; nada aplicado', async () => {
    assert.equal((await enviar([CABECALHO])).body.motivo, 'ARQUIVO_VAZIO');
    assert.equal((await enviar(comCabecalho(boa(1)), 'OUTRO')).body.motivo, 'TIPO_INVALIDO');
    const r = await request('POST', `${BASE}?tipo=ADIANTAMENTO`, { raw: Buffer.from('CNPJ;Data'), contentType: 'text/csv', cookie: cookie() });
    assert.equal(r.status, 400);
    assert.equal(r.body.motivo, 'FORMATO_INVALIDO');
    assert.equal(chamadasRpc.length, 0);
  });

  test('escopo vem do TOKEN: nada de escopo/empresa no corpo da RPC; claims do token repassadas', async () => {
    await request('POST', `${BASE}?tipo=AJUSTE_CREDITO&escopo=9001&idEmpresa=9001`, { raw: xlsxDeAoa(comCabecalho(boa(1))), cookie: cookie() });
    const rpc = chamadasRpc.find((c) => c.endpoint === 'rpc/hub_lancamento_externo_aplicar');
    assert.equal(rpc.body.p_tipo, 'AJUSTE_CREDITO');
    assert.ok(!JSON.stringify(rpc.body).includes('9001'));
    assert.ok(rpc.claims && Array.isArray(rpc.claims.escopo));
    assert.ok(!rpc.claims.escopo.includes(9001));
  });

  test('FR-034: sem pagamento_confirmar -> 403 e a RPC nem é chamada', async () => {
    permissoes = new Set(['adiantamentos.consultar', 'adiantamentos.pagamentos_consultar']);
    const r = await enviar(comCabecalho(boa(1)));
    assert.equal(r.status, 403);
    assert.equal(chamadasRpc.length, 0);
  });

  test('FORA_DE_ESCOPO levantado pela RPC -> 403 (nunca 500)', async () => {
    respostaRpc = () => { throw Object.assign(new Error('FORA_DE_ESCOPO'), { status: 400, body: JSON.stringify({ message: 'FORA_DE_ESCOPO' }) }); };
    const r = await enviar(comCabecalho(boa(1)));
    assert.equal(r.status, 403); // P19: a asserção anterior aceitava 500, que o título proíbe
  });

  test('P5: resposta da RPC que não é array (INSERTs já commitaram) -> 500, nunca 200 com aplicadas: 0', async () => {
    respostaRpc = () => ({ message: 'inesperado' });
    const r = await enviar(comCabecalho(boa(1)));
    assert.equal(r.status, 500);
    assert.equal(auditorias[0].detalhes.divergente, true);
  });

  test('P5: RPC devolve MENOS linhas do que as enviadas -> 500', async () => {
    respostaRpc = (args) => args.p_linhas.slice(1).map((l) => ({ idx: l.i, situacao: 'APLICADA' }));
    assert.equal((await enviar(comCabecalho(boa(1), boa(2)))).status, 500);
  });

  test('P6: falha da AUDITORIA depois da RPC commitada NÃO vira 500 — a importação deu certo', async () => {
    const orig = auditorias.push;
    auditorias.push = () => { throw new Error('auditoria fora do ar'); };
    try {
      const r = await enviar(comCabecalho(boa(1)));
      assert.equal(r.status, 200);
      assert.equal(r.body.aplicadas, 1);
    } finally { auditorias.push = orig; }
  });

  test('toda linha ruim: RPC não é chamada e a auditoria registra aplicadas: 0', async () => {
    const r = await enviar(comCabecalho(['1', '2026-09-17', 30]));
    assert.equal(r.status, 200);
    assert.equal(r.body.aplicadas, 0);
    assert.equal(chamadasRpc.length, 0);
    assert.equal(auditorias[0].detalhes.aplicadas, 0);
  });
});

describe('GET /repasse/lancamentos-externos/resumo (FR-049)', () => {
  test('quem tem SÓ pagamentos_consultar VÊ o aviso (camelCase, sem identificáveis)', async () => {
    permissoes = new Set(['adiantamentos.consultar', 'adiantamentos.pagamentos_consultar']);
    const r = await request('GET', `${BASE}/resumo?periodo=2026-09-14`, { cookie: cookie() });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { qtdDeducao: 2, totalDeducao: 60, qtdCredito: 1, totalCredito: 5, flagDescontoLigada: false, qtdNegativo: 0, totalNegativo: 0 });
  });
  test('A2 (rodada 4): o resumo repassa quantos motoristas fecham negativos e o total que evaporaria', async () => {
    resumoRow = { ...resumoRow, flag_desconto_ligada: true, qtd_negativo: 3, total_negativo: '12.50' };
    const r = await request('GET', `${BASE}/resumo?periodo=2026-09-14`, { cookie: cookie() });
    assert.equal(r.body.qtdNegativo, 3);
    assert.equal(r.body.totalNegativo, 12.5);
  });
  test('5b: resposta sem qtd_negativo/total_negativo falha FECHADO — `null` (nunca um 0 numérico que esconderia o aviso)', async () => {
    resumoRow = { qtd_deducao: 1, total_deducao: '10.00', qtd_credito: 0, total_credito: '0.00', flag_desconto_ligada: true };
    const r = await request('GET', `${BASE}/resumo?periodo=2026-09-14`, { cookie: cookie() });
    assert.equal(r.body.qtdNegativo, null);
    assert.equal(r.body.totalNegativo, null);
  });
  test('P4: resposta sem a flag (undefined) falha FECHADO — flagDescontoLigada: false, o aviso aparece', async () => {
    resumoRow = { qtd_deducao: 1, total_deducao: '10.00', qtd_credito: 0, total_credito: '0.00' };
    const r = await request('GET', `${BASE}/resumo?periodo=2026-09-14`, { cookie: cookie() });
    assert.equal(r.body.flagDescontoLigada, false);
  });
  test('P4: flag explicitamente true continua true', async () => {
    resumoRow = { ...resumoRow, flag_desconto_ligada: true };
    assert.equal((await request('GET', `${BASE}/resumo?periodo=2026-09-14`, { cookie: cookie() })).body.flagDescontoLigada, true);
  });
  test('sem pagamentos_consultar -> 403; período inválido -> 400', async () => {
    permissoes = new Set(['adiantamentos.consultar']);
    assert.equal((await request('GET', `${BASE}/resumo?periodo=2026-09-14`, { cookie: cookie() })).status, 403);
    permissoes = new Set(COMPLETAS);
    assert.equal((await request('GET', `${BASE}/resumo?periodo=ontem`, { cookie: cookie() })).status, 400);
  });
});

describe('ALTO 2 — VALOR_EXCEDE_LIQUIDO chega ao operador com o valor da linha e o líquido', () => {
  test('a RPC recusa a linha 2 (0-based 1 => linha 3 da planilha): corpo traz linha, valor e líquido; nada identificável', async () => {
    respostaRpc = (a) => a.p_linhas.map((l) => (l.i === 1
      ? { idx: l.i, situacao: 'VALOR_EXCEDE_LIQUIDO', liquido: '12.50' } : { idx: l.i, situacao: 'APLICADA', liquido: null }));
    const r = await enviar(comCabecalho(boa(1), boa(2)));
    assert.equal(r.status, 200);
    assert.equal(r.body.aplicadas, 1);
    assert.deepEqual(r.body.ignoradasPorMotivo, [{ motivo: 'VALOR_EXCEDE_LIQUIDO', total: 1 }]);
    assert.deepEqual(r.body.excedentes, [{ linha: 3, valor: '30.00', liquido: '12.50' }]);
    assert.ok(!r.texto.includes(cnpjSintetico(2)), 'CNPJ vazou');
  });
  test('M1 (rodada 4): com LINHA EM BRANCO no meio, `linha` é a da PLANILHA (a que o operador acha no Excel), não o índice filtrado', async () => {
    respostaRpc = (a) => a.p_linhas.map((l) => (l.i === 1
      ? { idx: l.i, situacao: 'VALOR_EXCEDE_LIQUIDO', liquido: '12.50' } : { idx: l.i, situacao: 'APLICADA', liquido: null }));
    // cabeçalho = 1, boa(1) = 2, EM BRANCO = 3, boa(2) = 4 (índice filtrado 1 => +2 daria 3, que é a linha em branco)
    const r = await enviar(comCabecalho(boa(1), [], boa(2)));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.excedentes, [{ linha: 4, valor: '30.00', liquido: '12.50' }]);
  });
  test('o corpo não cresce sem limite: no máximo 50 excedentes, a contagem por motivo segue completa', async () => {
    respostaRpc = (a) => a.p_linhas.map((l) => ({ idx: l.i, situacao: 'VALOR_EXCEDE_LIQUIDO', liquido: '0.00' }));
    const linhas = Array.from({ length: 60 }, (_, i) => boa(i + 1));
    const r = await enviar(comCabecalho(...linhas));
    assert.equal(r.body.excedentes.length, 50);
    assert.deepEqual(r.body.ignoradasPorMotivo, [{ motivo: 'VALOR_EXCEDE_LIQUIDO', total: 60 }]);
  });
});

describe('GET /repasse/lancamentos-externos (listagem)', () => {
  const rowDb = (o = {}) => ({
    id: 7, entregador_nome: nomeSintetico(1), tipo: 'ADIANTAMENTO', sinal: -1, data_pagamento: '2026-09-17', valor: '30.00',
    observacao: null, criado_em: '2026-09-18T10:00:00Z', criado_por_nome: 'Fin', excluivel: true, total: 2, ...o,
  });
  test('camelCase, total e excluivel vêm do banco; sem CNPJ; limites saneados na ida', async () => {
    respostaListar = () => [rowDb(), rowDb({ id: 8, excluivel: false })];
    const r = await request('GET', `${BASE}?periodo=2026-09-14&busca=${'x'.repeat(300)}&offset=-5&limite=9999`, { cookie: cookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 2);
    assert.deepEqual(r.body.itens.map((i) => [i.id, i.excluivel]), [[7, true], [8, false]]);
    assert.equal(r.body.itens[0].motorista, nomeSintetico(1));
    assert.ok(!/cnpj/i.test(r.texto));
    const rpc = chamadasRpc.find((c) => c.endpoint === 'rpc/hub_lancamento_externo_listar');
    assert.deepEqual([rpc.body.p_offset, rpc.body.p_limite, rpc.body.p_busca.length], [0, 200, 100]);
  });
  test('excluivel só é true se o banco disse true (fail-closed)', async () => {
    respostaListar = () => [rowDb({ excluivel: undefined }), rowDb({ id: 9, excluivel: 't' })];
    const r = await request('GET', `${BASE}?periodo=2026-09-14`, { cookie: cookie() });
    assert.deepEqual(r.body.itens.map((i) => i.excluivel), [false, false]);
  });
  test('M3 (rodada 4): semanaFechada vem do banco e é independente de excluivel (sem permissão != semana fechada)', async () => {
    respostaListar = () => [rowDb({ excluivel: false, semana_fechada: true }), rowDb({ id: 8, excluivel: false, semana_fechada: false }), rowDb({ id: 9 })];
    const r = await request('GET', `${BASE}?periodo=2026-09-14`, { cookie: cookie() });
    assert.deepEqual(r.body.itens.map((i) => [i.excluivel, i.semanaFechada]), [[false, true], [false, false], [true, false]]);
  });
  test('M13 (rodada 4): página FORA DE FAIXA devolve o total real (pergunta pela página 0), não 0', async () => {
    respostaListar = (a) => (a.p_offset > 0 ? [] : [rowDb({ total: 49 })]);
    const r = await request('GET', `${BASE}?periodo=2026-09-14&offset=100`, { cookie: cookie() });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.itens.length, r.body.total], [0, 49]);
  });
  test('sem pagamentos_consultar -> 403; período inválido -> 400', async () => {
    permissoes = new Set(['adiantamentos.consultar']);
    assert.equal((await request('GET', `${BASE}?periodo=2026-09-14`, { cookie: cookie() })).status, 403);
    permissoes = new Set(COMPLETAS);
    assert.equal((await request('GET', `${BASE}?periodo=ontem`, { cookie: cookie() })).status, 400);
  });
});

describe('DELETE /repasse/lancamentos-externos/:id (exclusão)', () => {
  const erroRpc = (msg) => () => { throw Object.assign(new Error(msg), { status: 400, body: JSON.stringify({ message: msg }) }); };
  test('exclui: 200, RPC chamada com o id, auditoria com quem/o quê (sem CNPJ)', async () => {
    const r = await request('DELETE', `${BASE}/7`, { cookie: cookie() });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { excluido: true, id: 7 });
    assert.deepEqual(chamadasRpc.find((c) => c.endpoint === 'rpc/hub_lancamento_externo_excluir').body, { p_id: 7 });
    assert.equal(auditorias.length, 1);
    assert.equal(auditorias[0].acao, 'adiantamento.lancamento_externo_excluido');
    assert.equal(auditorias[0].recursoId, '7');
    assert.deepEqual(auditorias[0].detalhes, { tipo: 'ADIANTAMENTO', valor: '30.00', dataPagamento: '2026-09-17' });
  });
  test('SEMANA JÁ FECHADA -> 409 e NENHUMA auditoria de exclusão (nada foi excluído)', async () => {
    respostaExcluir = erroRpc('SEMANA_JA_FECHADA');
    const r = await request('DELETE', `${BASE}/7`, { cookie: cookie() });
    assert.equal(r.status, 409);
    assert.equal(r.body.erro, 'SEMANA_JA_FECHADA');
    assert.equal(auditorias.length, 0);
  });
  test('A1 (rodada 4): EXCLUSAO_DEIXA_LIQUIDO_NEGATIVO -> 409 com o código (a tela explica "apague a dedução primeiro") e sem auditoria', async () => {
    respostaExcluir = erroRpc('EXCLUSAO_DEIXA_LIQUIDO_NEGATIVO');
    const r = await request('DELETE', `${BASE}/7`, { cookie: cookie() });
    assert.equal(r.status, 409);
    assert.equal(r.body.erro, 'EXCLUSAO_DEIXA_LIQUIDO_NEGATIVO');
    assert.equal(auditorias.length, 0);
  });
  test('inexistente -> 404; fora de escopo -> 403; permissão da RPC -> 403', async () => {
    respostaExcluir = erroRpc('LANCAMENTO_NAO_ENCONTRADO');
    assert.equal((await request('DELETE', `${BASE}/7`, { cookie: cookie() })).status, 404);
    respostaExcluir = erroRpc('FORA_DE_ESCOPO');
    assert.equal((await request('DELETE', `${BASE}/7`, { cookie: cookie() })).status, 403);
    respostaExcluir = erroRpc('PERMISSAO_NEGADA');
    assert.equal((await request('DELETE', `${BASE}/7`, { cookie: cookie() })).status, 403);
  });
  test('sem pagamento_confirmar (só consultar) -> 403 e a RPC nem é chamada', async () => {
    permissoes = new Set(['adiantamentos.consultar', 'adiantamentos.pagamentos_consultar']);
    assert.equal((await request('DELETE', `${BASE}/7`, { cookie: cookie() })).status, 403);
    assert.equal(chamadasRpc.length, 0);
  });
  test('id que não é inteiro positivo -> 400, sem RPC', async () => {
    for (const id of ['abc', '1e3', '-1', '1.5', '12345678901234567']) {
      assert.equal((await request('DELETE', `${BASE}/${id}`, { cookie: cookie() })).status, 400, id);
    }
    assert.equal(chamadasRpc.length, 0);
  });
  test('P6: falha da auditoria depois da exclusão NÃO vira 500', async () => {
    const orig = auditorias.push;
    auditorias.push = () => { throw new Error('auditoria fora do ar'); };
    try { assert.equal((await request('DELETE', `${BASE}/7`, { cookie: cookie() })).status, 200); } finally { auditorias.push = orig; }
  });
});
