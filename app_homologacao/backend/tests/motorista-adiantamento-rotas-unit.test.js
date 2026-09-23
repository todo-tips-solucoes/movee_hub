/**
 * Testes unitários — routes/motorista-adiantamento.js (adiantamento-motorista,
 * tasks.md FASE 3, 3.1.8/3.1.9). Rodam com:
 * node --test tests/motorista-adiantamento-rotas-unit.test.js
 *
 * Mesma técnica de tests/motorista-push-rotas-unit.test.js: express real +
 * node:http + app.listen(0), mockando `../lib/hub-postgrest` via Module._load
 * (sem PostgREST real). `authenticateMotorista` é simulado por um middleware
 * que seta `req.motorista` a partir de um header de teste — mesma identidade
 * que o middleware real extrairia do token.
 *
 * Cobre 3.1.8 (4 status de POST /motorista/adiantamentos: 201, 200 reenvio,
 * 400, 409) e 3.1.9 (nenhum id de conta/entregador/empresa aceito do corpo
 * ou da query — Constitution II).
 *
 * Ref: contracts/motorista-api.md §Parte 2, contracts/sql-rpc.md, tasks.md 3.1.
 */

'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// ──────────────────────────────────────────────────────────────────────────
// Mock de ../lib/hub-postgrest via Module._load (mesma técnica de
// motorista-push-rotas-unit.test.js) — dispatch por endpoint, configurável
// por teste via `mockRespostas`.
// ──────────────────────────────────────────────────────────────────────────
let chamadasPostgrest = [];
let mockRespostas = {};

function erroRpc(codigo) {
  return Object.assign(new Error(`hub-postgrest: 400 Bad Request — ${codigo}`), { body: codigo, status: 400 });
}

// 11.1 (converge onda-039): mock de ./grupo — por padrão TODA empresa está
// no grupo (mesmoGrupoQue resolve true), preservando os testes existentes;
// `grupoIds` permite a um teste específico simular OUTSIDE_GROUP.
let grupoIds = null; // null = todo mundo no grupo (comportamento pré-11.1)
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './grupo') {
    return {
      mesmoGrupoQue: async (idEmpresa, _idReferencia, cache) => {
        if (grupoIds === null) return true;
        if (!cache.ids) cache.ids = new Set(grupoIds);
        return cache.ids.has(Number(idEmpresa));
      },
    };
  }
  if (request === '../lib/hub-postgrest') {
    return {
      hubPostgrestRequest: async (endpoint, method, body, claims, opts) => {
        chamadasPostgrest.push({ endpoint, method, body, claims, opts });
        const r = mockRespostas[endpoint];
        if (r === undefined) return null;
        if (typeof r === 'function') return r(body);
        if (r instanceof Error) throw r;
        return r;
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

const express = require('express');
const { router } = require('../routes/motorista-adiantamento.js');

Module._load = originalLoad;

const app = express();
app.use(express.json());
// Simula authenticateMotorista: identidade só via header de teste, nunca do corpo/query.
app.use((req, res, next) => {
  req.motorista = { cnpjPrestador: req.headers['x-test-cnpj'] || '11111111000191' };
  next();
});
app.use('/motorista', router);

let server;
let baseUrl;

function request(method, path, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const h = Object.assign({}, headers);
    if (bodyStr) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: h },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let json;
          try {
            json = data ? JSON.parse(data) : null;
          } catch (_) {
            json = data;
          }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  chamadasPostgrest = [];
  mockRespostas = {};
  grupoIds = null; // 11.1: reseta para "todo mundo no grupo" entre testes
});

// --- Fixtures ----------------------------------------------------------------

const CONFIG_VIGENTE_ID = 501;
const CONFIG_VIGENTE_VERSAO = 3;

function disponibilidadeRow(overrides) {
  return Object.assign(
    {
      vinculado: true,
      modulo_ativo: true,
      configuracao_id: CONFIG_VIGENTE_ID,
      configuracao_versao: CONFIG_VIGENTE_VERSAO,
      configuracao_completa: true,
      dias_habilitados: [1, 2, 3, 4, 5, 6],
      horario_abertura: '09:00:00',
      horario_corte: '15:00:00',
      percentual: 60,
      taxa_fixa: 0.35,
      previsao_pagamento_texto: 'entre 17h e 18h de hoje',
      id_empresa: 6, // 11.1: usado pela checagem mesmoGrupoQue(id_empresa, 6)
      dia_habilitado: true,
      antes_abertura: false,
      apos_corte: false,
      data_solicitacao: '2026-09-17',
      data_producao: '2026-09-16',
      // 3.7.1/dec-071: prévia D-1 (produção -> bruto -> líquido), reusada
      // pelas rotas via dinheiro(); default "com produção disponível".
      estimate: { available: true, production: 100, gross: 60, fee: 0.35, net: 59.65, final: false },
      conta_aprovada: {
        id: 77,
        status: 'APROVADA',
        titularNome: 'Fulano',
        titularDocumento: '***.***.***-41',
        bancoCodigo: '260',
        bancoNome: 'Nu Pagamentos',
        agencia: '0001',
        conta: '**1234',
        contaDigito: '5',
        tipoConta: 'CORRENTE',
        alertas: [],
        motivoRejeicao: null,
        solicitadaEm: '2026-08-01T10:00:00Z',
        revisadaEm: '2026-08-02T10:00:00Z',
      },
      conta_pendente: null,
      solicitacao_do_dia: null,
      motivo_indisponivel: null,
    },
    overrides,
  );
}

function solicitacaoJsonb(overrides) {
  return Object.assign(
    {
      id: 42,
      id_empresa: 6,
      configuracao_id: CONFIG_VIGENTE_ID,
      data_solicitacao: '2026-09-17',
      data_producao: '2026-09-16',
      solicitada_em: '2026-09-17T09:05:00Z',
      status: 'AGUARDANDO_CORTE',
      motivo_status: null,
      fonte_producao: null,
      producao_valor: null,
      percentual: null,
      valor_bruto: null,
      taxa: null,
      valor_liquido: null,
      calculado_em: null,
      conta_bancaria_id: null,
      // 3.7.2/3.7.3 (dec-071): retrato gravado com a solicitação, devolvido
      // por hub_adiantamento_detalhe_motorista — versão/previsão sempre
      // presentes (config é imutável); conta só a partir do cálculo.
      configuracao_versao: CONFIG_VIGENTE_VERSAO,
      previsao_pagamento_texto: 'entre 17h e 18h de hoje',
      conta_bancaria_mascarada: null,
    },
    overrides,
  );
}

function detalheResposta(sol, eventos) {
  return [{ solicitacao: sol, eventos: eventos || [] }];
}

const CORPO_SOLICITACAO_VALIDO = {
  aceite: true,
  chaveIdempotencia: '11111111-1111-4111-8111-111111111111',
  configuracaoId: CONFIG_VIGENTE_ID,
};

// --- GET /motorista/adiantamento/disponibilidade ----------------------------

describe('GET /motorista/adiantamento/disponibilidade', () => {
  test('tudo elegível -> canRequest:true, reason:null, configVersion=versao, configuracaoId=PK', async () => {
    mockRespostas['rpc/hub_adiantamento_disponibilidade'] = [disponibilidadeRow()];
    const r = await request('GET', '/motorista/adiantamento/disponibilidade', { headers: { 'x-test-cnpj': 'cnpj-a' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.canRequest, true);
    assert.equal(r.body.reason, null);
    assert.equal(r.body.configVersion, CONFIG_VIGENTE_VERSAO); // 3.7.3/dec-071: exibição, nunca o PK
    assert.equal(r.body.configuracaoId, CONFIG_VIGENTE_ID); // identificador enviado em POST /adiantamentos
    assert.equal(r.body.timezone, 'America/Sao_Paulo');
    assert.equal(r.body.fee, '0.35');
    assert.equal(r.body.bankAccount.bank, '260 – Nu Pagamentos');
  });

  test('estimate: prévia D-1 formatada em dinheiro (3.7.1/dec-071)', async () => {
    mockRespostas['rpc/hub_adiantamento_disponibilidade'] = [disponibilidadeRow()];
    const r = await request('GET', '/motorista/adiantamento/disponibilidade', { headers: { 'x-test-cnpj': 'cnpj-a2' } });
    assert.deepEqual(r.body.estimate, {
      available: true, production: '100.00', gross: '60.00', fee: '0.35', net: '59.65', final: false,
    });
  });

  test('estimate: available=false quando produção D-1 ainda não chegou', async () => {
    mockRespostas['rpc/hub_adiantamento_disponibilidade'] = [
      disponibilidadeRow({ estimate: { available: false, production: null, gross: null, fee: 0.35, net: null, final: false } }),
    ];
    const r = await request('GET', '/motorista/adiantamento/disponibilidade', { headers: { 'x-test-cnpj': 'cnpj-a3' } });
    assert.deepEqual(r.body.estimate, {
      available: false, production: null, gross: null, fee: '0.35', net: null, final: false,
    });
  });

  test('estimate: null quando a própria configuração não existe (NOT_CONFIGURED)', async () => {
    mockRespostas['rpc/hub_adiantamento_disponibilidade'] = [
      disponibilidadeRow({ configuracao_id: null, configuracao_versao: null, configuracao_completa: false, estimate: null, motivo_indisponivel: 'NOT_CONFIGURED' }),
    ];
    const r = await request('GET', '/motorista/adiantamento/disponibilidade', { headers: { 'x-test-cnpj': 'cnpj-a4' } });
    assert.equal(r.body.estimate, null);
  });

  test('sem vínculo -> reason NOT_LINKED, canRequest:false', async () => {
    mockRespostas['rpc/hub_adiantamento_disponibilidade'] = [
      disponibilidadeRow({
        vinculado: false, modulo_ativo: false, configuracao_id: null, configuracao_completa: false,
        dias_habilitados: null, horario_abertura: null, horario_corte: null, percentual: null, taxa_fixa: null,
        previsao_pagamento_texto: null, dia_habilitado: false, antes_abertura: false, apos_corte: false,
        conta_aprovada: null, conta_pendente: null, motivo_indisponivel: 'NOT_LINKED',
      }),
    ];
    const r = await request('GET', '/motorista/adiantamento/disponibilidade', { headers: { 'x-test-cnpj': 'cnpj-b' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.canRequest, false);
    assert.equal(r.body.reason, 'NOT_LINKED');
    assert.equal(r.body.nextAvailableAt, null);
  });

  test('11.1: módulo ativo mas empresa FORA do grupo Movee -> reason OUTSIDE_GROUP (defesa em profundidade)', async () => {
    grupoIds = [6]; // só a empresa 6 (e seus membros) está no grupo
    mockRespostas['rpc/hub_adiantamento_disponibilidade'] = [disponibilidadeRow({ id_empresa: 999 })];
    const r = await request('GET', '/motorista/adiantamento/disponibilidade', { headers: { 'x-test-cnpj': 'cnpj-outside-group' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.canRequest, false);
    assert.equal(r.body.reason, 'OUTSIDE_GROUP');
  });

  test('já solicitado hoje -> reason ALREADY_REQUESTED, todayRequest preenchido', async () => {
    mockRespostas['rpc/hub_adiantamento_disponibilidade'] = [
      disponibilidadeRow({ solicitacao_do_dia: { id: 42, status: 'AGUARDANDO_CORTE' } }),
    ];
    const r = await request('GET', '/motorista/adiantamento/disponibilidade', { headers: { 'x-test-cnpj': 'cnpj-c' } });
    assert.equal(r.body.reason, 'ALREADY_REQUESTED');
    assert.deepEqual(r.body.todayRequest, { id: 42, status: 'AGUARDANDO_CORTE', integrationId: 'ADV-000042' });
  });

  test('sem conta aprovada nem pendente -> reason NO_BANK_ACCOUNT', async () => {
    mockRespostas['rpc/hub_adiantamento_disponibilidade'] = [disponibilidadeRow({ conta_aprovada: null })];
    const r = await request('GET', '/motorista/adiantamento/disponibilidade', { headers: { 'x-test-cnpj': 'cnpj-d' } });
    assert.equal(r.body.reason, 'NO_BANK_ACCOUNT');
  });

  test('falha do PostgREST -> 502 INDISPONIVEL', async () => {
    mockRespostas['rpc/hub_adiantamento_disponibilidade'] = new Error('boom');
    const r = await request('GET', '/motorista/adiantamento/disponibilidade', { headers: { 'x-test-cnpj': 'cnpj-e' } });
    assert.equal(r.status, 502);
    assert.equal(r.body.erro, 'INDISPONIVEL');
  });
});

// --- GET /motorista/adiantamento/regras -------------------------------------

describe('GET /motorista/adiantamento/regras', () => {
  test('config vigente -> 200 com configVersion=versao e configuracaoId=PK', async () => {
    mockRespostas['rpc/hub_adiantamento_disponibilidade'] = [disponibilidadeRow()];
    const r = await request('GET', '/motorista/adiantamento/regras', { headers: { 'x-test-cnpj': 'cnpj-f' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.configVersion, CONFIG_VIGENTE_VERSAO);
    assert.equal(r.body.configuracaoId, CONFIG_VIGENTE_ID);
    assert.equal(r.body.itens.length, 8);
    assert.match(r.body.aceiteSha256, /^[0-9a-f]{64}$/);
  });

  test('sem vínculo -> 409 SOLICITACAO_INDISPONIVEL motivo=NOT_LINKED', async () => {
    mockRespostas['rpc/hub_adiantamento_disponibilidade'] = [
      disponibilidadeRow({ vinculado: false, configuracao_id: null, motivo_indisponivel: 'NOT_LINKED' }),
    ];
    const r = await request('GET', '/motorista/adiantamento/regras', { headers: { 'x-test-cnpj': 'cnpj-g' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.erro, 'SOLICITACAO_INDISPONIVEL');
    assert.equal(r.body.motivo, 'NOT_LINKED');
  });
});

// --- POST /motorista/adiantamentos (3.1.8: 201, 200, 400, 409) --------------

describe('POST /motorista/adiantamentos', () => {
  test('aceite ausente -> 400 DADOS_INVALIDOS motivo=aceite', async () => {
    const r = await request('POST', '/motorista/adiantamentos', {
      headers: { 'x-test-cnpj': 'cnpj-h' },
      body: { chaveIdempotencia: CORPO_SOLICITACAO_VALIDO.chaveIdempotencia, configuracaoId: 1 },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.erro, 'DADOS_INVALIDOS');
    assert.equal(r.body.motivo, 'aceite');
    assert.equal(chamadasPostgrest.length, 0);
  });

  test('chaveIdempotencia não-uuid -> 400 DADOS_INVALIDOS motivo=chaveIdempotencia', async () => {
    const r = await request('POST', '/motorista/adiantamentos', {
      headers: { 'x-test-cnpj': 'cnpj-i' },
      body: { ...CORPO_SOLICITACAO_VALIDO, chaveIdempotencia: 'nao-e-uuid' },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.motivo, 'chaveIdempotencia');
  });

  test('configuracaoId ausente -> 400 DADOS_INVALIDOS motivo=configuracaoId', async () => {
    const r = await request('POST', '/motorista/adiantamentos', {
      headers: { 'x-test-cnpj': 'cnpj-j' },
      body: { aceite: true, chaveIdempotencia: CORPO_SOLICITACAO_VALIDO.chaveIdempotencia },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.motivo, 'configuracaoId');
  });

  test('201: criada com sucesso, chave/id/empresa do corpo são ignorados (3.1.9)', async () => {
    mockRespostas['rpc/hub_adiantamento_disponibilidade'] = [disponibilidadeRow()];
    mockRespostas['rpc/hub_adiantamento_solicitar'] = [{ id: 42, status: 'AGUARDANDO_CORTE', reutilizado: false }];
    mockRespostas['rpc/hub_adiantamento_detalhe_motorista'] = detalheResposta(solicitacaoJsonb());

    const r = await request('POST', '/motorista/adiantamentos', {
      headers: { 'x-test-cnpj': 'cnpj-k' },
      body: { ...CORPO_SOLICITACAO_VALIDO, cnpjPrestador: '00000000000000', entregadorId: 999, idEmpresa: 1 },
    });

    assert.equal(r.status, 201);
    assert.equal(r.body.id, 42);
    assert.equal(r.body.integrationId, 'ADV-000042');
    assert.equal(r.body.status, 'AGUARDANDO_CORTE');
    assert.equal(r.body.calculo, null);

    const chamadaSolicitar = chamadasPostgrest.find((c) => c.endpoint === 'rpc/hub_adiantamento_solicitar');
    assert.equal(chamadaSolicitar.claims.motoristaCnpj, 'cnpj-k'); // identidade SEMPRE do token
    assert.equal(chamadaSolicitar.body.p_configuracao_id, CONFIG_VIGENTE_ID);
    assert.match(chamadaSolicitar.body.p_aceite_sha256, /^[0-9a-f]{64}$/); // nunca vem do corpo
    assert.equal(chamadaSolicitar.body.p_entregador_id, undefined);
    assert.equal(chamadaSolicitar.body.p_id_empresa, undefined);
  });

  test('11.1: módulo ativo mas empresa FORA do grupo -> 409 SOLICITACAO_INDISPONIVEL/OUTSIDE_GROUP, sem chamar hub_adiantamento_solicitar', async () => {
    grupoIds = [6];
    mockRespostas['rpc/hub_adiantamento_disponibilidade'] = [disponibilidadeRow({ id_empresa: 999 })];
    const r = await request('POST', '/motorista/adiantamentos', {
      headers: { 'x-test-cnpj': 'cnpj-outside-group' },
      body: CORPO_SOLICITACAO_VALIDO,
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.erro, 'SOLICITACAO_INDISPONIVEL');
    assert.equal(r.body.motivo, 'OUTSIDE_GROUP');
    assert.equal(chamadasPostgrest.some((c) => c.endpoint === 'rpc/hub_adiantamento_solicitar'), false);
  });

  test('200: reenvio idempotente (reutilizado:true)', async () => {
    mockRespostas['rpc/hub_adiantamento_disponibilidade'] = [disponibilidadeRow()];
    mockRespostas['rpc/hub_adiantamento_solicitar'] = [{ id: 42, status: 'AGUARDANDO_CORTE', reutilizado: true }];
    mockRespostas['rpc/hub_adiantamento_detalhe_motorista'] = detalheResposta(solicitacaoJsonb());

    const r = await request('POST', '/motorista/adiantamentos', {
      headers: { 'x-test-cnpj': 'cnpj-l' },
      body: CORPO_SOLICITACAO_VALIDO,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.id, 42);
  });

  test('409 VERSAO_DESATUALIZADA: configuracaoId ≠ vigente (sem nem chamar _solicitar)', async () => {
    mockRespostas['rpc/hub_adiantamento_disponibilidade'] = [disponibilidadeRow({ configuracao_id: 999 })];
    const r = await request('POST', '/motorista/adiantamentos', {
      headers: { 'x-test-cnpj': 'cnpj-m' },
      body: CORPO_SOLICITACAO_VALIDO, // configuracaoId=501, vigente=999
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.erro, 'VERSAO_DESATUALIZADA');
    assert.equal(chamadasPostgrest.some((c) => c.endpoint === 'rpc/hub_adiantamento_solicitar'), false);
  });

  test('409 SOLICITACAO_INDISPONIVEL: ALREADY_REQUESTED da RPC, com nextAvailableAt', async () => {
    mockRespostas['rpc/hub_adiantamento_disponibilidade'] = [disponibilidadeRow()];
    mockRespostas['rpc/hub_adiantamento_solicitar'] = erroRpc('ALREADY_REQUESTED');
    const r = await request('POST', '/motorista/adiantamentos', {
      headers: { 'x-test-cnpj': 'cnpj-n' },
      body: CORPO_SOLICITACAO_VALIDO,
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.erro, 'SOLICITACAO_INDISPONIVEL');
    assert.equal(r.body.motivo, 'ALREADY_REQUESTED');
    assert.match(r.body.nextAvailableAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });

  test('11.3: sem dia habilitado -> nextAvailableAt null (nunca fabrica hoje+8, mesma guarda do GET disponibilidade)', async () => {
    mockRespostas['rpc/hub_adiantamento_disponibilidade'] = [disponibilidadeRow({ dias_habilitados: [] })];
    mockRespostas['rpc/hub_adiantamento_solicitar'] = erroRpc('ALREADY_REQUESTED');
    const r = await request('POST', '/motorista/adiantamentos', {
      headers: { 'x-test-cnpj': 'cnpj-n2' },
      body: CORPO_SOLICITACAO_VALIDO,
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.motivo, 'ALREADY_REQUESTED');
    assert.equal(r.body.nextAvailableAt, null);
  });

  test('409 SOLICITACAO_INDISPONIVEL: MODULO_DESABILITADO (SQL) vira motivo=MODULE_DISABLED (enum)', async () => {
    mockRespostas['rpc/hub_adiantamento_disponibilidade'] = [disponibilidadeRow()];
    mockRespostas['rpc/hub_adiantamento_solicitar'] = erroRpc('MODULO_DESABILITADO');
    const r = await request('POST', '/motorista/adiantamentos', {
      headers: { 'x-test-cnpj': 'cnpj-o' },
      body: CORPO_SOLICITACAO_VALIDO,
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.motivo, 'MODULE_DISABLED');
  });
});

// --- GET /motorista/adiantamentos (lista) e /:id ----------------------------

describe('GET /motorista/adiantamentos', () => {
  test('lista com total (3.1.4)', async () => {
    mockRespostas['rpc/hub_adiantamento_listar_motorista'] = [
      { id: 42, status: 'LIBERADA', data_solicitacao: '2026-09-17', data_producao: '2026-09-16', valor_bruto: 60, valor_liquido: 59.65, motivo_status: null, total: 3 },
    ];
    const r = await request('GET', '/motorista/adiantamentos?pagina=1', { headers: { 'x-test-cnpj': 'cnpj-p' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 3);
    assert.equal(r.body.porPagina, 20);
    assert.equal(r.body.itens[0].statusRotulo, 'Adiantamento liberado');
    assert.equal(r.body.itens[0].valorLiquido, '59.65');
  });

  test('página vazia -> total:0 (fallback documentado)', async () => {
    mockRespostas['rpc/hub_adiantamento_listar_motorista'] = [];
    const r = await request('GET', '/motorista/adiantamentos?pagina=99', { headers: { 'x-test-cnpj': 'cnpj-q' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.itens, []);
    assert.equal(r.body.total, 0);
  });

  test('pagina inválida -> 400 DADOS_INVALIDOS motivo=pagina, sem chamar a RPC', async () => {
    const r = await request('GET', '/motorista/adiantamentos?pagina=0', { headers: { 'x-test-cnpj': 'cnpj-r' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.motivo, 'pagina');
    assert.equal(chamadasPostgrest.length, 0);
  });
});

describe('GET /motorista/adiantamentos/:id', () => {
  test('encontrada -> 200 com timeline traduzida', async () => {
    mockRespostas['rpc/hub_adiantamento_detalhe_motorista'] = detalheResposta(
      solicitacaoJsonb({ status: 'LIBERADA', calculado_em: '2026-09-17T15:00:05Z', producao_valor: 100, percentual: 60, valor_bruto: 60, taxa: 0.35, valor_liquido: 59.65, fonte_producao: 'financeiro_lancamento' }),
      [{ statusDe: null, statusPara: 'AGUARDANDO_CORTE', ocorridoEm: '2026-09-17T09:05:00Z', motivo: null },
       { statusDe: 'AGUARDANDO_CORTE', statusPara: 'LIBERADA', ocorridoEm: '2026-09-17T15:00:05Z', motivo: null }],
    );
    const r = await request('GET', '/motorista/adiantamentos/42', { headers: { 'x-test-cnpj': 'cnpj-s' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.calculo.liquido, '59.65');
    assert.equal(r.body.timeline.length, 2);
    assert.equal(r.body.timeline[0].etapa, 'Solicitação recebida');
    assert.equal(r.body.timeline[1].etapa, 'Adiantamento liberado');
    assert.equal(r.body.configVersion, CONFIG_VIGENTE_VERSAO); // 3.7.3/dec-071
    assert.equal(r.body.previsaoPagamento, 'entre 17h e 18h de hoje'); // 3.7.2/dec-071
  });

  test('LIBERADA com conta snapshot -> contaMascarada preenchida (3.7.2/dec-071)', async () => {
    mockRespostas['rpc/hub_adiantamento_detalhe_motorista'] = detalheResposta(
      solicitacaoJsonb({
        status: 'LIBERADA',
        conta_bancaria_mascarada: {
          status: 'APROVADA', bancoCodigo: '260', bancoNome: 'Nu Pagamentos',
          agencia: '0001', tipoConta: 'CORRENTE', conta: '**1234', contaDigito: '5',
        },
      }),
    );
    const r = await request('GET', '/motorista/adiantamentos/42', { headers: { 'x-test-cnpj': 'cnpj-s2' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.contaMascarada, {
      status: 'APROVADA', bank: '260 – Nu Pagamentos', masked: 'Ag. 0001 · CORRENTE **1234-5',
    });
  });

  test('AGUARDANDO_CORTE (sem cálculo ainda) -> contaMascarada null, previsão já vem da config gravada (3.7.2/dec-071)', async () => {
    mockRespostas['rpc/hub_adiantamento_detalhe_motorista'] = detalheResposta(solicitacaoJsonb());
    const r = await request('GET', '/motorista/adiantamentos/42', { headers: { 'x-test-cnpj': 'cnpj-s3' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.contaMascarada, null);
    assert.equal(r.body.previsaoPagamento, 'entre 17h e 18h de hoje');
  });

  test('não é do motorista (RPC devolve vazio) -> 404 NAO_ENCONTRADO', async () => {
    mockRespostas['rpc/hub_adiantamento_detalhe_motorista'] = [];
    const r = await request('GET', '/motorista/adiantamentos/999', { headers: { 'x-test-cnpj': 'cnpj-t' } });
    assert.equal(r.status, 404);
    assert.equal(r.body.erro, 'NAO_ENCONTRADO');
  });

  test('id não numérico -> 404 sem chamar a RPC', async () => {
    const r = await request('GET', '/motorista/adiantamentos/abc', { headers: { 'x-test-cnpj': 'cnpj-u' } });
    assert.equal(r.status, 404);
    assert.equal(chamadasPostgrest.length, 0);
  });
});

// --- POST /motorista/adiantamentos/:id/cancelar -----------------------------

describe('POST /motorista/adiantamentos/:id/cancelar', () => {
  test('sucesso -> 200 com detalhe CANCELADA', async () => {
    mockRespostas['rpc/hub_adiantamento_cancelar'] = [{ id: 42, status: 'CANCELADA' }];
    mockRespostas['rpc/hub_adiantamento_detalhe_motorista'] = detalheResposta(solicitacaoJsonb({ status: 'CANCELADA' }));
    const r = await request('POST', '/motorista/adiantamentos/42/cancelar', { headers: { 'x-test-cnpj': 'cnpj-v' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'CANCELADA');
    const chamada = chamadasPostgrest.find((c) => c.endpoint === 'rpc/hub_adiantamento_cancelar');
    assert.equal(chamada.claims.motoristaCnpj, 'cnpj-v');
  });

  test('NAO_ENCONTRADA (SQL) -> 404 NAO_ENCONTRADO', async () => {
    mockRespostas['rpc/hub_adiantamento_cancelar'] = erroRpc('NAO_ENCONTRADA');
    const r = await request('POST', '/motorista/adiantamentos/999/cancelar', { headers: { 'x-test-cnpj': 'cnpj-w' } });
    assert.equal(r.status, 404);
    assert.equal(r.body.erro, 'NAO_ENCONTRADO');
  });

  test('TRANSICAO_INVALIDA (fora de AGUARDANDO_CORTE ou depois do corte) -> 409', async () => {
    mockRespostas['rpc/hub_adiantamento_cancelar'] = erroRpc('TRANSICAO_INVALIDA');
    const r = await request('POST', '/motorista/adiantamentos/42/cancelar', { headers: { 'x-test-cnpj': 'cnpj-x' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.erro, 'TRANSICAO_INVALIDA');
  });

  test('AFTER_CUTOFF (SQL) também vira 409 TRANSICAO_INVALIDA (edge #22)', async () => {
    mockRespostas['rpc/hub_adiantamento_cancelar'] = erroRpc('AFTER_CUTOFF');
    const r = await request('POST', '/motorista/adiantamentos/42/cancelar', { headers: { 'x-test-cnpj': 'cnpj-y' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.erro, 'TRANSICAO_INVALIDA');
  });
});

// --- 3.2 GET /motorista/conta-bancaria ---------------------------------------

function contaMascaradaSql(overrides) {
  return Object.assign(
    {
      id: 77, status: 'APROVADA', titularNome: 'Fulano Teste', titularDocumento: '*********01',
      bancoCodigo: '001', bancoNome: 'Banco do Brasil', agencia: '1234', conta: '******45',
      contaDigito: '6', tipoConta: 'CORRENTE', chavePixTipo: null, emailComprovante: null,
      alertas: [], motivoRejeicao: null, solicitadaEm: '2026-08-01T10:00:00Z', revisadaEm: null,
    },
    overrides,
  );
}

describe('GET /motorista/conta-bancaria', () => {
  test('3.2.1: mapeia banco/contaMascarada/documentoMascarado a partir do jsonb já mascarado pelo SQL', async () => {
    mockRespostas['rpc/hub_conta_bancaria_motorista'] = [{
      aprovada: contaMascaradaSql(),
      pendente: contaMascaradaSql({ id: 78, status: 'PENDENTE', chavePixTipo: 'EMAIL', emailComprovante: 'jo••••@•••.com' }),
      ultima_rejeitada: null,
    }];
    const r = await request('GET', '/motorista/conta-bancaria', { headers: { 'x-test-cnpj': 'cnpj-cb1' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.aprovada, {
      id: 77, status: 'APROVADA', banco: '001 – Banco do Brasil', agencia: '1234',
      contaMascarada: '******45-6', tipoConta: 'CORRENTE', titularNome: 'Fulano Teste',
      documentoMascarado: '***.***.***-01', chavePixTipo: null, emailComprovante: null,
      solicitadaEm: '2026-08-01T10:00:00Z', motivoRejeicao: null,
    });
    assert.equal(r.body.pendente.chavePixTipo, 'EMAIL');
    assert.equal(r.body.pendente.emailComprovante, 'jo••••@•••.com'); // 3.2/dec-074
    assert.equal(r.body.ultimaRejeicao, null);
  });

  test('3.2.1: documentoMascarado formata CNPJ (14 dígitos mascarados) com barra', async () => {
    mockRespostas['rpc/hub_conta_bancaria_motorista'] = [{
      aprovada: contaMascaradaSql({ titularDocumento: '************90' }), pendente: null, ultima_rejeitada: null,
    }];
    const r = await request('GET', '/motorista/conta-bancaria', { headers: { 'x-test-cnpj': 'cnpj-cb2' } });
    assert.equal(r.body.aprovada.documentoMascarado, '**.***.***/****-90');
  });

  test('falha do PostgREST -> 502 INDISPONIVEL', async () => {
    mockRespostas['rpc/hub_conta_bancaria_motorista'] = new Error('boom');
    const r = await request('GET', '/motorista/conta-bancaria', { headers: { 'x-test-cnpj': 'cnpj-cb3' } });
    assert.equal(r.status, 502);
    assert.equal(r.body.erro, 'INDISPONIVEL');
  });
});

// --- 3.2 POST /motorista/conta-bancaria/solicitacoes -------------------------

const CORPO_CONTA_VALIDO = {
  titularNome: 'Fulano Teste',
  titularDocumento: '12345678909', // CPF com DV válido (mesmo valor de tests/adiantamento-conta-unit.test.js)
  bancoCodigo: '001',
  agencia: '1234',
  conta: '99998888',
  contaDigito: '2',
  tipoConta: 'CORRENTE',
};

describe('POST /motorista/conta-bancaria/solicitacoes', () => {
  test('3.2.2: dados válidos -> 201 com a conta PENDENTE mascarada (releitura via hub_conta_bancaria_motorista)', async () => {
    mockRespostas['rpc/hub_adiantamento_disponibilidade'] = [disponibilidadeRow()];
    mockRespostas['rpc/hub_conta_bancaria_solicitar'] = [{ id: 99, status: 'PENDENTE' }];
    mockRespostas['rpc/hub_conta_bancaria_motorista'] = [{
      aprovada: contaMascaradaSql(), pendente: contaMascaradaSql({ id: 99, status: 'PENDENTE' }), ultima_rejeitada: null,
    }];
    const r = await request('POST', '/motorista/conta-bancaria/solicitacoes', {
      headers: { 'x-test-cnpj': 'cnpj-cb4' }, body: CORPO_CONTA_VALIDO,
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.id, 99);
    assert.equal(r.body.status, 'PENDENTE');
  });

  test('3.2.6/S6/CHK019: a RPC recebe só os campos do contrato (normalizados) — sem mass assignment', async () => {
    mockRespostas['rpc/hub_adiantamento_disponibilidade'] = [disponibilidadeRow()];
    mockRespostas['rpc/hub_conta_bancaria_solicitar'] = [{ id: 99, status: 'PENDENTE' }];
    mockRespostas['rpc/hub_conta_bancaria_motorista'] = [{ aprovada: null, pendente: contaMascaradaSql({ id: 99, status: 'PENDENTE' }), ultima_rejeitada: null }];
    await request('POST', '/motorista/conta-bancaria/solicitacoes', {
      headers: { 'x-test-cnpj': 'cnpj-cb5' },
      body: { ...CORPO_CONTA_VALIDO, idEmpresa: 999, entregadorId: 1, id: 12345, status: 'APROVADA' },
    });
    const chamada = chamadasPostgrest.find((c) => c.endpoint === 'rpc/hub_conta_bancaria_solicitar');
    assert.deepEqual(Object.keys(chamada.body.p_dados).sort(), [
      'agencia', 'bancoCodigo', 'bancoNome', 'chavePix', 'chavePixTipo', 'conta', 'contaDigito',
      'emailComprovante', 'tipoConta', 'titularDocumento', 'titularNome', 'titularTipo',
    ]);
    assert.equal(chamada.claims.motoristaCnpj, 'cnpj-cb5'); // identidade sempre do token
  });

  test('titularNome ausente -> 400 DADOS_INVALIDOS motivo=titularNome (sem chamar a RPC)', async () => {
    const r = await request('POST', '/motorista/conta-bancaria/solicitacoes', {
      headers: { 'x-test-cnpj': 'cnpj-cb6' }, body: { ...CORPO_CONTA_VALIDO, titularNome: '' },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.motivo, 'titularNome');
    assert.equal(chamadasPostgrest.length, 0);
  });

  test('NOT_LINKED (SQL) -> 409 SOLICITACAO_INDISPONIVEL motivo=NOT_LINKED', async () => {
    mockRespostas['rpc/hub_adiantamento_disponibilidade'] = [disponibilidadeRow()];
    mockRespostas['rpc/hub_conta_bancaria_solicitar'] = erroRpc('NOT_LINKED');
    const r = await request('POST', '/motorista/conta-bancaria/solicitacoes', {
      headers: { 'x-test-cnpj': 'cnpj-cb7' }, body: CORPO_CONTA_VALIDO,
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.erro, 'SOLICITACAO_INDISPONIVEL');
    assert.equal(r.body.motivo, 'NOT_LINKED');
  });

  test('12.1 (converge onda-044, FR-015): módulo ativo mas empresa FORA do grupo -> 409 SOLICITACAO_INDISPONIVEL/OUTSIDE_GROUP, sem chamar hub_conta_bancaria_solicitar', async () => {
    grupoIds = [6];
    mockRespostas['rpc/hub_adiantamento_disponibilidade'] = [disponibilidadeRow({ id_empresa: 999 })];
    const r = await request('POST', '/motorista/conta-bancaria/solicitacoes', {
      headers: { 'x-test-cnpj': 'cnpj-outside-group-cb' }, body: CORPO_CONTA_VALIDO,
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.erro, 'SOLICITACAO_INDISPONIVEL');
    assert.equal(r.body.motivo, 'OUTSIDE_GROUP');
    assert.equal(chamadasPostgrest.some((c) => c.endpoint === 'rpc/hub_conta_bancaria_solicitar'), false);
  });

  test('3.2.4/PLANO §20: 6ª requisição em 15min no mesmo cnpjPrestador -> 429', async () => {
    mockRespostas['rpc/hub_conta_bancaria_solicitar'] = [{ id: 99, status: 'PENDENTE' }];
    mockRespostas['rpc/hub_conta_bancaria_motorista'] = [{ aprovada: null, pendente: contaMascaradaSql({ id: 99, status: 'PENDENTE' }), ultima_rejeitada: null }];
    const cnpj = 'cnpj-cb-rate-limit';
    let ultima;
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      ultima = await request('POST', '/motorista/conta-bancaria/solicitacoes', { headers: { 'x-test-cnpj': cnpj }, body: CORPO_CONTA_VALIDO });
      assert.notEqual(ultima.status, 429, `requisição ${i + 1}/5 não deveria ser limitada`);
    }
    const r6 = await request('POST', '/motorista/conta-bancaria/solicitacoes', { headers: { 'x-test-cnpj': cnpj }, body: CORPO_CONTA_VALIDO });
    assert.equal(r6.status, 429);
    assert.equal(r6.body.erro, 'LIMITE_EXCEDIDO');
  });
});

// --- 3.2.3 GET /motorista/bancos?q= ------------------------------------------

describe('GET /motorista/bancos', () => {
  test('busca por código', async () => {
    const r = await request('GET', '/motorista/bancos?q=260', { headers: { 'x-test-cnpj': 'cnpj-b1' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.itens, [{ codigo: '260', nome: 'NU PAGAMENTOS - IP' }]);
  });

  test('busca por nome (case-insensitive)', async () => {
    const r = await request('GET', '/motorista/bancos?q=BRASILIA', { headers: { 'x-test-cnpj': 'cnpj-b2' } });
    assert.equal(r.status, 200);
    assert.ok(r.body.itens.some((b) => b.codigo === '070'));
  });

  test('sem q -> até 20 itens, nenhuma RPC chamada (fixture local)', async () => {
    const r = await request('GET', '/motorista/bancos', { headers: { 'x-test-cnpj': 'cnpj-b3' } });
    assert.equal(r.status, 200);
    assert.ok(r.body.itens.length <= 20);
    assert.equal(chamadasPostgrest.length, 0);
  });

  test('q sem casar nenhum banco -> itens vazio', async () => {
    const r = await request('GET', '/motorista/bancos?q=zzzznaoexiste', { headers: { 'x-test-cnpj': 'cnpj-b4' } });
    assert.deepEqual(r.body.itens, []);
  });
});

// --- 3.1.6 Rate limit: 10/15min por cnpjPrestador, somando solicitar+cancelar

describe('Rate limit (PLANO §20): 10 req/15min por cnpjPrestador, somando solicitar+cancelar', () => {
  test('11ª requisição (solicitar+cancelar somados) no mesmo cnpjPrestador -> 429', async () => {
    mockRespostas['rpc/hub_adiantamento_cancelar'] = [{ id: 42, status: 'CANCELADA' }];
    mockRespostas['rpc/hub_adiantamento_detalhe_motorista'] = detalheResposta(solicitacaoJsonb({ status: 'CANCELADA' }));
    const cnpj = 'cnpj-rate-limit-unico';
    let ultima;
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      ultima = await request('POST', '/motorista/adiantamentos/42/cancelar', { headers: { 'x-test-cnpj': cnpj } });
      assert.notEqual(ultima.status, 429, `requisição ${i + 1}/10 não deveria ser limitada`);
    }
    const r11 = await request('POST', '/motorista/adiantamentos/42/cancelar', { headers: { 'x-test-cnpj': cnpj } });
    assert.equal(r11.status, 429);
    assert.equal(r11.body.erro, 'LIMITE_EXCEDIDO');
  });
});

// --- FASE 5 (5.4.5) — central de notificações -------------------------------

function notificacaoRow(overrides) {
  return Object.assign(
    {
      id: 1,
      categoria: 'adiantamento',
      titulo: 'Adiantamento liberado',
      corpo: 'Seu adiantamento foi liberado.',
      link: '/adiantamento/1',
      criada_em: '2026-09-17T12:00:00Z',
      lida: false,
      total: 1,
    },
    overrides,
  );
}

describe('GET /motorista/notificacoes', () => {
  test('lista com mapeamento camelCase e total da 1ª linha', async () => {
    mockRespostas['rpc/hub_notificacao_listar'] = [notificacaoRow({ total: 2 }), notificacaoRow({ id: 2, categoria: 'pagamento', total: 2 })];
    const r = await request('GET', '/motorista/notificacoes', { headers: { 'x-test-cnpj': 'cnpj-n1' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      itens: [
        { id: 1, categoria: 'adiantamento', titulo: 'Adiantamento liberado', corpo: 'Seu adiantamento foi liberado.', link: '/adiantamento/1', criadaEm: '2026-09-17T12:00:00Z', lida: false },
        { id: 2, categoria: 'pagamento', titulo: 'Adiantamento liberado', corpo: 'Seu adiantamento foi liberado.', link: '/adiantamento/1', criadaEm: '2026-09-17T12:00:00Z', lida: false },
      ],
      total: 2,
      pagina: 1,
      porPagina: 20,
    });
    const chamada = chamadasPostgrest.find((c) => c.endpoint === 'rpc/hub_notificacao_listar');
    assert.deepEqual(chamada.body, { p_pagina: 1, p_categoria: null, p_nao_lidas: null });
  });

  test('sem itens -> total 0, nenhuma linha', async () => {
    mockRespostas['rpc/hub_notificacao_listar'] = [];
    const r = await request('GET', '/motorista/notificacoes', { headers: { 'x-test-cnpj': 'cnpj-n2' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { itens: [], total: 0, pagina: 1, porPagina: 20 });
  });

  test('categoria repassada à RPC; categoria inválida -> 400 DADOS_INVALIDOS', async () => {
    mockRespostas['rpc/hub_notificacao_listar'] = [notificacaoRow()];
    const ok = await request('GET', '/motorista/notificacoes?categoria=pagamento', { headers: { 'x-test-cnpj': 'cnpj-n3' } });
    assert.equal(ok.status, 200);
    assert.equal(chamadasPostgrest.at(-1).body.p_categoria, 'pagamento');

    const invalida = await request('GET', '/motorista/notificacoes?categoria=inexistente', { headers: { 'x-test-cnpj': 'cnpj-n3' } });
    assert.equal(invalida.status, 400);
    assert.equal(invalida.body.erro, 'DADOS_INVALIDOS');
    assert.equal(invalida.body.motivo, 'categoria');
  });

  test('naoLidas=true repassado como true; ausente/qualquer outro valor vira null', async () => {
    mockRespostas['rpc/hub_notificacao_listar'] = [notificacaoRow()];
    await request('GET', '/motorista/notificacoes?naoLidas=true', { headers: { 'x-test-cnpj': 'cnpj-n4' } });
    assert.equal(chamadasPostgrest.at(-1).body.p_nao_lidas, true);

    await request('GET', '/motorista/notificacoes?naoLidas=false', { headers: { 'x-test-cnpj': 'cnpj-n4' } });
    assert.equal(chamadasPostgrest.at(-1).body.p_nao_lidas, null);
  });

  test('pagina inválida -> 400 DADOS_INVALIDOS (mesmo padrão de GET /adiantamentos)', async () => {
    const r = await request('GET', '/motorista/notificacoes?pagina=0', { headers: { 'x-test-cnpj': 'cnpj-n5' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.erro, 'DADOS_INVALIDOS');
  });

  test('5.4.4 defesa em profundidade: link fora da allowlist some da resposta (nunca repassado cru)', async () => {
    mockRespostas['rpc/hub_notificacao_listar'] = [notificacaoRow({ link: 'https://evil.example/phish' })];
    const r = await request('GET', '/motorista/notificacoes', { headers: { 'x-test-cnpj': 'cnpj-n6' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.itens[0].link, null);
  });

  test('links válidos da allowlist (fixos e com id) passam intactos', async () => {
    mockRespostas['rpc/hub_notificacao_listar'] = [
      notificacaoRow({ id: 1, link: '/conta-bancaria' }),
      notificacaoRow({ id: 2, link: '/avisos/42' }),
      notificacaoRow({ id: 3, link: null }),
    ];
    const r = await request('GET', '/motorista/notificacoes', { headers: { 'x-test-cnpj': 'cnpj-n7' } });
    assert.deepEqual(r.body.itens.map((i) => i.link), ['/conta-bancaria', '/avisos/42', null]);
  });
});

describe('GET /motorista/notificacoes/nao-lidas', () => {
  test('devolve total da RPC', async () => {
    mockRespostas['rpc/hub_notificacao_nao_lidas'] = [{ total: 3 }];
    const r = await request('GET', '/motorista/notificacoes/nao-lidas', { headers: { 'x-test-cnpj': 'cnpj-n8' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { total: 3 });
  });

  test('RPC sem linha -> total 0', async () => {
    mockRespostas['rpc/hub_notificacao_nao_lidas'] = [];
    const r = await request('GET', '/motorista/notificacoes/nao-lidas', { headers: { 'x-test-cnpj': 'cnpj-n9' } });
    assert.deepEqual(r.body, { total: 0 });
  });
});

describe('POST /motorista/notificacoes/:id/lida', () => {
  test('sucesso -> 204', async () => {
    mockRespostas['rpc/hub_notificacao_marcar_lida'] = [];
    const r = await request('POST', '/motorista/notificacoes/7/lida', { headers: { 'x-test-cnpj': 'cnpj-n10' } });
    assert.equal(r.status, 204);
    const chamada = chamadasPostgrest.find((c) => c.endpoint === 'rpc/hub_notificacao_marcar_lida');
    assert.deepEqual(chamada.body, { p_id: 7 });
  });

  test('id não numérico/<=0 -> 404 sem chamar a RPC', async () => {
    const r1 = await request('POST', '/motorista/notificacoes/abc/lida', { headers: { 'x-test-cnpj': 'cnpj-n11' } });
    assert.equal(r1.status, 404);
    const r2 = await request('POST', '/motorista/notificacoes/0/lida', { headers: { 'x-test-cnpj': 'cnpj-n11' } });
    assert.equal(r2.status, 404);
    assert.equal(chamadasPostgrest.length, 0);
  });

  test('id de outro CNPJ (RPC recusa) -> 404 NAO_ENCONTRADA', async () => {
    mockRespostas['rpc/hub_notificacao_marcar_lida'] = erroRpc('NAO_ENCONTRADA');
    const r = await request('POST', '/motorista/notificacoes/8/lida', { headers: { 'x-test-cnpj': 'cnpj-n12' } });
    assert.equal(r.status, 404);
    assert.equal(r.body.erro, 'NAO_ENCONTRADA');
  });
});

describe('POST /motorista/notificacoes/lidas', () => {
  test('sucesso -> 204', async () => {
    mockRespostas['rpc/hub_notificacao_marcar_todas'] = [];
    const r = await request('POST', '/motorista/notificacoes/lidas', { headers: { 'x-test-cnpj': 'cnpj-n13' } });
    assert.equal(r.status, 204);
    assert.ok(chamadasPostgrest.some((c) => c.endpoint === 'rpc/hub_notificacao_marcar_todas'));
  });
});

// --- GET /motorista/repasse (3.9, gap identificado onda-019) ----------------

function repasseRow(overrides) {
  return Object.assign(
    {
      visivel: true,
      periodo_inicio: '2026-09-10',
      periodo_fim: '2026-09-16',
      data_repasse: '2026-09-23',
      situacao: 'EM_APURACAO',
      creditos: 1000,
      debitos: 0,
      remanescente: 870.6,
      negativo: false,
      adiantamentos: [{ id: 42, dataProducao: '2026-09-16', valorBruto: 129.4, emProcessamento: false }],
    },
    overrides,
  );
}

// --- F2: GET /motorista/repasse/extrato (briefing repasse-nota-producao) ---
describe('GET /motorista/repasse/extrato', () => {
  const extratoRow = () => ({
    visivel: true,
    periodo_inicio: '2026-09-22',
    periodo_fim: '2026-09-28',
    total: '155.00',
    dias: [
      { data: '2026-09-22', total: '125.00', itens: [
        { descricao: 'Corridas concluidas', quantidade: 2, valor: '100.00' },
        { descricao: 'Promocao - Campanha w99 NOVA', quantidade: 1, valor: '25.00' },
      ] },
      { data: '2026-09-23', total: '30.00', itens: [
        { descricao: 'Corridas concluidas', quantidade: 1, valor: '30.00' },
      ] },
    ],
  });

  test('visivel:true -> 200 com o consolidado da semana e o de cada dia', async () => {
    mockRespostas['rpc/hub_adiantamento_extrato_motorista'] = [extratoRow()];
    const r = await request('GET', '/motorista/repasse/extrato', { headers: { 'x-test-cnpj': 'cnpj-extrato' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.periodoInicio, '2026-09-22');
    assert.equal(r.body.periodoFim, '2026-09-28');
    assert.equal(r.body.total, '155.00');
    assert.equal(r.body.dias.length, 2);
    // a soma dos dias é o total da semana — uma conta só, feita no banco
    const soma = r.body.dias.reduce((acc, d) => acc + Number(d.total), 0);
    assert.equal(soma.toFixed(2), r.body.total);
    assert.deepEqual(r.body.dias[0].itens[0], { descricao: 'Corridas concluidas', quantidade: 2, valor: '100.00' });
  });

  test('visivel:false -> 404 NAO_DISPONIVEL (mesma guarda do /repasse)', async () => {
    mockRespostas['rpc/hub_adiantamento_extrato_motorista'] = [{ visivel: false, periodo_inicio: null, periodo_fim: null, total: null, dias: null }];
    const r = await request('GET', '/motorista/repasse/extrato', { headers: { 'x-test-cnpj': 'cnpj-extrato' } });
    assert.equal(r.status, 404);
    assert.equal(r.body.erro, 'NAO_DISPONIVEL');
  });

  test('semana sem lançamentos -> 200 com total 0,00 e lista vazia (não é erro)', async () => {
    mockRespostas['rpc/hub_adiantamento_extrato_motorista'] = [{ ...extratoRow(), total: '0.00', dias: [] }];
    const r = await request('GET', '/motorista/repasse/extrato', { headers: { 'x-test-cnpj': 'cnpj-extrato' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.total, '0.00');
    assert.deepEqual(r.body.dias, []);
  });
});

describe('GET /motorista/repasse', () => {
  test('visivel:true -> 200 com previsão mapeada (D-11: 1000 - 129,40 = 870,60)', async () => {
    mockRespostas['rpc/hub_adiantamento_repasse_motorista'] = [repasseRow()];
    const r = await request('GET', '/motorista/repasse', { headers: { 'x-test-cnpj': 'cnpj-r1' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      periodoInicio: '2026-09-10',
      periodoFim: '2026-09-16',
      dataRepasse: '2026-09-23',
      situacao: 'EM_APURACAO',
      creditos: '1000.00',
      adiantamentos: [{ id: 42, integrationId: 'ADV-000042', dataProducao: '2026-09-16', valorBruto: '129.40', emProcessamento: false }],
      debitos: '0.00',
      remanescente: '870.60',
      negativo: false,
      ultimoFechado: null,
    });
  });

  // A3 (briefing adiantamento-repasse-us6): a semana fechada mais recente. A
  // RPC ao vivo mostra sempre a semana que contém HOJE, e o fechamento só
  // ocorre depois que a semana termina — sem este bloco o motorista NUNCA vê
  // o valor definitivo que vai receber.
  test('ultimoFechado: mapeia a semana fechada com o valor CONGELADO e a data do repasse', async () => {
    mockRespostas['rpc/hub_adiantamento_repasse_motorista'] = [repasseRow()];
    mockRespostas['rpc/hub_adiantamento_repasse_motorista_ultimo_fechado'] = [{
      periodo_inicio: '2026-09-03', periodo_fim: '2026-09-09', data_repasse: '2026-09-16',
      fechado_em: '2026-09-10T12:00:00-03:00',
      creditos: 800, adiantamentos: 129.4, debitos: 20, remanescente: 650.6, negativo: false,
    }];
    const r = await request('GET', '/motorista/repasse', { headers: { 'x-test-cnpj': 'cnpj-r5' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.ultimoFechado, {
      periodoInicio: '2026-09-03',
      periodoFim: '2026-09-09',
      dataRepasse: '2026-09-16',
      fechadoEm: '2026-09-10T12:00:00-03:00',
      creditos: '800.00',
      adiantamentos: '129.40',
      debitos: '20.00',
      remanescente: '650.60',
      negativo: false,
    });
    // O bloco da semana CORRENTE não pode ser contaminado pelo congelado.
    assert.equal(r.body.remanescente, '870.60');
  });

  // A falha da consulta do congelado é ADICIONAL: não pode derrubar a tela do
  // repasse corrente, que é a informação principal.
  test('ultimoFechado: falha da RPC do congelado NÃO derruba a resposta (fica null)', async () => {
    mockRespostas['rpc/hub_adiantamento_repasse_motorista'] = [repasseRow()];
    mockRespostas['rpc/hub_adiantamento_repasse_motorista_ultimo_fechado'] = new Error('indisponivel');
    const r = await request('GET', '/motorista/repasse', { headers: { 'x-test-cnpj': 'cnpj-r6' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ultimoFechado, null);
    assert.equal(r.body.remanescente, '870.60');
  });

  test('visivel:false (repasse_visivel_app=false ou apuração não configurada, D-13) -> 404 NAO_DISPONIVEL', async () => {
    mockRespostas['rpc/hub_adiantamento_repasse_motorista'] = [repasseRow({ visivel: false, periodo_inicio: null, adiantamentos: null })];
    const r = await request('GET', '/motorista/repasse', { headers: { 'x-test-cnpj': 'cnpj-r2' } });
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { erro: 'NAO_DISPONIVEL' });
  });

  test('remanescente negativo -> negativo:true propagado (nunca valor "corrigido")', async () => {
    mockRespostas['rpc/hub_adiantamento_repasse_motorista'] = [repasseRow({ remanescente: -50, negativo: true })];
    const r = await request('GET', '/motorista/repasse', { headers: { 'x-test-cnpj': 'cnpj-r3' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.remanescente, '-50.00');
    assert.equal(r.body.negativo, true);
  });

  test('RPC indisponível -> 502 INDISPONIVEL', async () => {
    mockRespostas['rpc/hub_adiantamento_repasse_motorista'] = new Error('timeout');
    const r = await request('GET', '/motorista/repasse', { headers: { 'x-test-cnpj': 'cnpj-r4' } });
    assert.equal(r.status, 502);
    assert.deepEqual(r.body, { erro: 'INDISPONIVEL' });
  });
});
