// test/taxonomia-erro.test.js (tasks.md 3.1.3) — 1 caso por linha da tabela
// de docs/specs/robo-entrego/research.md Decision 11.
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { CLASSIFICACAO, classificarSinal, ehFalhaDefinitiva } = require('../src/taxonomia-erro');

describe('classificarSinal — 1:1 com research.md Decision 11', () => {
  const casos = [
    ['timeout_rede', CLASSIFICACAO.TRANSITORIO],
    ['erro_conexao', CLASSIFICACAO.TRANSITORIO],
    ['http_5xx_portal', CLASSIFICACAO.TRANSITORIO],
    ['http_5xx_hub', CLASSIFICACAO.TRANSITORIO],
    ['sessao_expirada_401', CLASSIFICACAO.NAO_E_FALHA],
    ['schema_inesperado', CLASSIFICACAO.SUSPEITA_ANTIBOT],
    ['upload_201', CLASSIFICACAO.SUCESSO],
    ['upload_409', CLASSIFICACAO.SUCESSO_IDEMPOTENTE],
    ['upload_422', CLASSIFICACAO.FALHA_HUB],
    ['polling_failed', CLASSIFICACAO.FALHA_HUB],
    ['polling_completed_with_errors', CLASSIFICACAO.FALHA_HUB],
    ['polling_completed', CLASSIFICACAO.SUCESSO],
  ];

  for (const [sinal, esperado] of casos) {
    test(`${sinal} -> ${esperado}`, () => {
      assert.equal(classificarSinal(sinal), esperado);
    });
  }

  test('sinal desconhecido lança (nunca classifica silenciosamente)', () => {
    assert.throws(() => classificarSinal('sinal_inventado'), /sinal desconhecido/);
  });
});

describe('ehFalhaDefinitiva — última linha de Decision 11', () => {
  test('tentativas esgotadas -> falha definitiva', () => {
    assert.equal(ehFalhaDefinitiva({ tentativasEsgotadas: true }), true);
  });
  test('suspeita anti-bot confirmada -> falha definitiva', () => {
    assert.equal(ehFalhaDefinitiva({ suspeitaAntibotConfirmada: true }), true);
  });
  test('falha estrutural do hub sem retry -> falha definitiva', () => {
    assert.equal(ehFalhaDefinitiva({ falhaHubSemRetry: true }), true);
  });
  test('nenhuma condição -> não é falha definitiva', () => {
    assert.equal(ehFalhaDefinitiva({}), false);
    assert.equal(ehFalhaDefinitiva(), false);
  });
});

// --- movimento ainda não publicado (2026-08-29) ------------------------------
describe('relatorio_sem_dados', () => {
  test('classifica como SEM_DADOS — nem falha, nem sucesso', () => {
    assert.equal(classificarSinal('relatorio_sem_dados'), CLASSIFICACAO.SEM_DADOS);
  });

  test('SEM_DADOS é distinto de TRANSITORIO — não entra no retry de 1/5/15min', () => {
    // Retentar em 1 minuto não faz o portal publicar o movimento; quem retenta
    // é a próxima janela do dia (config.json).
    assert.notEqual(CLASSIFICACAO.SEM_DADOS, CLASSIFICACAO.TRANSITORIO);
  });

  test('SEM_DADOS não é SUSPEITA_ANTIBOT — o portal respondeu certo', () => {
    assert.notEqual(CLASSIFICACAO.SEM_DADOS, CLASSIFICACAO.SUSPEITA_ANTIBOT);
  });
});
