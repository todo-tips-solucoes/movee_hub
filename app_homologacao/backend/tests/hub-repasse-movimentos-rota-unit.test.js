/**
 * Testes de rota — POST /api/v1/adiantamentos/repasse/:periodo/movimentos (repasse-gera-movimento, FASE 3).
 * node --test tests/hub-repasse-movimentos-rota-unit.test.js
 *
 * Mesma tecnica de tests/hub-adiantamentos-rotas-unit.test.js (express real + accessToken real + Module._load),
 * mas com um PostgREST FAKE *com estado* que reproduz o que interessa ao S1: UNIQUE (apuracao_id, entregador_id)
 * da trilha, PK de EnvioMassa, sequencia de ids e a AUSENCIA de RLS em EnvioMassa (sem `id_empresa` no filtro,
 * a tabela devolve linhas de todos os tenants). Concorrencia: as chamadas do fake ceduem o laco de eventos, entao
 * duas requisicoes disparadas juntas se intercalam de verdade.
 * O banco real (UNIQUE/PK/advisory lock) e provado pelo driver; aqui prova-se a ORDEM e os textos da rota.
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-unit-repasse-movimentos';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');

const PERIODO = '2026-10-19';
let st; // estado do fake
function resetEstado() {
  st = {
    apuracao: null, pendentes: [], trilha: [], envio: [], proximoId: 1000, chamadas: [], auditoria: [],
    config: { mensagem1_modelo: 'Ola {nome}, nota de {valor}.', mensagem2_modelo: 'Gorjeta {gorjeta}.' },
    vigente: { mensagem1_modelo: 'Ola {nome}, nota de {valor}.', horario_corte: '12:00:00', timezone: 'America/Sao_Paulo' },
    leituras: [], fecharErro: null, falhaEnvioPost: false, falhaAlocar: false, falhaItens: false,
    itens: [
      { entregador_id: 1, creditos: '100.00', valor_nota: '100.00', valor_fora_nota: '20.00', nota_a_emitir: '70.00', remanescente: '90.00', saldo_anterior_nota: '0', saldo_anterior_fora: '0', valor_pago: '90.00', valor_transportado: '0.00' },
    ],
    entregadores: [{ id: 1, nome: 'Motorista Um', motorista_id: 11 }],
    contas: [{ id: 11, cnpj_prestador: '90000000000011', nome: 'Motorista Um', telefone: '5511900000001' }],
  };
}
function erroPg(status, code, message) {
  const e = new Error(message); e.status = status; e.body = JSON.stringify({ code, message, details: null, hint: null }); return e;
}
function raise(msg, detail) {
  const e = new Error(msg); e.status = 400; e.body = JSON.stringify({ code: 'P0001', message: msg, details: detail ?? null, hint: null }); return e;
}
const cede = () => new Promise((r) => setImmediate(r));
const ids = (q, campo) => { const m = q.match(new RegExp(`[?&]${campo}=in\\.\\(([^)]*)\\)`)); return m ? m[1].split(',').filter(Boolean) : null; };

async function fakePostgrest(endpoint, method = 'GET', body = null) {
  await cede();
  st.chamadas.push(`${method} ${endpoint.split('?')[0]}`);
  if (endpoint.startsWith('EnvioMassa?') && method === 'GET') (st.leituras = st.leituras || []).push(endpoint);
  const e = endpoint;
  if (e.startsWith('AdiantamentoSolicitacao?')) return st.pendentes;
  if (e.startsWith('ApuracaoRepasse?') && e.includes('periodo_inicio=eq.')) return st.apuracao ? [st.apuracao] : [];
  if (e.startsWith('ApuracaoRepasse?')) return [];
  if (e.startsWith('AdiantamentoConfiguracao?id_empresa=eq.6')) return [st.vigente];
  if (e.startsWith('AdiantamentoConfiguracao?id=eq.')) return [st.config];
  if (e === 'rpc/hub_adiantamento_repasse_fechar') {
    if (st.fecharErro) throw raise(st.fecharErro);
    st.apuracao = { id: 77, periodo_inicio: PERIODO, periodo_fim: '2026-10-25', configuracao_id: 9 };
    return [{ apuracao_id: 77, motoristas: st.itens.length, total: '90.00', nao_pagos_no_periodo: 0 }];
  }
  if (e.startsWith('ApuracaoRepasseItem?')) { if (st.falhaItens) throw new Error('falha simulada pos-fechamento'); return st.itens; }
  if (e.startsWith('Entregador?select=id,nome,motorista_id')) { const f = ids(e, 'id'); return st.entregadores.filter((x) => !f || f.includes(String(x.id))); }
  if (e.startsWith('Entregador?select=id,nome')) { const f = ids(e, 'id'); return st.entregadores.filter((x) => !f || f.includes(String(x.id))).map(({ id, nome }) => ({ id, nome })); }
  if (e.startsWith('ContaMotorista?')) { const f = ids(e, 'id'); return st.contas.filter((x) => !f || f.includes(String(x.id))); }
  if (e.startsWith('Empresa?')) return [{ cnpj: '48904673000100' }];
  if (e.startsWith('ApuracaoRepasseMovimento?') && method === 'GET') return st.trilha;
  if (e === 'ApuracaoRepasseMovimento' && method === 'POST') {
    if (st.trilha.some((t) => t.apuracao_id === body.apuracao_id && t.entregador_id === body.entregador_id)) {
      throw erroPg(409, '23505', 'duplicate key value violates unique constraint');
    }
    st.trilha.push({ ...body }); return [body];
  }
  if (e === 'rpc/hub_repasse_alocar_envio_id') { if (st.falhaAlocar) throw erroPg(500, 'XX000', 'boom'); st.proximoId += 1; return st.proximoId; }
  if (e.startsWith('EnvioMassa?mov_fechado=eq.false')) {
    const emp = ids(e, 'id_empresa'); const cn = ids(e, 'cnpj_prestador');
    // SEM RLS: sem filtro de id_empresa, devolve TODOS os tenants.
    return st.envio.filter((m) => !m.mov_fechado && (!emp || emp.includes(String(m.id_empresa))) && (!cn || cn.includes(m.cnpj_prestador))).map((m) => ({ cnpj_prestador: m.cnpj_prestador }));
  }
  if (e.startsWith('EnvioMassa?id_empresa=in.')) {
    const emp = ids(e, 'id_empresa'); const f = ids(e, 'id');
    return st.envio.filter((m) => (!emp || emp.includes(String(m.id_empresa))) && (!f || f.includes(String(m.id)))).map((m) => ({ id: m.id }));
  }
  if (e.startsWith('EnvioMassa?')) return []; // historico (#229): nada
  if (e === 'EnvioMassa' && method === 'POST') {
    if (st.falhaEnvioPost) throw erroPg(500, 'XX000', 'falha simulada do POST EnvioMassa');
    if (body.id !== undefined && st.envio.some((m) => m.id === body.id)) throw erroPg(409, '23505', 'duplicate key value violates unique constraint "EnvioMassa_pkey"');
    const id = body.id !== undefined ? body.id : (st.proximoId += 1);
    st.envio.push({ ...body, id }); return [{ id }];
  }
  throw new Error(`fake nao suporta: ${endpoint} [${method}]`);
}

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../lib/hub-rbac-cache') {
    const perms = new Set(['adiantamentos.pagamento_confirmar', 'adiantamentos.consultar']);
    return { obterPermissoesEfetivas: async () => perms, obterPermissoesEfetivasPorEntidade: async () => perms, obterModulosAtivosPorEntidade: async () => new Set(['adiantamentos']) };
  }
  if (request === './grupo') return { mesmoGrupoQue: async (_a, _b, cache) => { if (!cache.ids) cache.ids = new Set([6, 7]); return true; } };
  if (request === '../lib/hub-postgrest' || request === './hub-postgrest') return { hubPostgrestRequest: async (...a) => fakePostgrest(...a) };
  if (request === '../lib/hub-auditoria') return { registrarAuditoria: async (ev) => { st.auditoria.push(ev.acao); return { ok: true }; } };
  return originalLoad.apply(this, arguments);
};
const express = require('express');
const cookieParser = require('cookie-parser');
const { router } = require('../routes/hub-adiantamentos.js');
Module._load = originalLoad;

const app = express(); app.use(express.json()); app.use(cookieParser());
app.use('/api/v1/adiantamentos', router);
let server; let baseUrl; let sub = 1;
const cookie = () => `hub_accessToken=${jwt.sign({ sub: sub++, entidade_ativa: 6 }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' })}`;
before(async () => { await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); baseUrl = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());
beforeEach(resetEstado);

function gerar(periodo = PERIODO) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ confirmacao: true });
    const url = new URL(`/api/v1/adiantamentos/repasse/${periodo}/movimentos`, baseUrl);
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Cookie: cookie() } }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(ch).toString('utf8') || 'null') }));
    });
    req.on('error', reject); req.write(body); req.end();
  });
}
const pendente = (n, status = 'LIBERADA') => Array.from({ length: n }, (_, i) => ({ entregador_id: 100 + i, status }));

describe('POST /repasse/:periodo/movimentos — fechar-se-nao-existir, pre-flight e S1', () => {
  test('T12 gera sem fechar antes (C1): fecha, gera, EnvioMassa e trilha com o MESMO id, auditoria das duas acoes', async () => {
    const r = await gerar();
    assert.equal(r.status, 201);
    assert.equal(r.body.gerados, 1);
    assert.ok(st.chamadas.includes('POST rpc/hub_adiantamento_repasse_fechar'));
    assert.equal(st.envio.length, 1);
    assert.equal(st.trilha.length, 1);
    assert.equal(st.envio[0].id, st.trilha[0].envio_massa_id, 'a reserva guarda o id com que a EnvioMassa foi criada');
    assert.equal(st.envio[0].valor, 70, 'valor = nota_a_emitir (liquido), nao o bruto 100');
    assert.deepEqual(st.auditoria, ['adiantamento.repasse_fechado', 'adiantamento.movimentos_gerados']);
  });

  test('auditoria repasse_fechado sai ANTES do laco: erro depois do RPC commitado nao deixa semana fechada e nao auditada', async () => {
    st.falhaItens = true;
    const r = await gerar();
    assert.equal(r.status, 500);
    assert.ok(st.chamadas.includes('POST rpc/hub_adiantamento_repasse_fechar'));
    assert.deepEqual(st.auditoria, ['adiantamento.repasse_fechado']);
  });

  test('3.7: apuracao ja existente — NAO fecha de novo e audita so a geracao', async () => {
    st.apuracao = { id: 77, periodo_inicio: PERIODO, periodo_fim: '2026-10-25', configuracao_id: 9 };
    const r = await gerar();
    assert.equal(r.status, 201);
    assert.ok(!st.chamadas.includes('POST rpc/hub_adiantamento_repasse_fechar'));
    assert.deepEqual(st.auditoria, ['adiantamento.movimentos_gerados']);
  });

  test('T10 409 ADIANTAMENTOS_PENDENTES: nomeia, cap 20, omitidos, sem PII; nada fechado, nada criado', async () => {
    st.pendentes = [...pendente(10, 'LIBERADA'), ...pendente(15, 'EXPORTADA').map((p) => ({ ...p, entregador_id: p.entregador_id + 500 }))];
    st.entregadores = st.pendentes.map((p) => ({ id: p.entregador_id, nome: `Nome ${p.entregador_id}`, motorista_id: null, cnpj_prestador: '999', telefone: '119' }));
    const r = await gerar();
    assert.equal(r.status, 409);
    assert.equal(r.body.erro, 'ADIANTAMENTOS_PENDENTES');
    assert.equal(r.body.total, 25);
    assert.deepEqual(r.body.porStatus, { LIBERADA: 10, EXPORTADA: 15 });
    assert.equal(r.body.motoristas.length, 20);
    assert.equal(r.body.motoristasOmitidos, 5);
    assert.ok(r.body.motoristas.every((m) => typeof m.nome === 'string' && m.nome.startsWith('Nome ')));
    const todasChaves = (o) => (o && typeof o === 'object' ? Object.keys(o).concat(...Object.values(o).map(todasChaves)) : []);
    const chaves = todasChaves(r.body).join(' ').toLowerCase();
    for (const proibida of ['cnpj', 'telefone', 'conta', 'valor']) assert.ok(!chaves.includes(proibida), `chave proibida no corpo: ${proibida}`);
    assert.equal(st.apuracao, null, 'nada fechado');
    assert.equal(st.envio.length + st.trilha.length, 0, 'nada criado');
    assert.ok(!st.chamadas.includes('POST rpc/hub_adiantamento_repasse_fechar'));
  });

  test('T11 pendencia com apuracao JA fechada (C9b): o pre-flight roda mesmo assim e nada e criado', async () => {
    st.apuracao = { id: 77, periodo_inicio: PERIODO, periodo_fim: '2026-10-25', configuracao_id: 9 };
    st.pendentes = pendente(2);
    const r = await gerar();
    assert.equal(r.status, 409);
    assert.equal(r.body.erro, 'ADIANTAMENTOS_PENDENTES');
    assert.equal(st.envio.length + st.trilha.length, 0);
  });

  test('T11b C9c resolvidos os pendentes, passa: a recusa nao deixa residuo e o MESMO pedido vira 201 (US3-AS2)', async () => {
    st.pendentes = pendente(2);
    const recusa = await gerar();
    assert.equal(recusa.status, 409, 'controle: com pendencia recusa — sem isto o 201 abaixo nao prova a transicao');
    assert.equal(st.apuracao, null, 'a recusa nao fechou nada');
    assert.equal(st.envio.length + st.trilha.length, 0, 'a recusa nao criou nada');
    st.pendentes = []; // o financeiro resolveu os pendentes
    const ok = await gerar();
    assert.equal(ok.status, 201);
    assert.equal(ok.body.gerados, 1);
    assert.equal(st.envio.length, 1, 'exatamente um movimento: nada herdado da tentativa recusada');
    assert.equal(st.trilha.length, 1);
    assert.equal(st.envio[0].id, st.trilha[0].envio_massa_id);
  });

  test('T21 sem modelo de mensagem (C8): recusa ANTES de fechar, nunca inventa texto', async () => {
    st.vigente = { ...st.vigente, mensagem1_modelo: null };
    const r = await gerar();
    assert.equal(r.status, 409);
    assert.equal(r.body.erro, 'MODELO_MENSAGEM_AUSENTE');
    assert.equal(st.apuracao, null, 'o fechamento e irreversivel: nao fecha sem modelo');
    assert.equal(st.envio.length, 0);
  });

  test('T21b sem modelo na apuracao JA existente: recusa e nada e criado', async () => {
    st.apuracao = { id: 77, periodo_inicio: PERIODO, periodo_fim: '2026-10-25', configuracao_id: 9 };
    st.config = { mensagem1_modelo: '  ', mensagem2_modelo: null };
    const r = await gerar();
    assert.equal(r.status, 409);
    assert.equal(r.body.erro, 'MODELO_MENSAGEM_AUSENTE');
    assert.equal(st.envio.length + st.trilha.length, 0);
  });

  test('T20 as recusas do RPC de fechar nao somem: texto/codigo de cada uma, nada criado', async () => {
    for (const cod of ['APURACAO_FORA_DE_ORDEM', 'APURACAO_NAO_CONFIGURADA', 'PERIODO_DESALINHADO']) {
      resetEstado(); st.fecharErro = cod;
      const r = await gerar();
      assert.equal(r.status, 409, cod); assert.equal(r.body.erro, cod);
      assert.equal(st.envio.length + st.trilha.length, 0);
    }
    resetEstado(); st.fecharErro = 'PERMISSAO_NEGADA';
    assert.equal((await gerar()).status, 403);
  });

  test('T20b PERIODO_EM_ABERTO diz ATE QUANDO esperar (dia seguinte ao fim da semana + corte)', async () => {
    st.fecharErro = 'PERIODO_EM_ABERTO';
    const r = await gerar();
    assert.equal(r.status, 409);
    assert.equal(r.body.erro, 'PERIODO_EM_ABERTO');
    assert.deepEqual(r.body.liberaApos, { data: '2026-10-26', horario: '12:00:00', timezone: 'America/Sao_Paulo' });
  });

  test('corrida no fechamento: APURACAO_JA_FECHADA nao e erro — relê e gera', async () => {
    st.fecharErro = 'APURACAO_JA_FECHADA';
    // o concorrente fechou: a apuracao passa a existir depois do RPC recusar
    const orig = st.apuracao;
    Object.defineProperty(st, 'apuracao', { configurable: true, get() { return st.chamadas.includes('POST rpc/hub_adiantamento_repasse_fechar') ? { id: 77, periodo_inicio: PERIODO, periodo_fim: '2026-10-25', configuracao_id: 9 } : orig; }, set() {} });
    const r = await gerar();
    assert.equal(r.status, 201);
    assert.equal(r.body.gerados, 1);
  });

  test('T13/T15 falha do POST EnvioMassa: texto VERDADEIRO (reserva existe) e a retomada conclui com o MESMO id, sem duplicar', async () => {
    st.falhaEnvioPost = true;
    const r1 = await gerar();
    assert.equal(r1.status, 201);
    assert.equal(r1.body.gerados, 0);
    const rec = r1.body.recusados[0];
    assert.equal(rec.motivo, 'FALHA_AO_GRAVAR');
    assert.ok(!/nada foi gravado/i.test(rec.detalhe), 'a reserva EXISTE: "nada foi gravado" seria mentira');
    assert.match(rec.detalhe, /reserva foi registrada/);
    assert.equal(st.trilha.length, 1); assert.equal(st.envio.length, 0);
    const idReservado = st.trilha[0].envio_massa_id;

    st.falhaEnvioPost = false;
    const r2 = await gerar();
    assert.equal(r2.body.gerados, 1);
    assert.equal(st.envio.length, 1, 'exatamente uma nota');
    assert.equal(st.envio[0].id, idReservado, 'conclui com o MESMO id da reserva');
    assert.equal(st.trilha.length, 1, 'a reserva nao foi duplicada nem apagada');
    const r3 = await gerar();
    assert.equal(r3.body.gerados, 0); assert.equal(r3.body.recusados[0].motivo, 'JA_GERADO');
    assert.equal(st.envio.length, 1);
  });

  test('falha ao ALOCAR/reservar: "nada foi gravado" e verdade', async () => {
    st.falhaAlocar = true;
    const r = await gerar();
    assert.equal(r.body.recusados[0].motivo, 'FALHA_AO_GRAVAR');
    assert.match(r.body.recusados[0].detalhe, /nada foi gravado/);
    assert.equal(st.trilha.length + st.envio.length, 0);
  });

  test('T14 duas requisicoes concorrentes: ZERO duplicata (uma gera, a outra JA_GERADO sem escrever EnvioMassa)', async () => {
    st.apuracao = { id: 77, periodo_inicio: PERIODO, periodo_fim: '2026-10-25', configuracao_id: 9 };
    const [a, b] = await Promise.all([gerar(), gerar()]);
    assert.equal(st.envio.length, 1, 'exatamente uma nota fiscal');
    assert.equal(st.trilha.length, 1);
    assert.equal(a.body.gerados + b.body.gerados, 1);
    const perdedor = a.body.gerados === 0 ? a : b;
    assert.equal(perdedor.body.recusados[0].motivo, 'JA_GERADO');
  });

  test('T17 duas CONCLUSOES concorrentes da mesma reserva: exatamente uma linha (a PK serializa)', async () => {
    st.apuracao = { id: 77, periodo_inicio: PERIODO, periodo_fim: '2026-10-25', configuracao_id: 9 };
    st.trilha = [{ apuracao_id: 77, entregador_id: 1, envio_massa_id: 555, valor: 70, gorjeta: 20 }];
    const [a, b] = await Promise.all([gerar(), gerar()]);
    assert.equal(st.envio.length, 1);
    assert.equal(st.envio[0].id, 555);
    assert.equal(a.body.gerados + b.body.gerados, 1);
    // Revisao adversarial (achado 4): o PERDEDOR tem de dizer a verdade ("ja gerado"), nao "o movimento NAO foi criado".
    const perdedor = [a, b].find((r) => r.body.gerados === 0);
    assert.equal(perdedor.body.recusados.length, 1);
    assert.equal(perdedor.body.recusados[0].motivo, 'JA_GERADO');
  });

  test('reserva com valor/gorjeta DIFERENTES dos recomputados: nao conclui, nomeia a divergencia', async () => {
    st.apuracao = { id: 77, periodo_inicio: PERIODO, periodo_fim: '2026-10-25', configuracao_id: 9 };
    st.trilha = [{ apuracao_id: 77, entregador_id: 1, envio_massa_id: 555, valor: 100, gorjeta: 20 }];
    const r = await gerar();
    assert.equal(r.body.gerados, 0);
    assert.equal(r.body.recusados[0].motivo, 'FALHA_AO_GRAVAR');
    assert.match(r.body.recusados[0].detalhe, /diferentes dos calculados/);
    assert.equal(st.envio.length, 0);
  });

  test('T18 S7: movimento aberto de OUTRA empresa nao conta; o do grupo conta', async () => {
    st.apuracao = { id: 77, periodo_inicio: PERIODO, periodo_fim: '2026-10-25', configuracao_id: 9 };
    st.envio = [{ id: 1, cnpj_prestador: '90000000000011', mov_fechado: false, id_empresa: 999 }];
    const r = await gerar();
    assert.equal(r.body.gerados, 1, 'movimento aberto de empresa 999 (outro tenant) nao pode travar a Movee');
    resetEstado(); st.apuracao = { id: 77, periodo_inicio: PERIODO, periodo_fim: '2026-10-25', configuracao_id: 9 };
    st.envio = [{ id: 1, cnpj_prestador: '90000000000011', mov_fechado: false, id_empresa: 7 }];
    const r2 = await gerar();
    assert.equal(r2.body.gerados, 0);
    assert.equal(r2.body.recusados[0].motivo, 'MOVIMENTO_ABERTO');
  });

  test('P6/3.8: TODA leitura de EnvioMassa desta rota leva id_empresa=in.(<grupo>) (a tabela nao tem RLS)', async () => {
    st.apuracao = { id: 77, periodo_inicio: PERIODO, periodo_fim: '2026-10-25', configuracao_id: 9 };
    st.trilha = [{ apuracao_id: 77, entregador_id: 1, envio_massa_id: 555, valor: 70, gorjeta: 20 }];
    await gerar();
    assert.ok(st.leituras.length > 0, 'a rota leu EnvioMassa');
    for (const e of st.leituras) assert.match(e, /id_empresa=in\.\(6,7\)/, `leitura de EnvioMassa SEM filtro de tenant: ${e}`);
  });
});
