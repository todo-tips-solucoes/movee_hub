/**
 * Testes unitários — lib/hub-envio-massa-import-log.js (S8, tasks.md
 * FASE 4.1.7). Rodam com: node --test tests/hub-envio-massa-import-log-unit.test.js
 *
 * Mesmo padrão de mock de `global.fetch` de tests/hub-postgrest-unit.test.js
 * / tests/hub-envio-massa-permission-unit.test.js — sem rede real.
 *
 * Cenários (contracts/claims-adapter.md "Contrato de log de importação",
 * research.md Decision 9):
 *   - derivarStatusImportacao: 100% válidas -> completed; parcial ->
 *     completed_with_errors; parse falhou antes de qualquer linha -> failed
 *   - guard de flag HUB_IMPORT_LOG_ENVIO=off -> retorna sem gravar (fetch
 *     NUNCA chamado)
 *   - falha simulada de INSERT (PostgREST não-2xx) -> não propaga exceção
 *     (FR-011, best-effort)
 *   - guard de sessão legada (call site, não deste helper) -> verificação
 *     estática de que server.js só chama `registrarImportacaoEnvioMassa`
 *     dentro de um guard `req.hubContext && req.hubContext.viaHub === true`
 *     (mesmo padrão de verificação por texto de 2.2.7, achado F3 — reusa a
 *     mesma justificativa de não importar server.js diretamente)
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.PGRST_JWT_SECRET = process.env.PGRST_JWT_SECRET || 'segredo-teste-postgrest';
process.env.POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest-fake:3000';

const {
  registrarImportacaoEnvioMassa,
  derivarStatusImportacao,
} = require('../lib/hub-envio-massa-import-log');

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_FLAG = process.env.HUB_IMPORT_LOG_ENVIO;

function mockResponseOk(body) {
  return {
    ok: true,
    status: 201,
    statusText: 'Created',
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

function mockResponseErro(status) {
  return {
    ok: false,
    status,
    statusText: 'Erro',
    headers: { get: () => null },
    text: async () => JSON.stringify({ message: 'erro simulado' }),
  };
}

describe('derivarStatusImportacao (4.1.7)', () => {
  test('100% das linhas válidas -> completed', () => {
    assert.equal(derivarStatusImportacao(10, 0), 'completed');
  });

  test('parcialmente inválida -> completed_with_errors', () => {
    assert.equal(derivarStatusImportacao(10, 3), 'completed_with_errors');
  });

  test('100% inválida (parse concluiu, todas as linhas com erro) -> completed_with_errors', () => {
    assert.equal(derivarStatusImportacao(10, 10), 'completed_with_errors');
  });

  test('parse falhou antes de qualquer linha (totalLinhas=0) -> failed', () => {
    assert.equal(derivarStatusImportacao(0, 0), 'failed');
  });

  test('parse falhou antes de qualquer linha (totalLinhas=null) -> failed', () => {
    assert.equal(derivarStatusImportacao(null, 0), 'failed');
  });
});

describe('registrarImportacaoEnvioMassa (4.1.1-4.1.5, 4.1.7)', () => {
  beforeEach(() => {
    delete process.env.HUB_IMPORT_LOG_ENVIO;
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_FLAG === undefined) delete process.env.HUB_IMPORT_LOG_ENVIO;
    else process.env.HUB_IMPORT_LOG_ENVIO = ORIGINAL_FLAG;
  });

  test('guard de flag HUB_IMPORT_LOG_ENVIO=off -> retorna sem gravar, fetch NUNCA chamado (FR-010)', async () => {
    process.env.HUB_IMPORT_LOG_ENVIO = 'off';
    global.fetch = async () => {
      throw new Error('não deveria chamar o PostgREST com a flag off');
    };
    await assert.doesNotReject(() =>
      registrarImportacaoEnvioMassa({
        empresaId: 9001,
        usuarioId: 1,
        nomeArquivo: 'lote.xlsx',
        arquivo: Buffer.from('conteudo'),
        totalLinhas: 5,
        linhasValidas: 5,
        linhasInvalidas: 0,
      })
    );
  });

  test('grava com status derivado (completed) quando status não é passado explicitamente', async () => {
    let payloadEnviado = null;
    global.fetch = async (url, opts) => {
      payloadEnviado = JSON.parse(opts.body);
      return mockResponseOk([{ id: 1 }]);
    };
    await registrarImportacaoEnvioMassa({
      empresaId: 9001,
      usuarioId: 1,
      nomeArquivo: 'lote.xlsx',
      arquivo: Buffer.from('conteudo-do-arquivo'),
      totalLinhas: 5,
      linhasValidas: 5,
      linhasInvalidas: 0,
    });
    assert.ok(payloadEnviado, 'esperava que o INSERT tivesse sido chamado');
    assert.equal(payloadEnviado.tipo, 'envio_massa');
    assert.equal(payloadEnviado.status, 'completed');
    assert.equal(payloadEnviado.id_empresa, 9001);
    assert.equal(payloadEnviado.criado_por, 1);
    assert.equal(payloadEnviado.hash_sha256.length, 64);
  });

  test('grava completed_with_errors quando há linhas inválidas parciais', async () => {
    let payloadEnviado = null;
    global.fetch = async (url, opts) => {
      payloadEnviado = JSON.parse(opts.body);
      return mockResponseOk([{ id: 2 }]);
    };
    await registrarImportacaoEnvioMassa({
      empresaId: 9001,
      usuarioId: 1,
      nomeArquivo: 'lote.xlsx',
      arquivo: Buffer.from('x'),
      totalLinhas: 10,
      linhasValidas: 7,
      linhasInvalidas: 3,
    });
    assert.equal(payloadEnviado.status, 'completed_with_errors');
  });

  test('grava failed quando o parse falhou antes de qualquer linha (arquivo ilegível)', async () => {
    let payloadEnviado = null;
    global.fetch = async (url, opts) => {
      payloadEnviado = JSON.parse(opts.body);
      return mockResponseOk([{ id: 3 }]);
    };
    await registrarImportacaoEnvioMassa({
      empresaId: 9001,
      usuarioId: 1,
      nomeArquivo: 'corrompido.xlsx',
      arquivo: null,
      totalLinhas: 0,
      linhasValidas: 0,
      linhasInvalidas: 0,
    });
    assert.equal(payloadEnviado.status, 'failed');
    assert.equal(payloadEnviado.tamanho_bytes, null);
  });

  test('falha simulada de INSERT (PostgREST 500) NÃO propaga exceção (FR-011)', async () => {
    global.fetch = async () => mockResponseErro(500);
    await assert.doesNotReject(() =>
      registrarImportacaoEnvioMassa({
        empresaId: 9001,
        usuarioId: 1,
        nomeArquivo: 'lote.xlsx',
        arquivo: Buffer.from('x'),
        totalLinhas: 5,
        linhasValidas: 5,
        linhasInvalidas: 0,
      })
    );
  });

  test('falha simulada de INSERT (409 conflito de UNIQUE em reenvio) NÃO propaga exceção', async () => {
    global.fetch = async () => mockResponseErro(409);
    await assert.doesNotReject(() =>
      registrarImportacaoEnvioMassa({
        empresaId: 9001,
        usuarioId: 1,
        nomeArquivo: 'lote.xlsx',
        arquivo: Buffer.from('x'),
        totalLinhas: 5,
        linhasValidas: 5,
        linhasInvalidas: 0,
      })
    );
  });

  test('erro de rede (fetch rejeita) NÃO propaga exceção', async () => {
    global.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    await assert.doesNotReject(() =>
      registrarImportacaoEnvioMassa({
        empresaId: 9001,
        usuarioId: 1,
        nomeArquivo: 'lote.xlsx',
        arquivo: Buffer.from('x'),
        totalLinhas: 5,
        linhasValidas: 5,
        linhasInvalidas: 0,
      })
    );
  });

  test('status explícito passado pelo caller tem precedência sobre a derivação automática', async () => {
    let payloadEnviado = null;
    global.fetch = async (url, opts) => {
      payloadEnviado = JSON.parse(opts.body);
      return mockResponseOk([{ id: 4 }]);
    };
    await registrarImportacaoEnvioMassa({
      empresaId: 9001,
      usuarioId: 1,
      nomeArquivo: 'lote.xlsx',
      arquivo: Buffer.from('x'),
      totalLinhas: 10,
      linhasValidas: 10,
      linhasInvalidas: 0,
      status: 'failed',
    });
    assert.equal(payloadEnviado.status, 'failed');
  });
});

describe('guard de sessão legada no call site (server.js) — verificação estática', () => {
  const SERVER_PATH = path.resolve(__dirname, '..', 'server.js');
  const SERVER_SRC = fs.readFileSync(SERVER_PATH, 'utf8');

  test('registrarImportacaoEnvioMassa só é chamada dentro de um guard req.hubContext?.viaHub===true em POST /upload', () => {
    const idxUpload = SERVER_SRC.indexOf("app.post('/upload'");
    assert.notEqual(idxUpload, -1, 'rota POST /upload não encontrada em server.js');
    const idxChamada = SERVER_SRC.indexOf('registrarImportacaoEnvioMassa(', idxUpload);
    if (idxChamada === -1) {
      // FASE 4.1.6 (wiring) ainda não aplicada nesta onda — aceitável
      // (helper testável isoladamente antes da integração em server.js).
      return;
    }
    const trechoAntes = SERVER_SRC.slice(Math.max(0, idxChamada - 400), idxChamada);
    const temGuardViaHub = /req\.hubContext\s*&&\s*req\.hubContext\.viaHub\s*===\s*true/.test(trechoAntes)
      || /req\.hubContext\?\.viaHub\s*===\s*true/.test(trechoAntes);
    assert.ok(temGuardViaHub, 'chamada a registrarImportacaoEnvioMassa em POST /upload não está protegida por guard req.hubContext.viaHub===true nas ~400 chars anteriores');
  });
});
