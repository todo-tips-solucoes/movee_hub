/**
 * Testes unitários — fixture `bancos-compe.json` (tasks.md 0.2.3).
 * Rodam com: node --test tests/adiantamento-bancos-compe-unit.test.js
 *
 * Correção empírica em relação ao texto original de 0.2.3 ("474 entradas,
 * uma por linha de dados do CSV"): o CSV tem de fato 474 linhas de dados,
 * mas 11 delas são infraestrutura do STR sem código de banco de 3 dígitos
 * (Selic, Bacen, STN, câmaras CIP/B3/CERC — código "n/a" ou "0"), então não
 * são bancos selecionáveis por um motorista (data-model.md "Dados
 * estáticos": entrada = código de 3 dígitos + nome + ISPB). O fixture tem
 * 463 bancos válidos — todos com código de exatamente 3 dígitos, conforme
 * a leitura literal de "cada código tem exatamente 3 dígitos" (que deixaria
 * de valer se as 11 linhas sem código fossem incluídas). Ver dec-035 e o
 * script `scripts/extrair-bancos-compe.js`.
 *
 * Ref: plan.md §Pontos para confirmação item 3; data-model.md "Dados
 * estáticos".
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const fixture = require('../lib/fixtures/bancos-compe.json');

describe('fixture bancos-compe.json', () => {
  test('data de extração e fonte documentadas', () => {
    assert.equal(fixture.dataExtracao, '2026-09-17');
    assert.match(fixture.fonte, /ParticipantesSTR-2026-09-17\.csv/);
  });

  test('leu as 474 linhas de dados do CSV e excluiu as 11 sem código de banco', () => {
    assert.equal(fixture.totalLinhasCsv, 474);
    assert.equal(fixture.excluidosSemCodigo3Digitos, 11);
  });

  test('463 bancos, cada código com exatamente 3 dígitos', () => {
    assert.equal(fixture.bancos.length, 463);
    for (const banco of fixture.bancos) {
      assert.match(banco.codigo, /^\d{3}$/, `código inválido: ${JSON.stringify(banco)}`);
      assert.ok(banco.nome && banco.nome.length > 0);
      assert.ok(banco.ispb && banco.ispb.length > 0);
    }
  });

  test('códigos são únicos (dicionário sem colisão)', () => {
    const codigos = fixture.bancos.map((b) => b.codigo);
    assert.equal(new Set(codigos).size, codigos.length);
  });

  test('RecargaPay não consta como participante (0 ocorrências no nome)', () => {
    const achou = fixture.bancos.filter((b) => /recarga\s*pay/i.test(b.nome));
    assert.equal(achou.length, 0);
  });

  test('Banco do Brasil (001) e Nu Pagamentos (260, Participa_da_Compe=Não) presentes', () => {
    assert.ok(fixture.bancos.some((b) => b.codigo === '001'));
    assert.ok(fixture.bancos.some((b) => b.codigo === '260'));
  });
});
