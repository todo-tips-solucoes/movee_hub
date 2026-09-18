/**
 * Testes unitários — routes/hub-adiantamentos.js (adiantamento-motorista,
 * FASE 4 — tasks.md 4.1.5/4.1.6, 4.2.6/4.2.7, 4.3.6/4.3.7, 4.4.8/4.4.9/
 * 4.4.10/4.4.11, 4.6.4/4.6.5/4.6.6/4.6.8, 4.7.3, 1.4.4). Rodam com:
 * node --test tests/hub-adiantamentos-rotas-unit.test.js
 *
 * Mesma técnica de tests/hub-avisos-rotas-unit.test.js: express real +
 * node:http + app.listen(0), accessToken JWT REAL verificado por
 * lib/hub-access-token.js (a cadeia de guarda roda de verdade —
 * requireModuloAtivo/requirePermission/resolverContextoAdiantamentos não são
 * mockados), mockando só a camada de dados via Module._load:
 * `../lib/hub-rbac-cache`, `./grupo` (mesmoGrupoQue), `../lib/hub-postgrest`,
 * `../lib/hub-auditoria`. `lib/adiantamento-transfeera-xlsx.js`/`xlsx` rodam
 * DE VERDADE (puro, sem I/O) — POST /lotes gera um .xlsx real.
 *
 * 4.7.4 (paridade Node/SQL — `hub_adiantamento_tem_permissao`) e a checagem
 * de que o SQL patch desta onda (origem no jsonb / aprovar_lote elegível)
 * funciona contra Postgres de verdade são cobertas pelo driver
 * `infra/hub/testes/hub-adiantamentos-integration.sh` (RLS/SQL não são
 * mockáveis com sentido aqui).
 *
 * Ref: contracts/hub-api.md, contracts/sql-rpc.md, tasks.md FASE 4.
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-unit-hub-adiantamentos';

const { test, describe, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');

// ──────────────────────────────────────────────────────────────────────────
// Estado mutável dos fakes (resetado em beforeEach)
// ──────────────────────────────────────────────────────────────────────────
const TODAS_PERMISSOES = new Set([
  'adiantamentos.consultar', 'adiantamentos.gerenciar', 'adiantamentos.configurar',
  'adiantamentos.contas_consultar', 'adiantamentos.contas_revisar', 'adiantamentos.pagamentos_consultar',
  'adiantamentos.lote_criar', 'adiantamentos.exportar', 'adiantamentos.reprocessar', 'adiantamentos.pagamento_confirmar',
]);
let permissoesPorEntidade = new Set(TODAS_PERMISSOES);
let modulosAtivos = new Set(['adiantamentos']);
let grupoIds = [6, 7]; // grupo Movee: empresa-pai 6 + 1 filial fictícia
let registrosAuditoria = [];
let auditoriaFalha = false; // 11.9 (converge onda-039): força registrarAuditoria a devolver {ok:false}
let chamadasPostgrest = [];

// Fixtures
let solicitacaoFixture = {};
let configFixture = {};
let contaJsonbFixture = {};
let contaCompletaFixture = {};
let loteFixture = {};
let loteItensFixture = [];
let repasseRowsFixture = []; // 7.11.2/7.11.3: linhas do RPC hub_adiantamento_repasse (default em resetFixtures)
let comportamentoRpc = {}; // rpc -> 'ok' | codigo de erro string
let chamadasLoteCriar = 0; // 11.23 — conta invocações de rpc/hub_adiantamento_lote_criar por request
let falharLeituraConfigAntes = false; // 12.2 — força a leitura de "antes" em PUT /configuracoes a falhar

function raiseComMensagem(msg, detail) {
  const e = new Error(msg);
  e.status = 400;
  e.body = JSON.stringify({ code: 'P0001', message: msg, details: detail ?? null, hint: null });
  return e;
}

function resetFixtures() {
  permissoesPorEntidade = new Set(TODAS_PERMISSOES);
  modulosAtivos = new Set(['adiantamentos']);
  grupoIds = [6, 7];
  registrosAuditoria = [];
  chamadasPostgrest = [];
  comportamentoRpc = {};
  chamadasLoteCriar = 0;
  auditoriaFalha = false; // 11.9: por padrão a auditoria "confirma" (ok:true)
  falharLeituraConfigAntes = false;

  solicitacaoFixture = {
    id: 100, id_empresa: 6, status: 'LIBERADA', motivo_status: null,
    data_solicitacao: '2026-09-10', data_producao: '2026-09-09',
    valor_liquido: '250.00', valor_bruto: '260.00', taxa: '10.00', percentual: '60.00',
    producao_valor: '433.33', producao_por_categoria: null, fonte_producao: 'financeiro_lancamento',
    categorias_producao: ['Frete'], calculado_em: '2026-09-10T03:00:00Z',
    configuracao_id: 1, conta_bancaria_id: 500, entregador: { nome: 'Fulano de Tal' },
  };
  configFixture = {
    id: 1, id_empresa: 6, versao: 3, vigente_desde: '2026-01-01T00:00:00Z', timezone: 'America/Sao_Paulo',
    dias_habilitados: [1, 2, 3, 4, 5, 6], horario_abertura: '09:00:00', horario_corte: '15:00:00',
    percentual: '60.00', taxa_fixa: '0.35', fonte_producao: 'financeiro_lancamento', categorias_producao: ['Frete'],
    previsao_pagamento_texto: 'entre 17h e 18h de hoje', descricao_pix_modelo: 'Adiantamento {nome}',
    apuracao_dia_inicio: 1, apuracao_dias_ate_repasse: 3, apuracao_data_base: 'data_lancamento',
    categorias_extrato: ['Frete'], desconto_adiantamentos: true, desconto_debitos: false,
    repasse_visivel_app: false, motivo: null, criado_por: 9, criador: { nome: 'Admin' },
  };
  contaJsonbFixture = {
    id: 500, status: 'PENDENTE', origem: 'CARGA_INICIAL', titularNome: 'Fulano de Tal',
    titularDocumento: '*********01', bancoCodigo: '001', bancoNome: 'Banco do Brasil', agencia: '1234',
    conta: '*****45', contaDigito: '7', tipoConta: 'CORRENTE', chavePixTipo: 'CPF',
    emailComprovante: 'fu••••@••••.com', alertas: [], motivoRejeicao: null,
    solicitadaEm: '2026-09-01T00:00:00Z', revisadaEm: null,
  };
  contaCompletaFixture = {
    id: 500, status: 'PENDENTE', origem: 'CARGA_INICIAL', titularNome: 'Fulano de Tal',
    titularDocumento: '12345678901', titularTipo: 'PF', bancoCodigo: '001', bancoNome: 'Banco do Brasil',
    agencia: '1234', conta: '00012345', contaDigito: '7', tipoConta: 'CORRENTE', chavePixTipo: 'CPF',
    chavePix: '12345678901', emailComprovante: 'fulano@teste.com', alertas: [], motivoRejeicao: null,
    solicitadaEm: '2026-09-01T00:00:00Z', revisadaEm: null,
    entregadorId: 10, entregadorNome: 'Fulano',
  };
  loteFixture = {
    id: 900, id_empresa: 6, status: 'GERANDO', criado_por: 9, criado_em: '2026-09-10T00:00:00Z',
    quantidade: 1, valor_total: '250.00', arquivo_nome: null, arquivo_sha256: null, downloads: 0,
    primeiro_download_em: null, cancelado_em: null, cancelado_por: null, cancelado_motivo: null, concluido_em: null,
  };
  loteItensFixture = [{
    id: 1, lote_id: 900, solicitacao_id: 100, id_empresa: 6, linha: 3,
    // FASE 11 (converge onda-037, 11.7/11.14, migration 0074): col_documento/
    // col_banco refletem o que a SQL grava DE VERDADE hoje — documento
    // FORMATADO (não redigido) e código do banco (não o nome).
    col_nome: 'Fulano de Tal', col_documento: '123.456.789-01', col_email: '',
    col_banco: '001', col_agencia: '1234', col_conta: '00012345', col_digito: '7',
    col_tipo_conta: 'Conta Corrente', valor: '250.00', col_id_integracao: 'ADV-000100',
    col_descricao_pix: 'Adiantamento Fulano de Tal', conta_bancaria_id: 500, situacao: 'incluido',
    situacao_motivo: null, situacao_em: null, situacao_por: null, origem_situacao: null,
  }];
  repasseRowsFixture = [{
    entregador_id: 10, nome: 'Fulano', creditos: '500.00', adiantamentos: '250.00', debitos: '0.00',
    remanescente: '250.00', em_processamento: false, total: 1,
    // Totais do PERÍODO, devolvidos pela RPC em janela `sum(...) OVER ()`
    // (migration 0083) — o backend não soma mais as linhas da página.
    total_creditos: '500.00', total_adiantamentos: '250.00', total_debitos: '0.00', total_remanescente: '250.00',
  }];
}
resetFixtures();

async function fakeHubPostgrestRequest(endpoint, method, body, claims, opts) {
  chamadasPostgrest.push({ endpoint, method, body, claims, opts });
  const [caminho, query] = endpoint.split('?');

  // ── Solicitações ──────────────────────────────────────────────────────
  if (caminho === 'AdiantamentoSolicitacao' && method === 'GET' && opts && opts.count) {
    const rows = [solicitacaoFixture];
    return { data: rows, total: rows.length };
  }
  if (caminho === 'AdiantamentoSolicitacao' && method === 'GET') {
    const m = endpoint.match(/id=eq\.(\d+)/);
    const id = m ? Number(m[1]) : null;
    if (id && id !== solicitacaoFixture.id) return [];
    // Simula a RLS por escopo (dec-022): id_empresa=in.(...) fora do escopo -> vazio.
    const escopoMatch = endpoint.match(/id_empresa=in\.\(([^)]*)\)/);
    if (escopoMatch) {
      const idsEscopo = escopoMatch[1].split(',').map(Number);
      if (!idsEscopo.includes(solicitacaoFixture.id_empresa)) return [];
    }
    return [solicitacaoFixture];
  }
  if (caminho === 'AdiantamentoConfiguracao' && method === 'GET' && /id=eq\./.test(query || '')) {
    return [{ versao: configFixture.versao, descricao_pix_modelo: configFixture.descricao_pix_modelo }];
  }
  if (caminho === 'AdiantamentoConfiguracao' && method === 'GET') {
    if (falharLeituraConfigAntes && /limit=1/.test(query || '')) {
      throw new Error('timeout simulado — leitura de config vigente p/ auditoria antes/depois');
    }
    return [configFixture];
  }
  if (caminho === 'AdiantamentoEvento' && method === 'GET') {
    return [{
      status_de: 'AGUARDANDO_PRODUCAO', status_para: 'LIBERADA', ocorrido_em: '2026-09-10T03:00:00Z',
      ator_tipo: 'sistema', ator_usuario_id: null, motivo: null,
    }];
  }
  if (caminho === 'AdiantamentoLoteItem' && method === 'GET' && /situacao=in\.\(incluido,pago\)/.test(query || '')) {
    return [{ solicitacao_id: 100, lote_id: 900 }];
  }
  if (caminho === 'AdiantamentoLoteItem' && method === 'GET' && /lote:AdiantamentoLote/.test(query || '')) {
    return [{ situacao: 'incluido', lote: loteFixture }];
  }
  if (caminho === 'AdiantamentoLoteItem' && method === 'GET') {
    return loteItensFixture;
  }
  if (caminho === 'AdiantamentoLote' && method === 'GET' && opts && opts.count) {
    return { data: [loteFixture], total: 1 };
  }
  if (caminho === 'AdiantamentoLote' && method === 'GET') {
    return [loteFixture];
  }
  if (caminho === 'ApuracaoRepasse' && method === 'GET') {
    return comportamentoRpc.apuracaoExistente ? [{ id: 1, data_repasse: '2026-09-20' }] : [];
  }

  // ── RPCs ──────────────────────────────────────────────────────────────
  if (caminho === 'rpc/hub_adiantamento_rejeitar') {
    if (comportamentoRpc.rejeitar) throw raiseComMensagem(comportamentoRpc.rejeitar);
    return [{ id: body.p_id, status: 'REJEITADA' }];
  }
  if (caminho === 'rpc/hub_adiantamento_recalcular') {
    if (comportamentoRpc.recalcular) throw raiseComMensagem(comportamentoRpc.recalcular);
    return [{ id: body.p_id, status: 'LIBERADA', valor_liquido: '250.00' }];
  }
  if (caminho === 'rpc/hub_adiantamento_encerrar') {
    if (comportamentoRpc.encerrar) throw raiseComMensagem(comportamentoRpc.encerrar);
    return [{ id: body.p_id, status: 'INELEGIVEL' }];
  }
  if (caminho === 'rpc/hub_adiantamento_atualizar_conta') {
    if (comportamentoRpc.atualizarConta) throw raiseComMensagem(comportamentoRpc.atualizarConta);
    return [{ id: body.p_id, conta_bancaria_id: 501 }];
  }
  if (caminho === 'rpc/hub_adiantamento_reprocessar') {
    if (comportamentoRpc.reprocessar) throw raiseComMensagem(comportamentoRpc.reprocessar);
    return [{ id: body.p_id, status: 'LIBERADA' }];
  }
  if (caminho === 'rpc/hub_adiantamento_encerrar_falha') {
    if (comportamentoRpc.encerrarFalha) throw raiseComMensagem(comportamentoRpc.encerrarFalha);
    return [{ id: body.p_id, status: 'ENCERRADA' }];
  }
  if (caminho === 'rpc/hub_adiantamento_categorias') {
    return [{ descricao: 'Frete', lancamentos: 42, sem_motorista_identificado: false }];
  }
  if (caminho === 'rpc/hub_adiantamento_configuracao_salvar') {
    if (comportamentoRpc.configurarSalvar) throw raiseComMensagem(comportamentoRpc.configurarSalvar);
    // 11.12: simula o merge real da RPC (COALESCE) só p/ os 2 campos que os
    // testes de PUT /configuracoes exercitam — suficiente p/ o diff antes/depois.
    const nova = { ...configFixture, versao: configFixture.versao + 1, id: 2 };
    if (body.p_dados && body.p_dados.percentual !== undefined) nova.percentual = body.p_dados.percentual;
    if (body.p_dados && body.p_dados.motivo !== undefined) nova.motivo = body.p_dados.motivo;
    return [nova];
  }
  if (caminho === 'rpc/hub_conta_bancaria_listar') {
    return [{ dados: contaJsonbFixture, total: 1 }];
  }
  if (caminho === 'rpc/hub_conta_bancaria_detalhe') {
    if (comportamentoRpc.contaDetalhe) throw raiseComMensagem(comportamentoRpc.contaDetalhe);
    return body.p_completo ? [contaCompletaFixture] : [contaJsonbFixture];
  }
  if (caminho === 'rpc/hub_conta_bancaria_aprovar') {
    if (comportamentoRpc.contaAprovar) throw raiseComMensagem(comportamentoRpc.contaAprovar);
    return { id: body.p_id, status: 'APROVADA' };
  }
  if (caminho === 'rpc/hub_conta_bancaria_rejeitar') {
    if (comportamentoRpc.contaRejeitar) throw raiseComMensagem(comportamentoRpc.contaRejeitar);
    return { id: body.p_id, status: 'REJEITADA' };
  }
  if (caminho === 'rpc/hub_conta_bancaria_aprovar_lote') {
    return (body.p_ids || []).map((id) => (
      id === 500 ? { id, aprovada: true, motivo_ignorada: null } : { id, aprovada: false, motivo_ignorada: 'STATUS_INVALIDO' }
    ));
  }
  if (caminho === 'rpc/hub_adiantamento_lote_previa') {
    return (body.p_ids || []).map((id) => (
      id === 100
        ? { solicitacao_id: id, apta: true, motivo_pendencia: null, valor_liquido: '250.00' }
        : { solicitacao_id: id, apta: false, motivo_pendencia: 'STATUS_INVALIDO', valor_liquido: null }
    ));
  }
  if (caminho === 'rpc/hub_adiantamento_lote_criar') {
    chamadasLoteCriar += 1;
    // 11.23/FR-050: mesmo padrão de hub-avisos.js (dec-097) — simula o
    // perdedor de uma corrida concorrente na UNIQUE de idempotência
    // (adiantamentolote_idempotencia_uniq), sem handler de unique_violation
    // no INSERT da RPC (bug real). O retry (routes/hub-adiantamentos.js)
    // deve tratar isso chamando a RPC de novo.
    if (comportamentoRpc.loteCriar === 'UNIQUE_VIOLATION_SEMPRE'
        || (comportamentoRpc.loteCriar === 'UNIQUE_VIOLATION_UMA_VEZ' && chamadasLoteCriar === 1)) {
      throw raiseComMensagem('duplicate key value violates unique constraint "adiantamentolote_idempotencia_uniq"');
    }
    if (comportamentoRpc.loteCriar && comportamentoRpc.loteCriar !== 'UNIQUE_VIOLATION_UMA_VEZ') {
      throw raiseComMensagem(comportamentoRpc.loteCriar, comportamentoRpc.loteCriarDetail);
    }
    return [{
      id: 900,
      status: 'GERANDO',
      quantidade: 1,
      valor_total: '250.00',
      reutilizado: comportamentoRpc.loteReutilizado === true
        || (comportamentoRpc.loteCriar === 'UNIQUE_VIOLATION_UMA_VEZ' && chamadasLoteCriar === 2),
    }];
  }
  if (caminho === 'rpc/hub_adiantamento_lote_arquivo') {
    return [{ id: body.p_lote_id, status: 'GERADO' }];
  }
  if (caminho === 'rpc/hub_adiantamento_lote_download') {
    if (comportamentoRpc.loteDownload) throw raiseComMensagem(comportamentoRpc.loteDownload, comportamentoRpc.loteDownloadDetail);
    // sha256 REAL de 'conteudo-teste' (13.4: a rota agora confere antes de
    // enviar — um mock com hash inventado quebraria 4.4.10 sob o fix).
    // loteDownloadShaErrado (13.4) simula a RPC devolvendo um hash que não
    // bate com os bytes — deve nunca chegar ao cliente.
    return [{
      arquivo_base64: Buffer.from('conteudo-teste').toString('base64'),
      sha256: comportamentoRpc.loteDownloadShaErrado
        ? 'sha-errado-nao-bate-com-os-bytes'
        : 'f3ce124f8bc2c462d029fb7c53e1b12fda9cf61960c4728f575eb51deccb664b',
      nome: 'arquivo.xlsx',
      downloads: 1,
    }];
  }
  if (caminho === 'rpc/hub_adiantamento_lote_cancelar') {
    if (comportamentoRpc.loteCancelar) throw raiseComMensagem(comportamentoRpc.loteCancelar);
    return [{ id: body.p_lote_id, status: 'CANCELADO' }];
  }
  if (caminho === 'rpc/hub_adiantamento_lote_confirmar') {
    if (comportamentoRpc.loteConfirmar) throw raiseComMensagem(comportamentoRpc.loteConfirmar);
    return [{ id: body.p_lote_id, status: 'CONCLUIDO' }];
  }
  if (caminho === 'rpc/hub_adiantamento_repasse') {
    if (comportamentoRpc.repasse) throw raiseComMensagem(comportamentoRpc.repasse);
    return repasseRowsFixture;
  }
  if (caminho === 'rpc/hub_adiantamento_repasse_fechar') {
    if (comportamentoRpc.repasseFechar) {
      throw raiseComMensagem(comportamentoRpc.repasseFechar, comportamentoRpc.repasseFecharDetail);
    }
    return [{ apuracao_id: 55, motoristas: 1, total: '250.00', nao_pagos_no_periodo: 0 }];
  }

  throw new Error(`mock não suporta: ${endpoint} [${method}]`);
}

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../lib/hub-rbac-cache') {
    return {
      obterPermissoesEfetivas: async () => permissoesPorEntidade,
      obterPermissoesEfetivasPorEntidade: async () => permissoesPorEntidade,
      obterModulosAtivosPorEntidade: async () => modulosAtivos,
    };
  }
  if (request === './grupo') {
    return {
      mesmoGrupoQue: async (idEmpresa, _idReferencia, cache) => {
        if (!cache.ids) cache.ids = new Set(grupoIds);
        return cache.ids.has(Number(idEmpresa));
      },
    };
  }
  if (request === '../lib/hub-postgrest') {
    return { hubPostgrestRequest: async (...args) => fakeHubPostgrestRequest(...args) };
  }
  if (request === '../lib/hub-auditoria') {
    return {
      registrarAuditoria: async (evento) => {
        if (auditoriaFalha) return { ok: false, erro: 'FALHA_TESTE_11_9' };
        registrosAuditoria.push(evento);
        return { ok: true };
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

const express = require('express');
const cookieParser = require('cookie-parser');
const { router } = require('../routes/hub-adiantamentos.js');

Module._load = originalLoad;

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1/adiantamentos', router);

let server;
let baseUrl;

function request(method, path, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const headers = {};
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    if (cookie) headers.Cookie = cookie;
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const contentType = res.headers['content-type'] || '';
          let parsed;
          if (contentType.includes('application/json')) {
            try { parsed = buf.length ? JSON.parse(buf.toString('utf8')) : null; } catch { parsed = buf.toString('utf8'); }
          } else {
            parsed = buf; // bytes crus (xlsx/csv)
          }
          resolve({ status: res.statusCode, body: parsed, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

let proximoSub = 7000;
function tokenCookie({ entidadeAtiva = 6, semEntidade = false } = {}) {
  const payload = semEntidade ? { sub: proximoSub++ } : { sub: proximoSub++, entidade_ativa: entidadeAtiva };
  const token = jwt.sign(payload, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
  return `hub_accessToken=${token}`;
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

// ════════════════════════════════════════════════════════════════════════
// Cadeia de guarda (comum a todas as rotas)
// ════════════════════════════════════════════════════════════════════════

describe('cadeia de guarda (4.1.2, exercitada via GET /)', () => {
  beforeEach(resetFixtures);

  test('sem cookie -> 401 NAO_AUTENTICADO', async () => {
    const r = await request('GET', '/api/v1/adiantamentos');
    assert.equal(r.status, 401);
    assert.equal(r.body.erro, 'NAO_AUTENTICADO');
  });

  test('sem entidade_ativa -> 403 MODULO_DESABILITADO', async () => {
    const r = await request('GET', '/api/v1/adiantamentos', { cookie: tokenCookie({ semEntidade: true }) });
    assert.equal(r.status, 403);
    assert.equal(r.body.erro, 'MODULO_DESABILITADO');
  });

  test('módulo inativo na entidade -> 403 MODULO_DESABILITADO', async () => {
    modulosAtivos = new Set([]);
    const r = await request('GET', '/api/v1/adiantamentos', { cookie: tokenCookie() });
    assert.equal(r.status, 403);
    assert.equal(r.body.erro, 'MODULO_DESABILITADO');
  });

  test('sem a permissão de rota (union flat) -> 403 PERMISSAO_NEGADA', async () => {
    permissoesPorEntidade = new Set([]);
    const r = await request('GET', '/api/v1/adiantamentos', { cookie: tokenCookie() });
    assert.equal(r.status, 403);
    assert.equal(r.body.erro, 'PERMISSAO_NEGADA');
  });

  test('escopo (dec-022): entidade-pai 6 expande para o grupo inteiro', async () => {
    const r = await request('GET', '/api/v1/adiantamentos', { cookie: tokenCookie({ entidadeAtiva: 6 }) });
    assert.equal(r.status, 200);
    const chamada = chamadasPostgrest.find((c) => c.endpoint.startsWith('AdiantamentoSolicitacao?'));
    assert.deepEqual(chamada.claims.escopo, [6, 7]);
  });

  test('escopo (dec-022): filial vê só a própria empresa', async () => {
    const r = await request('GET', '/api/v1/adiantamentos', { cookie: tokenCookie({ entidadeAtiva: 7 }) });
    assert.equal(r.status, 200);
    const chamada = chamadasPostgrest.find((c) => c.endpoint.startsWith('AdiantamentoSolicitacao?'));
    assert.deepEqual(chamada.claims.escopo, [7]);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 4.1 — Solicitações
// ════════════════════════════════════════════════════════════════════════

describe('4.1 solicitações', () => {
  beforeEach(resetFixtures);

  test('GET / lista com paginação e mapeia SolicitacaoResumo', async () => {
    const r = await request('GET', '/api/v1/adiantamentos?page=1&pageSize=20', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.itens.length, 1);
    assert.equal(r.body.itens[0].id, 100);
    assert.equal(r.body.itens[0].motorista.nome, 'Fulano de Tal');
    assert.equal(r.body.itens[0].valorLiquido, '250.00');
    assert.equal(r.body.itens[0].loteId, 900); // batch join com AdiantamentoLoteItem
  });

  // Revisão PR #182: `de`/`ate` iam CRUS (sem validação e sem encode) para a
  // querystring do PostgREST montada por `partes.join('&')` — bastava
  // pendurar `&cnpj_prestador=like.12*` para anexar um filtro próprio sobre a
  // tabela inteira e deduzir o documento dígito a dígito pela contagem.
  test('GET / com `de` fora de AAAA-MM-DD -> 400 e nenhuma consulta ao PostgREST', async () => {
    const r = await request('GET', '/api/v1/adiantamentos?de=2026-01-01%26cnpj_prestador%3Dlike.12*', { cookie: tokenCookie() });
    assert.equal(r.status, 400);
    assert.equal(r.body.erro, 'DADOS_INVALIDOS');
    assert.equal(r.body.motivo, 'de');
    assert.ok(!chamadasPostgrest.some((c) => String(c.endpoint).startsWith('AdiantamentoSolicitacao?')));
  });

  test('GET / com `ate` fora de AAAA-MM-DD -> 400 (motivo aponta o campo certo)', async () => {
    const r = await request('GET', '/api/v1/adiantamentos?de=2026-01-01&ate=hoje', { cookie: tokenCookie() });
    assert.equal(r.status, 400);
    assert.equal(r.body.motivo, 'ate');
  });

  test('GET / com `de`/`ate` válidos continua filtrando (e só com os dois filtros esperados)', async () => {
    const r = await request('GET', '/api/v1/adiantamentos?de=2026-01-01&ate=2026-01-31', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    const chamada = chamadasPostgrest.find((c) => String(c.endpoint).startsWith('AdiantamentoSolicitacao?'));
    assert.ok(chamada.endpoint.includes('data_solicitacao=gte.2026-01-01'));
    assert.ok(chamada.endpoint.includes('data_solicitacao=lte.2026-01-31'));
  });

  test('GET /:id devolve calculo/contaMascarada/eventos', async () => {
    const r = await request('GET', '/api/v1/adiantamentos/100', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.calculo.liquido, '250.00');
    assert.equal(r.body.calculo.versaoConfiguracao, 3);
    assert.equal(r.body.contaMascarada.origem, 'CARGA_INICIAL');
    assert.equal(r.body.contaMascarada.contaMascarada, '*****45-7');
    assert.equal(r.body.eventos.length, 1);
  });

  test('GET /:id inexistente -> 404 NAO_ENCONTRADO', async () => {
    const r = await request('GET', '/api/v1/adiantamentos/999', { cookie: tokenCookie() });
    assert.equal(r.status, 404);
    assert.equal(r.body.erro, 'NAO_ENCONTRADO');
  });

  test('POST /:id/rejeitar sem motivo -> 400 DADOS_INVALIDOS', async () => {
    const r = await request('POST', '/api/v1/adiantamentos/100/rejeitar', { body: {}, cookie: tokenCookie() });
    assert.equal(r.status, 400);
    assert.equal(r.body.erro, 'DADOS_INVALIDOS');
  });

  test('POST /:id/rejeitar happy path -> 200 + auditoria', async () => {
    const r = await request('POST', '/api/v1/adiantamentos/100/rejeitar', { body: { motivo: 'duplicidade confirmada' }, cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.ok(registrosAuditoria.some((e) => e.acao === 'adiantamento.rejeitado' && e.recursoId === 100));
    // 11.26/contrato-SolicitacaoDetalhe: resposta é o detalhe completo, não só o resumo.
    assert.equal(r.body.calculo.liquido, '250.00');
    assert.equal(r.body.contaMascarada.origem, 'CARGA_INICIAL');
    assert.equal(r.body.eventos.length, 1);
  });

  test('POST /:id/rejeitar fora do estado esperado -> 409 TRANSICAO_INVALIDA', async () => {
    comportamentoRpc.rejeitar = 'TRANSICAO_INVALIDA';
    const r = await request('POST', '/api/v1/adiantamentos/100/rejeitar', { body: { motivo: 'tentativa invalida' }, cookie: tokenCookie() });
    assert.equal(r.status, 409);
    assert.equal(r.body.erro, 'TRANSICAO_INVALIDA');
  });

  test('POST /:id/recalcular não exige motivo, audita adiantamento.recalculado (FR-047)', async () => {
    const r = await request('POST', '/api/v1/adiantamentos/100/recalcular', { body: {}, cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.ok(registrosAuditoria.some((e) => e.acao === 'adiantamento.recalculado'));
    // 11.26/contrato-SolicitacaoDetalhe
    assert.equal(r.body.calculo.liquido, '250.00');
  });

  test('POST /:id/encerrar audita adiantamento.encerrado (FR-047)', async () => {
    const r = await request('POST', '/api/v1/adiantamentos/100/encerrar', { body: { motivo: 'motorista desistiu' }, cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.ok(registrosAuditoria.some((e) => e.acao === 'adiantamento.encerrado'));
  });

  test('POST /:id/atualizar-conta audita adiantamento.conta_atualizada (FR-047, R-10)', async () => {
    const r = await request('POST', '/api/v1/adiantamentos/100/atualizar-conta', { body: { motivo: 'conta aprovada mudou' }, cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.ok(registrosAuditoria.some((e) => e.acao === 'adiantamento.conta_atualizada'));
  });

  test('POST /:id/reprocessar audita adiantamento.reprocessado (FR-047, R-14)', async () => {
    const r = await request('POST', '/api/v1/adiantamentos/100/reprocessar', { body: { motivo: 'banco reprocessado com sucesso' }, cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.ok(registrosAuditoria.some((e) => e.acao === 'adiantamento.reprocessado'));
  });

  test('POST /:id/encerrar-falha happy path audita encerrado_sem_pagamento', async () => {
    const r = await request('POST', '/api/v1/adiantamentos/100/encerrar-falha', { body: { motivo: 'falha definitiva do banco' }, cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.ok(registrosAuditoria.some((e) => e.acao === 'adiantamento.encerrado_sem_pagamento'));
    // 11.26/contrato-SolicitacaoDetalhe (D-23 declara SolicitacaoDetalhe para esta transição)
    assert.equal(r.body.calculo.liquido, '250.00');
    assert.equal(r.body.contaMascarada.origem, 'CARGA_INICIAL');
  });

  test('4.1.6: id_empresa da solicitação sempre dentro do escopo (filial não acessa empresa fora do grupo)', async () => {
    const r = await request('GET', '/api/v1/adiantamentos/100', { cookie: tokenCookie({ entidadeAtiva: 999 }) });
    // 999 não está no grupoIds fixture -> escopo = [999], filtro id_empresa exclui a fixture
    assert.equal(r.status, 404);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 4.2 — Configuração
// ════════════════════════════════════════════════════════════════════════

describe('4.2 configuração', () => {
  beforeEach(resetFixtures);

  test('GET /configuracoes devolve vigente + histórico', async () => {
    const r = await request('GET', '/api/v1/adiantamentos/configuracoes', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.vigente.versao, 3);
    assert.equal(r.body.vigente.completa, true);
    assert.equal(r.body.historico.length, 1);
  });

  test('GET /configuracoes/categorias', async () => {
    const r = await request('GET', '/api/v1/adiantamentos/configuracoes/categorias?fonte=financeiro_lancamento', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.itens[0].descricao, 'Frete');
    assert.equal(r.body.itens[0].lancamentos, 42);
  });

  test('PUT /configuracoes sem versaoEsperada -> 400', async () => {
    const r = await request('PUT', '/api/v1/adiantamentos/configuracoes', { body: { percentual: 60 }, cookie: tokenCookie() });
    assert.equal(r.status, 400);
  });

  test('PUT /configuracoes happy path -> 201 + auditoria com diff', async () => {
    const r = await request('PUT', '/api/v1/adiantamentos/configuracoes', {
      body: { versaoEsperada: 3, percentual: 65, motivo: 'ajuste combinado com financeiro' }, cookie: tokenCookie(),
    });
    assert.equal(r.status, 201);
    const dec = registrosAuditoria.find((e) => e.acao === 'adiantamento.configuracao_alterada');
    assert.ok(dec);
    // 11.12 (FR-024): antes/depois real, não o payload submetido — campo
    // reenviado idêntico não deve aparecer (configFixture.motivo já era null
    // e o pedido reenvia um motivo novo, então motivo TAMBÉM diverge).
    assert.equal(dec.detalhes.antes.percentual, '60.00');
    assert.equal(dec.detalhes.depois.percentual, 65);
    assert.equal(dec.detalhes.depois.motivo, 'ajuste combinado com financeiro');
    assert.equal(dec.detalhes.diff, undefined);
  });

  test('12.2: leitura de "antes" falha -> auditoria marca antesIndisponivel, nunca fabrica antes:null', async () => {
    falharLeituraConfigAntes = true;
    const r = await request('PUT', '/api/v1/adiantamentos/configuracoes', {
      body: { versaoEsperada: 3, percentual: 65 }, cookie: tokenCookie(),
    });
    assert.equal(r.status, 201);
    const dec = registrosAuditoria.find((e) => e.acao === 'adiantamento.configuracao_alterada');
    assert.ok(dec);
    assert.equal(dec.detalhes.antesIndisponivel, true);
    assert.deepEqual(dec.detalhes.antes, {});
    assert.equal(dec.detalhes.depois.percentual, 65);
  });

  test('4.2.6: duas gravações concorrentes — a segunda recebe 409 sem sobrescrever', async () => {
    comportamentoRpc.configurarSalvar = 'VERSAO_DESATUALIZADA';
    const r = await request('PUT', '/api/v1/adiantamentos/configuracoes', { body: { versaoEsperada: 1 }, cookie: tokenCookie() });
    assert.equal(r.status, 409);
    assert.equal(r.body.erro, 'VERSAO_DESATUALIZADA');
  });

  test('PUT /configuracoes exige permissão "configurar" distinta de "consultar"', async () => {
    permissoesPorEntidade = new Set(['adiantamentos.consultar']);
    const r = await request('PUT', '/api/v1/adiantamentos/configuracoes', { body: { versaoEsperada: 3 }, cookie: tokenCookie() });
    assert.equal(r.status, 403);
    assert.equal(r.body.erro, 'PERMISSAO_NEGADA');
  });
});

// ════════════════════════════════════════════════════════════════════════
// 4.3 — Contas bancárias
// ════════════════════════════════════════════════════════════════════════

describe('4.3 contas bancárias', () => {
  beforeEach(resetFixtures);

  test('GET /contas lista mascarada', async () => {
    const r = await request('GET', '/api/v1/adiantamentos/contas', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.itens[0].documentoMascarado.length > 0, true);
    assert.equal(r.body.itens[0].origem, 'CARGA_INICIAL');
  });

  test('7.11.1/dec-105: GET /contas repassa origem/semAlertas/busca/banco (cada um e combinados) para hub_conta_bancaria_listar', async () => {
    const r = await request(
      'GET',
      '/api/v1/adiantamentos/contas?origem=CARGA_INICIAL&semAlertas=false&busca=Joana+Ribeiro&banco=001',
      { cookie: tokenCookie() }
    );
    assert.equal(r.status, 200);
    const chamada = chamadasPostgrest.find((c) => c.endpoint === 'rpc/hub_conta_bancaria_listar');
    assert.ok(chamada, 'rota deve chamar rpc/hub_conta_bancaria_listar');
    assert.deepEqual(chamada.body, {
      p_status: null, p_pagina: 1, p_tamanho_pagina: 20,
      p_origem: 'CARGA_INICIAL', p_sem_alertas: false, p_busca: 'Joana Ribeiro', p_banco: '001',
    });
  });

  test('7.11.1: GET /contas sem filtros novos -> p_origem/p_sem_alertas/p_busca/p_banco null (retrocompatível)', async () => {
    const r = await request('GET', '/api/v1/adiantamentos/contas?status=PENDENTE', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    const chamada = chamadasPostgrest.find((c) => c.endpoint === 'rpc/hub_conta_bancaria_listar');
    assert.deepEqual(chamada.body, {
      p_status: 'PENDENTE', p_pagina: 1, p_tamanho_pagina: 20,
      p_origem: null, p_sem_alertas: null, p_busca: null, p_banco: null,
    });
  });

  test('GET /contas/:id sem completo devolve mascarado', async () => {
    const r = await request('GET', '/api/v1/adiantamentos/contas/500', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.contaMascarada, '*****45-7'); // campo do próprio ContaMascarada (hub-api.md), não aninhado
    assert.equal(r.body.banco.includes('Banco do Brasil'), true);
  });

  test('GET /contas/:id?completo=true exige contas_revisar', async () => {
    permissoesPorEntidade = new Set(['adiantamentos.contas_consultar']);
    const r = await request('GET', '/api/v1/adiantamentos/contas/500?completo=true', { cookie: tokenCookie() });
    assert.equal(r.status, 403);
  });

  test('GET /contas/:id?completo=true com permissão -> dado cru + auditoria FR-019', async () => {
    const r = await request('GET', '/api/v1/adiantamentos/contas/500?completo=true', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.conta, '00012345');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.ok(registrosAuditoria.some((e) => e.acao === 'conta_bancaria.visualizada'));
  });

  test('11.9: auditoria não confirmada (ok:false) -> 503 INDISPONIVEL, dado bancário NÃO é revelado (fail-closed só nesta rota)', async () => {
    auditoriaFalha = true;
    const r = await request('GET', '/api/v1/adiantamentos/contas/500?completo=true', { cookie: tokenCookie() });
    assert.equal(r.status, 503);
    assert.equal(r.body.erro, 'INDISPONIVEL');
    assert.equal(r.body.titularDocumento, undefined); // nunca vaza o dado completo sem auditoria confirmada
  });

  test('7.5.2/FR-018: GET /contas/:id?completo=true expõe entregadorVinculado {entregadorId, nome}', async () => {
    const r = await request('GET', '/api/v1/adiantamentos/contas/500?completo=true', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.entregadorVinculado, { entregadorId: 10, nome: 'Fulano' });
  });

  test('POST /contas/:id/aprovar exige entregadorConfirmadoId', async () => {
    const r = await request('POST', '/api/v1/adiantamentos/contas/500/aprovar', { body: {}, cookie: tokenCookie() });
    assert.equal(r.status, 400);
  });

  test('POST /contas/:id/aprovar happy path', async () => {
    const r = await request('POST', '/api/v1/adiantamentos/contas/500/aprovar', {
      body: { entregadorConfirmadoId: 10 }, cookie: tokenCookie(),
    });
    assert.equal(r.status, 200);
    assert.ok(registrosAuditoria.some((e) => e.acao === 'conta_bancaria.aprovada'));
  });

  test('POST /contas/:id/rejeitar exige motivo', async () => {
    const r = await request('POST', '/api/v1/adiantamentos/contas/500/rejeitar', { body: {}, cookie: tokenCookie() });
    assert.equal(r.status, 400);
  });

  test('POST /contas/:id/rejeitar happy path audita conta_bancaria.rejeitada (FR-047)', async () => {
    const r = await request('POST', '/api/v1/adiantamentos/contas/500/rejeitar', {
      body: { motivo: 'documento ilegível' }, cookie: tokenCookie(),
    });
    assert.equal(r.status, 200);
    assert.ok(registrosAuditoria.some((e) => e.acao === 'conta_bancaria.rejeitada' && e.recursoId === 500));
  });

  test('4.3.7: POST /contas/aprovar-lote reporta aprovadas + ignoradas com motivo, e audita (FR-047)', async () => {
    const r = await request('POST', '/api/v1/adiantamentos/contas/aprovar-lote', {
      body: { ids: [500, 501] }, cookie: tokenCookie(),
    });
    assert.equal(r.status, 200);
    assert.ok(registrosAuditoria.some((e) => e.acao === 'conta_bancaria.aprovada_lote'));
    assert.equal(r.body.aprovadas, 1);
    assert.equal(r.body.ignoradas.length, 1);
    assert.equal(r.body.ignoradas[0].id, 501);
    assert.equal(r.body.ignoradas[0].motivo, 'STATUS_INVALIDO');
  });

  test('4.3.6: contas passam sempre por RPC — nenhum SELECT direto (mock não expõe endpoint de tabela crua)', async () => {
    await request('GET', '/api/v1/adiantamentos/contas', { cookie: tokenCookie() });
    const chamouTabelaDireta = chamadasPostgrest.some((c) => c.endpoint.startsWith('ContaBancariaMotorista'));
    assert.equal(chamouTabelaDireta, false);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 4.4 — Lotes de pagamento
// ════════════════════════════════════════════════════════════════════════

describe('4.4 lotes de pagamento', () => {
  beforeEach(resetFixtures);

  test('POST /lotes/previa separa aptas e pendentes', async () => {
    const r = await request('POST', '/api/v1/adiantamentos/lotes/previa', { body: { ids: [100, 101] }, cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.quantidadeApta, 1);
    assert.equal(r.body.aptas[0].id, 100);
    assert.equal(r.body.aptas[0].motorista, 'Fulano de Tal');
    assert.equal(r.body.pendentes.length, 1);
    assert.equal(r.body.pendentes[0].pendencias[0], 'STATUS_INVALIDO');
  });

  test('11.28: rate limiter de prévia e de criação de lote são independentes (não somam no mesmo balde)', async () => {
    const cookie = tokenCookie();
    let ultima;
    for (let i = 0; i < 30; i++) {
      ultima = await request('POST', '/api/v1/adiantamentos/lotes/previa', { body: { ids: [100, 101] }, cookie });
    }
    assert.equal(ultima.status, 200); // 30ª chamada ainda dentro do limite (30/15min)
    const bloqueada = await request('POST', '/api/v1/adiantamentos/lotes/previa', { body: { ids: [100, 101] }, cookie });
    assert.equal(bloqueada.status, 429);
    assert.equal(bloqueada.body.erro, 'LIMITE_EXCEDIDO');

    // Antes da correção (instância única `loteRateLimiter` compartilhada por
    // /lotes/previa E /lotes), esta chamada também levaria 429 — o balde já
    // estava esgotado pela prévia. Com limiters independentes, passa.
    const criacaoLote = await request('POST', '/api/v1/adiantamentos/lotes', {
      body: { ids: [100], quantidadeEsperada: 1, totalEsperado: '250.00', chaveIdempotencia: '22222222-2222-4222-8222-222222222222' },
      cookie,
    });
    assert.notEqual(criacaoLote.status, 429);
  });

  test('4.4.8: ids acima do limite -> 400 (limite 5000)', async () => {
    const idsGrandes = Array.from({ length: 5001 }, (_, i) => i + 1);
    const r = await request('POST', '/api/v1/adiantamentos/lotes/previa', { body: { ids: idsGrandes }, cookie: tokenCookie() });
    assert.equal(r.status, 400);
  });

  test('POST /lotes cria lote, gera xlsx real e grava arquivo', async () => {
    const r = await request('POST', '/api/v1/adiantamentos/lotes', {
      body: {
        ids: [100], quantidadeEsperada: 1, totalEsperado: '250.00', chaveIdempotencia: '11111111-1111-4111-8111-111111111111',
      },
      cookie: tokenCookie(),
    });
    assert.equal(r.status, 201);
    assert.ok(registrosAuditoria.some((e) => e.acao === 'adiantamento.lote_criado'));
    assert.ok(registrosAuditoria.some((e) => e.acao === 'adiantamento.lote_arquivo_gerado'));
    const chamouArquivo = chamadasPostgrest.some((c) => c.endpoint === 'rpc/hub_adiantamento_lote_arquivo');
    assert.equal(chamouArquivo, true);
  });

  test('13.1: POST /lotes com ids acima do limite chega na RPC -> 422 LOTE_ACIMA_DO_LIMITE (não mais 400 antes dela)', async () => {
    comportamentoRpc.loteCriar = 'LOTE_ACIMA_DO_LIMITE';
    const idsGrandes = Array.from({ length: 5001 }, (_, i) => i + 1);
    const r = await request('POST', '/api/v1/adiantamentos/lotes', {
      body: {
        ids: idsGrandes, quantidadeEsperada: 5001, totalEsperado: '250.00', chaveIdempotencia: '33333333-3333-4333-8333-333333333333',
      },
      cookie: tokenCookie(),
    });
    assert.equal(r.status, 422);
    assert.equal(r.body.erro, 'LOTE_ACIMA_DO_LIMITE');
  });

  test('11.19: nome do arquivo usa a data no fuso America/Sao_Paulo, não UTC (22h BRT = 01h UTC do dia seguinte)', async () => {
    // 2026-09-16 22:00 BRT === 2026-09-17T01:00:00Z. Sem o fix, toISOString()
    // nomeia o arquivo com 2026-09-17 (dia seguinte).
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-17T01:00:00.000Z') });
    try {
      const r = await request('POST', '/api/v1/adiantamentos/lotes', {
        body: {
          ids: [100], quantidadeEsperada: 1, totalEsperado: '250.00', chaveIdempotencia: '66666666-6666-4666-8666-666666666666',
        },
        cookie: tokenCookie(),
      });
      assert.equal(r.status, 201);
      const chamadaArquivo = chamadasPostgrest.find((c) => c.endpoint === 'rpc/hub_adiantamento_lote_arquivo');
      assert.ok(chamadaArquivo, 'deveria ter chamado rpc/hub_adiantamento_lote_arquivo');
      assert.match(chamadaArquivo.body.p_nome, /^transfeera_adiantamentos_2026-09-16_lote-/);
    } finally {
      mock.timers.reset();
    }
  });

  test('11.23/FR-050: corrida concorrente (unique_violation no perdedor) -> retry automático cai no caminho idempotente, 201, gera arquivo 1x', async () => {
    comportamentoRpc.loteCriar = 'UNIQUE_VIOLATION_UMA_VEZ';
    const r = await request('POST', '/api/v1/adiantamentos/lotes', {
      body: {
        ids: [100], quantidadeEsperada: 1, totalEsperado: '250.00', chaveIdempotencia: '77777777-7777-4777-8777-777777777777',
      },
      cookie: tokenCookie(),
    });
    assert.equal(r.status, 200); // reutilizado:true na 2ª tentativa (retry)
    assert.equal(chamadasLoteCriar, 2); // 1ª colidiu, 2ª (retry) resolveu
    const chamouArquivo = chamadasPostgrest.some((c) => c.endpoint === 'rpc/hub_adiantamento_lote_arquivo');
    assert.equal(chamouArquivo, false); // reutilizado -> não gera arquivo de novo
  });

  test('11.23/FR-050: unique_violation persistente (2x) -> não repete indefinidamente, propaga 500', async () => {
    comportamentoRpc.loteCriar = 'UNIQUE_VIOLATION_SEMPRE';
    const r = await request('POST', '/api/v1/adiantamentos/lotes', {
      body: {
        ids: [100], quantidadeEsperada: 1, totalEsperado: '250.00', chaveIdempotencia: '88888888-8888-4888-8888-888888888888',
      },
      cookie: tokenCookie(),
    });
    assert.equal(r.status, 500);
    assert.equal(chamadasLoteCriar, 2); // só 1 retry — nunca 3ª tentativa
  });

  test('POST /lotes reenvio idempotente não gera arquivo de novo', async () => {
    comportamentoRpc.loteReutilizado = true;
    const r = await request('POST', '/api/v1/adiantamentos/lotes', {
      body: {
        ids: [100], quantidadeEsperada: 1, totalEsperado: '250.00', chaveIdempotencia: '11111111-1111-4111-8111-111111111111',
      },
      cookie: tokenCookie(),
    });
    assert.equal(r.status, 200);
    const chamouArquivo = chamadasPostgrest.some((c) => c.endpoint === 'rpc/hub_adiantamento_lote_arquivo');
    assert.equal(chamouArquivo, false);
  });

  test('4.4.9: falha simulada na geração cancela o lote (falha_geracao) e responde 500', async () => {
    // Item sem col_conta -> validarPlanilhaTransfeera acusa OBRIGATORIO_VAZIO
    loteItensFixture = [{ ...loteItensFixture[0], col_conta: null }];
    const r = await request('POST', '/api/v1/adiantamentos/lotes', {
      body: {
        ids: [100], quantidadeEsperada: 1, totalEsperado: '250.00', chaveIdempotencia: '22222222-2222-4222-8222-222222222222',
      },
      cookie: tokenCookie(),
    });
    assert.equal(r.status, 500);
    assert.equal(r.body.erro, 'FALHA_GERACAO_ARQUIVO');
    const chamouCancelar = chamadasPostgrest.some((c) => c.endpoint === 'rpc/hub_adiantamento_lote_cancelar' && c.body.p_motivo === 'falha_geracao');
    assert.equal(chamouCancelar, true);
  });

  test('11.16: modelo com placeholder desconhecido -> renderizarDescricaoPix recusa, cancela o lote (não replica validação em SQL)', async () => {
    // `col_descricao_pix` chega da SQL como o MODELO BRUTO (11.16) — aqui
    // simula um modelo com um placeholder fora de PLACEHOLDERS_PERMITIDOS.
    loteItensFixture = [{ ...loteItensFixture[0], col_descricao_pix: 'Antecipacao {cpf}_{nome}' }];
    const r = await request('POST', '/api/v1/adiantamentos/lotes', {
      body: {
        ids: [100], quantidadeEsperada: 1, totalEsperado: '250.00', chaveIdempotencia: '44444444-4444-4444-8444-444444444444',
      },
      cookie: tokenCookie(),
    });
    assert.equal(r.status, 500);
    assert.equal(r.body.erro, 'FALHA_GERACAO_ARQUIVO');
    const chamouCancelar = chamadasPostgrest.some((c) => c.endpoint === 'rpc/hub_adiantamento_lote_cancelar' && c.body.p_motivo === 'falha_geracao');
    assert.equal(chamouCancelar, true);
    const chamouArquivo = chamadasPostgrest.some((c) => c.endpoint === 'rpc/hub_adiantamento_lote_arquivo');
    assert.equal(chamouArquivo, false);
  });

  test('11.16: modelo com {data_producao} bare renderiza (Node) e persiste via p_itens em hub_adiantamento_lote_arquivo', async () => {
    loteItensFixture = [{
      ...loteItensFixture[0],
      col_descricao_pix: 'Antecipacao {data_producao}_{nome}',
      solicitacao: { data_producao: '2026-02-28' },
    }];
    const r = await request('POST', '/api/v1/adiantamentos/lotes', {
      body: {
        ids: [100], quantidadeEsperada: 1, totalEsperado: '250.00', chaveIdempotencia: '55555555-5555-4555-8555-555555555555',
      },
      cookie: tokenCookie(),
    });
    assert.equal(r.status, 201);
    const chamadaArquivo = chamadasPostgrest.find((c) => c.endpoint === 'rpc/hub_adiantamento_lote_arquivo');
    assert.ok(chamadaArquivo, 'deveria ter chamado rpc/hub_adiantamento_lote_arquivo');
    assert.deepEqual(chamadaArquivo.body.p_itens, [{ id: 1, descricao: 'Antecipacao 28.02.26_Fulano de Tal' }]);
  });

  test('4.4.11: SOLICITACOES_EM_OUTRO_LOTE devolve os ids em conflito (DETAIL do PostgREST)', async () => {
    comportamentoRpc.loteCriar = 'SOLICITACOES_EM_OUTRO_LOTE';
    comportamentoRpc.loteCriarDetail = JSON.stringify([100, 101]);
    const r = await request('POST', '/api/v1/adiantamentos/lotes', {
      body: {
        ids: [100, 101], quantidadeEsperada: 2, totalEsperado: '500.00', chaveIdempotencia: '33333333-3333-4333-8333-333333333333',
      },
      cookie: tokenCookie(),
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.erro, 'SOLICITACOES_EM_OUTRO_LOTE');
    assert.deepEqual(r.body.ids, [100, 101]);
  });

  test('GET /lotes lista', async () => {
    const r = await request('GET', '/api/v1/adiantamentos/lotes', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.itens[0].id, 900);
  });

  // Mesma raiz do filtro de `GET /` (revisão PR #182): `de`/`ate`/`status`
  // iam crus para a querystring do PostgREST.
  test('GET /lotes com `de` fora de AAAA-MM-DD -> 400, sem consultar o PostgREST', async () => {
    const r = await request('GET', '/api/v1/adiantamentos/lotes?de=2026-01-01%26cnpj_prestador%3Dlike.12*', { cookie: tokenCookie() });
    assert.equal(r.status, 400);
    assert.equal(r.body.motivo, 'de');
    assert.ok(!chamadasPostgrest.some((c) => String(c.endpoint).startsWith('AdiantamentoLote?id_empresa')));
  });

  test('GET /lotes com status fora do enum do lote -> 400 (allowlist, nunca repassado cru)', async () => {
    const r = await request('GET', '/api/v1/adiantamentos/lotes?status=GERADO%29%26cnpj_prestador%3Dlike.12*', { cookie: tokenCookie() });
    assert.equal(r.status, 400);
    assert.equal(r.body.motivo, 'status');
  });

  test('GET /lotes com status válido continua filtrando', async () => {
    const r = await request('GET', '/api/v1/adiantamentos/lotes?status=GERADO,CANCELADO', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    const chamada = chamadasPostgrest.find((c) => String(c.endpoint).startsWith('AdiantamentoLote?id_empresa'));
    assert.ok(chamada.endpoint.includes('status=in.(GERADO,CANCELADO)'));
  });

  test('GET /lotes/:id devolve itens mascarados + histórico', async () => {
    const r = await request('GET', '/api/v1/adiantamentos/lotes/900', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.itens.length, 1);
    // FASE 11 (converge onda-037, 11.7): antes vazava `${col_conta}-${col_digito}`
    // CRU sob o nome contaMascarada — mapLoteItem agora mascara de verdade.
    assert.equal(r.body.itens[0].contaMascarada, '••••2345-7');
    assert.equal(r.body.itens[0].documentoMascarado, '***.***.***-01');
  });

  test('4.4.10: GET /lotes/:id/arquivo baixa e ausita por número de ordem', async () => {
    const r = await request('GET', '/api/v1/adiantamentos/lotes/900/arquivo', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-disposition'].includes('arquivo.xlsx'), true);
    assert.equal(r.headers['cache-control'], 'no-store');
    const dec = registrosAuditoria.find((e) => e.acao === 'adiantamento.lote_baixado');
    assert.ok(dec);
    assert.equal(dec.detalhes.numeroDownload, 1);
  });

  test('GET /lotes/:id/arquivo indisponível -> 409', async () => {
    comportamentoRpc.loteDownload = 'ARQUIVO_INDISPONIVEL';
    const r = await request('GET', '/api/v1/adiantamentos/lotes/900/arquivo', { cookie: tokenCookie() });
    assert.equal(r.status, 409);
  });

  test('13.3: GET /lotes/:id/arquivo expurgado por retenção -> 410 (distinto de 409 indisponível)', async () => {
    comportamentoRpc.loteDownload = 'ARQUIVO_EXPURGADO';
    comportamentoRpc.loteDownloadDetail = JSON.stringify('2026-06-01T00:00:00Z');
    const r = await request('GET', '/api/v1/adiantamentos/lotes/900/arquivo', { cookie: tokenCookie() });
    assert.equal(r.status, 410);
    assert.equal(r.body.erro, 'ARQUIVO_INDISPONIVEL');
    assert.equal(r.body.motivo, 'expurgado_por_retencao');
    assert.equal(r.body.expurgadoEm, '2026-06-01T00:00:00Z');
  });

  test('13.4: GET /lotes/:id/arquivo com sha256 divergente -> 500, bytes nunca enviados', async () => {
    comportamentoRpc.loteDownloadShaErrado = true;
    const r = await request('GET', '/api/v1/adiantamentos/lotes/900/arquivo', { cookie: tokenCookie() });
    assert.equal(r.status, 500);
    assert.equal(r.body.erro, 'ERRO_SERVIDOR');
    assert.ok(!registrosAuditoria.some((e) => e.acao === 'adiantamento.lote_baixado'));
  });

  test('POST /lotes/:id/cancelar exige motivo', async () => {
    const r = await request('POST', '/api/v1/adiantamentos/lotes/900/cancelar', { body: {}, cookie: tokenCookie() });
    assert.equal(r.status, 400);
  });

  test('POST /lotes/:id/cancelar happy path', async () => {
    const r = await request('POST', '/api/v1/adiantamentos/lotes/900/cancelar', {
      body: { motivo: 'erro na selecao do financeiro' }, cookie: tokenCookie(),
    });
    assert.equal(r.status, 200);
    assert.ok(registrosAuditoria.some((e) => e.acao === 'adiantamento.lote_cancelado'));
  });

  test('POST /lotes/:id/confirmacao com falhas parciais', async () => {
    const r = await request('POST', '/api/v1/adiantamentos/lotes/900/confirmacao', {
      body: { falhas: [{ id: 100, motivo: 'conta encerrada' }] }, cookie: tokenCookie(),
    });
    assert.equal(r.status, 200);
    assert.ok(registrosAuditoria.some((e) => e.acao === 'adiantamento.lote_confirmado'));
  });

  test('11.17/FR-033: POST /lotes/:id/confirmacao recusa motivo vazio (motivoValido, mesma regra do cancelar)', async () => {
    const r = await request('POST', '/api/v1/adiantamentos/lotes/900/confirmacao', {
      body: { falhas: [{ id: 100, motivo: '' }] }, cookie: tokenCookie(),
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.erro, 'DADOS_INVALIDOS');
    assert.equal(r.body.motivo, 'falhas');
    assert.ok(!chamadasPostgrest.some((c) => c.endpoint === 'rpc/hub_adiantamento_lote_confirmar'));
  });

  // Revisão PR #182 (crítica/dinheiro): a RPC recusa o conjunto inteiro
  // quando um id de `p_falhas` não é item do lote (migration 0083) — antes o
  // UPDATE alcançava solicitação de outro lote/outra empresa e marcava FALHOU
  // um adiantamento já pago.
  test('POST /lotes/:id/confirmacao com id fora do lote -> 400 (RPC recusa com SOLICITACAO_FORA_DO_LOTE)', async () => {
    comportamentoRpc.loteConfirmar = 'SOLICITACAO_FORA_DO_LOTE';
    const r = await request('POST', '/api/v1/adiantamentos/lotes/900/confirmacao', {
      body: { falhas: [{ id: 4242, motivo: 'conta encerrada' }] }, cookie: tokenCookie(),
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.erro, 'DADOS_INVALIDOS');
    assert.equal(r.body.motivo, 'falhas');
    assert.ok(!registrosAuditoria.some((e) => e.acao === 'adiantamento.lote_confirmado'));
  });

  test('11.17/FR-033: POST /lotes/:id/confirmacao recusa motivo só com espaços (< 3 chars após trim)', async () => {
    const r = await request('POST', '/api/v1/adiantamentos/lotes/900/confirmacao', {
      body: { falhas: [{ id: 100, motivo: '  a ' }] }, cookie: tokenCookie(),
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.erro, 'DADOS_INVALIDOS');
  });
});

// ════════════════════════════════════════════════════════════════════════
// FASE 9 — Importador de retorno da Transfeera (9.1.3)
// ════════════════════════════════════════════════════════════════════════

const { CABECALHO_ESPERADO: CABECALHO_RETORNO } = require('../lib/adiantamento-retorno-transfeera');

const LINHA_RETORNO_PADRAO = {
  'ID da transferência': 'tr_teste', 'ID de integração': '', Status: 'Finalizada', Valor: '250.00',
  'Pago em': '17/09/2026 10:00:00', 'Criado em': '16/09/2026 09:00:00', 'Método de pagamento': 'pix',
  'Código Bancário': '001', 'Nome do recebedor': 'Fulano de Tal Sintetico', 'CPF/CNPJ do recebedor': '00000000000',
  'Tipo de chave Pix do recebedor': 'cpf', 'Chave Pix': '00000000000', 'Número da conta': '00012345',
  'Número da agência': '1234', 'Tipo de conta': 'conta_corrente', 'Código do banco': '001',
  'Nome do banco': 'Banco Sintetico', 'ID do lote': 'lote_teste', 'Nome do lote': 'lote teste',
  'Recibo bancário': '', 'Recibo Transfeera': 'rec_teste', 'Código de erro': '', 'Motivo da falha': '',
};

function csvRetornoBase64(linhasOverrides) {
  const cab = CABECALHO_RETORNO.join(',');
  const corpo = linhasOverrides
    .map((over) => CABECALHO_RETORNO.map((c) => ({ ...LINHA_RETORNO_PADRAO, ...over }[c])).join(','))
    .join('\n');
  return Buffer.from(`${cab}\n${corpo}\n`, 'utf-8').toString('base64');
}

function itemLote({
  id = 1, solicitacaoId = 100, valor = '250.00', colIdIntegracao = 'ADV-000100', situacao = 'incluido',
} = {}) {
  return {
    id, lote_id: 900, solicitacao_id: solicitacaoId, id_empresa: 6, linha: id + 2,
    col_nome: 'Fulano de Tal', col_documento: '***.***.***-01', col_email: '',
    col_banco: 'Banco do Brasil', col_agencia: '1234', col_conta: '00012345', col_digito: '7',
    col_tipo_conta: 'Conta Corrente', valor, col_id_integracao: colIdIntegracao,
    col_descricao_pix: 'Adiantamento Fulano de Tal', conta_bancaria_id: 500, situacao,
    situacao_motivo: null, situacao_em: null, situacao_por: null, origem_situacao: null,
  };
}

describe('FASE 9 — POST /lotes/:id/retorno', () => {
  beforeEach(resetFixtures);

  test('csvBase64 ausente -> 400 DADOS_INVALIDOS', async () => {
    const r = await request('POST', '/api/v1/adiantamentos/lotes/900/retorno', { body: {}, cookie: tokenCookie() });
    assert.equal(r.status, 400);
    assert.equal(r.body.erro, 'DADOS_INVALIDOS');
  });

  test('cabeçalho fora do contrato -> 400 ARQUIVO_INVALIDO/CABECALHO_INVALIDO', async () => {
    const csvBase64 = Buffer.from('a,b,c\n1,2,3\n', 'utf-8').toString('base64');
    const r = await request('POST', '/api/v1/adiantamentos/lotes/900/retorno', { body: { csvBase64 }, cookie: tokenCookie() });
    assert.equal(r.status, 400);
    assert.equal(r.body.erro, 'ARQUIVO_INVALIDO');
    assert.equal(r.body.motivo, 'CABECALHO_INVALIDO');
  });

  // Revisão PR #182: duas linhas do mesmo ADV-<id> entravam as duas em
  // `aplicaveis`; a falha é aplicada antes do "o que sobrou é pago", então a
  // Devolvida vencia a Finalizada e o pagamento já feito virava FALHOU.
  test('mesmo ADV-<id> repetido com status conflitante -> 400 ARQUIVO_INVALIDO/LINHA_DUPLICADA, RPC nunca chamada', async () => {
    loteItensFixture = [itemLote({ id: 1, solicitacaoId: 100, valor: '250.00', colIdIntegracao: 'ADV-000100' })];
    const csvBase64 = csvRetornoBase64([
      { 'ID de integração': 'ADV-000100', Status: 'Finalizada', Valor: '250.00' },
      {
        'ID de integração': 'ADV-000100', Status: 'Devolvida', Valor: '250.00', 'Código de erro': 'DBA_20', 'Motivo da falha': 'Conta ou dígito verificador da conta inválido.',
      },
    ]);
    const r = await request('POST', '/api/v1/adiantamentos/lotes/900/retorno', { body: { csvBase64 }, cookie: tokenCookie() });
    assert.equal(r.status, 400);
    assert.equal(r.body.erro, 'ARQUIVO_INVALIDO');
    assert.equal(r.body.motivo, 'LINHA_DUPLICADA');
    assert.ok(!chamadasPostgrest.some((c) => c.endpoint === 'rpc/hub_adiantamento_lote_confirmar'));
  });

  test('Finalizada -> paga e Devolvida -> falhou (motivo literal), auditoria registrada', async () => {
    loteItensFixture = [
      itemLote({ id: 1, solicitacaoId: 100, valor: '250.00', colIdIntegracao: 'ADV-000100' }),
      itemLote({ id: 2, solicitacaoId: 101, valor: '80.00', colIdIntegracao: 'ADV-000101' }),
    ];
    const csvBase64 = csvRetornoBase64([
      { 'ID de integração': 'ADV-000100', Status: 'Finalizada', Valor: '250.00' },
      {
        'ID de integração': 'ADV-000101', Status: 'Devolvida', Valor: '80.00', 'Código de erro': 'DBA_20', 'Motivo da falha': 'Conta ou dígito verificador da conta inválido.',
      },
    ]);
    const r = await request('POST', '/api/v1/adiantamentos/lotes/900/retorno', { body: { csvBase64 }, cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.aplicadas, 2);
    assert.deepEqual(r.body.ignoradas, []);

    const chamadaConfirmar = chamadasPostgrest.find((c) => c.endpoint === 'rpc/hub_adiantamento_lote_confirmar');
    assert.ok(chamadaConfirmar);
    assert.equal(chamadaConfirmar.body.p_lote_id, 900);
    assert.deepEqual(chamadaConfirmar.body.p_falhas, [{ id: 101, motivo: 'Conta ou dígito verificador da conta inválido.' }]);

    const auditoria = registrosAuditoria.find((e) => e.acao === 'adiantamento.retorno_importado');
    assert.ok(auditoria);
    assert.deepEqual(auditoria.detalhes, { aplicadas: 2, falhas: 1, ignoradas: 0 });
  });

  test('item incluido sem cobertura no arquivo -> 409 RETORNO_INCOMPLETO, nunca aplica parcialmente', async () => {
    loteItensFixture = [
      itemLote({ id: 1, solicitacaoId: 100, valor: '250.00', colIdIntegracao: 'ADV-000100' }),
      itemLote({ id: 2, solicitacaoId: 101, valor: '80.00', colIdIntegracao: 'ADV-000101' }),
    ];
    const csvBase64 = csvRetornoBase64([
      { 'ID de integração': 'ADV-000100', Status: 'Finalizada', Valor: '250.00' },
    ]);
    const r = await request('POST', '/api/v1/adiantamentos/lotes/900/retorno', { body: { csvBase64 }, cookie: tokenCookie() });
    assert.equal(r.status, 409);
    assert.equal(r.body.erro, 'RETORNO_INCOMPLETO');
    assert.deepEqual(r.body.faltantes, [101]);
    assert.ok(!chamadasPostgrest.some((c) => c.endpoint === 'rpc/hub_adiantamento_lote_confirmar'));
  });

  test('reimportação (item já pago) -> 200 aplicadas:0, ignoradas JA_APLICADO, RPC não chamada de novo', async () => {
    loteItensFixture = [itemLote({ id: 1, solicitacaoId: 100, valor: '250.00', colIdIntegracao: 'ADV-000100', situacao: 'pago' })];
    const csvBase64 = csvRetornoBase64([
      { 'ID de integração': 'ADV-000100', Status: 'Finalizada', Valor: '250.00' },
    ]);
    const r = await request('POST', '/api/v1/adiantamentos/lotes/900/retorno', { body: { csvBase64 }, cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.aplicadas, 0);
    assert.deepEqual(r.body.ignoradas, [{ idIntegracao: 'ADV-000100', motivo: 'JA_APLICADO' }]);
    assert.ok(!chamadasPostgrest.some((c) => c.endpoint === 'rpc/hub_adiantamento_lote_confirmar'));
    assert.ok(!registrosAuditoria.some((e) => e.acao === 'adiantamento.retorno_importado'));
  });

  test('lote sem itens no escopo -> 404 NAO_ENCONTRADO', async () => {
    loteItensFixture = [];
    const csvBase64 = csvRetornoBase64([{ 'ID de integração': 'ADV-000100', Status: 'Finalizada', Valor: '250.00' }]);
    const r = await request('POST', '/api/v1/adiantamentos/lotes/900/retorno', { body: { csvBase64 }, cookie: tokenCookie() });
    assert.equal(r.status, 404);
    assert.equal(r.body.erro, 'NAO_ENCONTRADO');
  });
});

// ════════════════════════════════════════════════════════════════════════
// 4.6 — Repasse
// ════════════════════════════════════════════════════════════════════════

describe('4.6 repasse', () => {
  beforeEach(resetFixtures);

  test('GET /repasse exige periodo', async () => {
    const r = await request('GET', '/api/v1/adiantamentos/repasse', { cookie: tokenCookie() });
    assert.equal(r.status, 400);
  });

  test('GET /repasse devolve periodo/totais/itens/naoPagosNoPeriodo', async () => {
    const r = await request('GET', '/api/v1/adiantamentos/repasse?periodo=2026-09-08', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.periodo.inicio, '2026-09-08');
    assert.equal(r.body.periodo.fim, '2026-09-14');
    assert.equal(r.body.periodo.situacao, 'aberto');
    assert.equal(r.body.itens[0].nome, 'Fulano');
    assert.equal(typeof r.body.naoPagosNoPeriodo, 'number');
  });

  test('GET /repasse com apuração já fechada -> situacao fechado', async () => {
    comportamentoRpc.apuracaoExistente = true;
    const r = await request('GET', '/api/v1/adiantamentos/repasse?periodo=2026-09-08', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.periodo.situacao, 'fechado');
  });

  test('7.11.2/7.11.3: totais vêm do período (janela da RPC), formatados sem divisão de float — 300 linhas de 0,07 = 21.00', async () => {
    repasseRowsFixture = Array.from({ length: 300 }, (_v, i) => ({
      entregador_id: i + 1, nome: `Motorista ${i}`, creditos: '0.07', adiantamentos: '0.00',
      debitos: '0.00', remanescente: '0.07', em_processamento: false, total: 300,
      total_creditos: '21.00', total_adiantamentos: '0.00', total_debitos: '0.00', total_remanescente: '21.00',
    }));
    const r = await request('GET', '/api/v1/adiantamentos/repasse?periodo=2026-09-08', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.totais.creditos, '21.00');
    assert.equal(r.body.totais.remanescente, '21.00');
  });

  test('7.11.2/7.11.3: totais com remanescente negativo e valores fracionários preservam os centavos', async () => {
    repasseRowsFixture = [
      { entregador_id: 1, nome: 'A', creditos: '10.10', adiantamentos: '5.05', debitos: '0.20', remanescente: '4.85', em_processamento: false, total: 3, total_creditos: '60.60', total_adiantamentos: '30.10', total_debitos: '0.60', total_remanescente: '29.90' },
      { entregador_id: 2, nome: 'B', creditos: '20.20', adiantamentos: '25.05', debitos: '0.10', remanescente: '-4.95', em_processamento: false, total: 3, total_creditos: '60.60', total_adiantamentos: '30.10', total_debitos: '0.60', total_remanescente: '29.90' },
      { entregador_id: 3, nome: 'C', creditos: '30.30', adiantamentos: '0.00', debitos: '0.30', remanescente: '30.00', em_processamento: false, total: 3, total_creditos: '60.60', total_adiantamentos: '30.10', total_debitos: '0.60', total_remanescente: '29.90' },
    ];
    const r = await request('GET', '/api/v1/adiantamentos/repasse?periodo=2026-09-08', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.totais.creditos, '60.60');
    assert.equal(r.body.totais.adiantamentos, '30.10');
    assert.equal(r.body.totais.debitos, '0.60');
    assert.equal(r.body.totais.remanescente, '29.90');
  });

  // Revisão PR #182: os totais eram somados sobre `rows` (a PÁGINA, 20 por
  // padrão) e exibidos ao lado de `motoristas`, que sempre foi a contagem do
  // período inteiro — na tela onde se decide fechar a apuração.
  test('totais são os do PERÍODO, nunca a soma da página (137 motoristas, página de 1 linha)', async () => {
    repasseRowsFixture = [{
      entregador_id: 1, nome: 'A', creditos: '10.00', adiantamentos: '1.00', debitos: '0.00',
      remanescente: '9.00', em_processamento: false, total: 137,
      total_creditos: '1370.00', total_adiantamentos: '137.00', total_debitos: '0.00', total_remanescente: '1233.00',
    }];
    const r = await request('GET', '/api/v1/adiantamentos/repasse?periodo=2026-09-08&pageSize=1', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.itens.length, 1);
    assert.equal(r.body.totais.motoristas, 137);
    assert.equal(r.body.totais.creditos, '1370.00');
    assert.equal(r.body.totais.adiantamentos, '137.00');
    assert.equal(r.body.totais.remanescente, '1233.00');
  });

  test('período sem nenhuma linha -> totais zerados (RPC não devolve linha alguma)', async () => {
    repasseRowsFixture = [];
    const r = await request('GET', '/api/v1/adiantamentos/repasse?periodo=2026-09-08', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.body.totais.creditos, '0.00');
    assert.equal(r.body.totais.remanescente, '0.00');
    assert.equal(r.body.totais.motoristas, 0);
  });

  test('GET /repasse/exportar devolve CSV', async () => {
    const r = await request('GET', '/api/v1/adiantamentos/repasse/exportar?periodo=2026-09-08', { cookie: tokenCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'].includes('text/csv'), true);
    const texto = Buffer.isBuffer(r.body) ? r.body.toString('utf8') : String(r.body);
    assert.ok(texto.includes('Fulano'));
  });

  test('POST /repasse/:periodo/fechar exige confirmacao:true', async () => {
    const r = await request('POST', '/api/v1/adiantamentos/repasse/2026-09-08/fechar', { body: {}, cookie: tokenCookie() });
    assert.equal(r.status, 400);
  });

  test('POST /repasse/:periodo/fechar happy path -> 201 + auditoria', async () => {
    const r = await request('POST', '/api/v1/adiantamentos/repasse/2026-09-08/fechar', {
      body: { confirmacao: true }, cookie: tokenCookie(),
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.apuracaoId, 55);
    assert.ok(registrosAuditoria.some((e) => e.acao === 'adiantamento.repasse_fechado'));
  });

  test('4.6.6: POST /repasse/:periodo/fechar recusa com APURACAO_COM_PENDENCIAS (contagem por status)', async () => {
    comportamentoRpc.repasseFechar = 'APURACAO_COM_PENDENCIAS';
    comportamentoRpc.repasseFecharDetail = JSON.stringify({ LIBERADA: 2, FALHOU: 1 });
    const r = await request('POST', '/api/v1/adiantamentos/repasse/2026-09-08/fechar', {
      body: { confirmacao: true }, cookie: tokenCookie(),
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.erro, 'APURACAO_COM_PENDENCIAS');
    assert.deepEqual(r.body.detalhe, { LIBERADA: 2, FALHOU: 1 });
  });

  test('4.6.4: fechar duas vezes o mesmo período -> APURACAO_JA_FECHADA', async () => {
    comportamentoRpc.repasseFechar = 'APURACAO_JA_FECHADA';
    const r = await request('POST', '/api/v1/adiantamentos/repasse/2026-09-08/fechar', {
      body: { confirmacao: true }, cookie: tokenCookie(),
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.erro, 'APURACAO_JA_FECHADA');
  });

  test('4.6.8: encerrar-falha fora de FALHOU -> TRANSICAO_INVALIDA', async () => {
    comportamentoRpc.encerrarFalha = 'TRANSICAO_INVALIDA';
    const r = await request('POST', '/api/v1/adiantamentos/100/encerrar-falha', { body: { motivo: 'nao esta em falhou' }, cookie: tokenCookie() });
    assert.equal(r.status, 409);
    assert.equal(r.body.erro, 'TRANSICAO_INVALIDA');
  });

  test('4.6.8: encerrar-falha sem permissão reprocessar -> PERMISSAO_NEGADA', async () => {
    permissoesPorEntidade = new Set(['adiantamentos.consultar']);
    const r = await request('POST', '/api/v1/adiantamentos/100/encerrar-falha', { body: { motivo: 'sem permissao' }, cookie: tokenCookie() });
    assert.equal(r.status, 403);
    assert.equal(r.body.erro, 'PERMISSAO_NEGADA');
  });
});

// ════════════════════════════════════════════════════════════════════════
// 4.7.3 / 1.4.4 — 403 em TODA rota nova para usuário sem nenhuma das 10
// permissões (fecha tasks.md 1.4.4, pendente desde onda-010)
// ════════════════════════════════════════════════════════════════════════

describe('4.7.3/1.4.4 — 403 sem nenhuma das 10 permissões em toda rota nova do hub', () => {
  const ROTAS = [
    ['GET', '/api/v1/adiantamentos'],
    ['GET', '/api/v1/adiantamentos/100'],
    ['POST', '/api/v1/adiantamentos/100/rejeitar', { motivo: 'x'.repeat(10) }],
    ['POST', '/api/v1/adiantamentos/100/recalcular', {}],
    ['POST', '/api/v1/adiantamentos/100/encerrar', { motivo: 'x'.repeat(10) }],
    ['POST', '/api/v1/adiantamentos/100/atualizar-conta', { motivo: 'x'.repeat(10) }],
    ['POST', '/api/v1/adiantamentos/100/reprocessar', { motivo: 'x'.repeat(10) }],
    ['POST', '/api/v1/adiantamentos/100/encerrar-falha', { motivo: 'x'.repeat(10) }],
    ['GET', '/api/v1/adiantamentos/configuracoes'],
    ['GET', '/api/v1/adiantamentos/configuracoes/categorias'],
    ['PUT', '/api/v1/adiantamentos/configuracoes', { versaoEsperada: 3 }],
    ['GET', '/api/v1/adiantamentos/contas'],
    ['GET', '/api/v1/adiantamentos/contas/500'],
    ['POST', '/api/v1/adiantamentos/contas/500/aprovar', { entregadorConfirmadoId: 1 }],
    ['POST', '/api/v1/adiantamentos/contas/500/rejeitar', { motivo: 'x'.repeat(10) }],
    ['POST', '/api/v1/adiantamentos/contas/aprovar-lote', { ids: [500] }],
    ['POST', '/api/v1/adiantamentos/lotes/previa', { ids: [100] }],
    ['POST', '/api/v1/adiantamentos/lotes', { ids: [100], quantidadeEsperada: 1, totalEsperado: '250.00', chaveIdempotencia: '11111111-1111-4111-8111-111111111111' }],
    ['GET', '/api/v1/adiantamentos/lotes'],
    ['GET', '/api/v1/adiantamentos/lotes/900'],
    ['GET', '/api/v1/adiantamentos/lotes/900/arquivo'],
    ['POST', '/api/v1/adiantamentos/lotes/900/cancelar', { motivo: 'x'.repeat(10) }],
    ['POST', '/api/v1/adiantamentos/lotes/900/confirmacao', { falhas: [] }],
    ['POST', '/api/v1/adiantamentos/lotes/900/retorno', { csvBase64: Buffer.from('x').toString('base64') }],
    ['GET', '/api/v1/adiantamentos/repasse?periodo=2026-09-08'],
    ['GET', '/api/v1/adiantamentos/repasse/exportar?periodo=2026-09-08'],
    ['POST', '/api/v1/adiantamentos/repasse/2026-09-08/fechar', { confirmacao: true }],
  ];

  beforeEach(() => {
    resetFixtures();
    permissoesPorEntidade = new Set([]); // 0 das 10 permissões
  });

  for (const [method, path, body] of ROTAS) {
    test(`${method} ${path} -> 403 PERMISSAO_NEGADA`, async () => {
      const r = await request(method, path, { body, cookie: tokenCookie() });
      assert.equal(r.status, 403);
      assert.equal(r.body && r.body.erro, 'PERMISSAO_NEGADA');
    });
  }
});
