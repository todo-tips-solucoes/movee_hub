// test/log-execucao.test.js (tasks.md 3.1.4) — escrita JSON Lines +
// allowlist de campos (nunca credencial/url_s3 no log).
'use strict';

const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { iniciarExecucao, finalizarExecucao, filtrarRelatorio, CAMPOS_RELATORIO_PERMITIDOS } = require('../src/log-execucao');

const DIR_TESTE = fs.mkdtempSync(path.join(os.tmpdir(), 'robo-entrego-log-test-'));
const CAMINHO_LOG = path.join(DIR_TESTE, 'execucoes.jsonl');

function lerLinhas() {
  if (!fs.existsSync(CAMINHO_LOG)) return [];
  return fs
    .readFileSync(CAMINHO_LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

beforeEach(() => {
  if (fs.existsSync(CAMINHO_LOG)) fs.unlinkSync(CAMINHO_LOG);
});

after(() => {
  fs.rmSync(DIR_TESTE, { recursive: true, force: true });
});

describe('iniciarExecucao / finalizarExecucao — append-only JSON Lines', () => {
  test('escreve 1 linha inicio + 1 linha fim, mesmo execucao_id', () => {
    const { execucaoId } = iniciarExecucao({ caminhoLog: CAMINHO_LOG });
    finalizarExecucao({
      execucaoId,
      resultado: 'sucesso',
      relatorios: [],
      tentativasTotais: 1,
      caminhoLog: CAMINHO_LOG,
    });
    const linhas = lerLinhas();
    assert.equal(linhas.length, 2);
    assert.equal(linhas[0].linha, 'inicio');
    assert.equal(linhas[1].linha, 'fim');
    assert.equal(linhas[0].execucao_id, execucaoId);
    assert.equal(linhas[1].execucao_id, execucaoId);
  });

  test('resultado inválido lança', () => {
    assert.throws(() => finalizarExecucao({ execucaoId: 'x', resultado: 'sucesso_total', caminhoLog: CAMINHO_LOG }), /resultado inválido/);
  });

  test('execucaoId ausente lança', () => {
    assert.throws(() => finalizarExecucao({ resultado: 'sucesso', caminhoLog: CAMINHO_LOG }), /execucaoId obrigatório/);
  });

  test('múltiplas execuções acumulam no mesmo arquivo (append, nunca sobrescreve)', () => {
    const e1 = iniciarExecucao({ caminhoLog: CAMINHO_LOG });
    finalizarExecucao({ execucaoId: e1.execucaoId, resultado: 'sucesso', caminhoLog: CAMINHO_LOG });
    const e2 = iniciarExecucao({ caminhoLog: CAMINHO_LOG });
    finalizarExecucao({ execucaoId: e2.execucaoId, resultado: 'falha_total', motivoFalha: 'timeout', caminhoLog: CAMINHO_LOG });
    assert.equal(lerLinhas().length, 4);
  });
});

describe('filtrarRelatorio — allowlist (3.1.4, nunca credencial/url_s3)', () => {
  test('mantém só os campos permitidos', () => {
    const bruto = {
      tipo_portal: 'PERFORMANCE',
      tipo_hub: 'performance',
      data_referencia: '2026-08-27',
      url_s3: 'https://s3.amazonaws.com/bucket/segredo-pre-assinado?X-Amz-Signature=abc',
      sha256: 'deadbeef',
      importacao_id: 123,
      status_hub: 'completed',
      reprocessado: false,
      tentativas: 1,
      // campos que NUNCA podem vazar para o log
      senha: 'super-secreto',
      token: 'bearer-xyz',
    };
    const filtrado = filtrarRelatorio(bruto);
    assert.deepEqual(Object.keys(filtrado).sort(), [...CAMPOS_RELATORIO_PERMITIDOS].sort());
    assert.equal(filtrado.url_s3, undefined);
    assert.equal(filtrado.senha, undefined);
    assert.equal(filtrado.token, undefined);
    assert.equal(filtrado.sha256, 'deadbeef');
  });

  test('objeto vazio/ausente -> {} (nunca lança)', () => {
    assert.deepEqual(filtrarRelatorio({}), {});
    assert.deepEqual(filtrarRelatorio(null), {});
    assert.deepEqual(filtrarRelatorio(undefined), {});
  });

  test('finalizarExecucao aplica o filtro a cada relatório do array', () => {
    const { execucaoId } = iniciarExecucao({ caminhoLog: CAMINHO_LOG });
    finalizarExecucao({
      execucaoId,
      resultado: 'falha_parcial',
      relatorios: [{ tipo_hub: 'performance', url_s3: 'https://segredo', tentativas: 1 }],
      tentativasTotais: 1,
      motivoFalha: 'faturamento falhou',
      caminhoLog: CAMINHO_LOG,
    });
    const linhaFim = lerLinhas()[1];
    assert.equal(linhaFim.relatorios[0].url_s3, undefined);
    assert.equal(linhaFim.relatorios[0].tipo_hub, 'performance');
  });
});
