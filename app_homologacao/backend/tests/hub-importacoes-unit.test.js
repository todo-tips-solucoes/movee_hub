/**
 * Testes unitários — routes/hub-importacoes.js (tasks.md FASE 3, 3.1-3.4).
 * Rodam com: node --test tests/hub-importacoes-unit.test.js
 *
 * Cobre as funções puras exportadas pelo router (sem precisar de
 * PostgREST/DB real — isso é responsabilidade dos testes de integração em
 * infra/hub/testes/hub-importacoes-integration.sh):
 *   - extensaoDe: normalização de extensão
 *   - sanitizarNomeArquivo: nunca deixa passar path traversal / caracteres
 *     perigosos no nome exibido
 *   - caminhoArmazenamento: path determinístico por id (nunca pelo nome do
 *     usuário)
 *   - validarConteudo: aceita CSV/ZIP válidos, rejeita ZIP com >1 entrada,
 *     path traversal, e conteúdo vazio
 *
 * Ref: contracts/importacoes-api.md, research.md Decision 6/8.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-unit';

const {
  extensaoDe,
  sanitizarNomeArquivo,
  caminhoArmazenamento,
  validarConteudo,
  UPLOADS_DIR,
} = require('../routes/hub-importacoes');
const { HubImportParseError } = require('../lib/hub-import-parser');

describe('extensaoDe', () => {
  test('extrai extensão em minúsculas', () => {
    assert.equal(extensaoDe('faturamento.CSV'), '.csv');
    assert.equal(extensaoDe('dados.ZIP'), '.zip');
  });

  test('nome sem extensão -> string vazia', () => {
    assert.equal(extensaoDe('semextensao'), '');
  });

  test('nome ausente/undefined -> string vazia (sem lançar)', () => {
    assert.equal(extensaoDe(undefined), '');
    assert.equal(extensaoDe(null), '');
  });
});

describe('sanitizarNomeArquivo', () => {
  test('mantém nome simples intacto', () => {
    assert.equal(sanitizarNomeArquivo('faturamento_2026-01.csv'), 'faturamento_2026-01.csv');
  });

  test('remove path traversal — só o basename sobrevive', () => {
    assert.equal(sanitizarNomeArquivo('../../etc/passwd'), 'passwd');
  });

  test('caracteres perigosos viram underscore', () => {
    const out = sanitizarNomeArquivo('arquivo com espaço & "aspas".csv');
    assert.match(out, /^[A-Za-z0-9._-]+$/);
  });

  test('nome vazio/ausente cai no default "arquivo"', () => {
    assert.equal(sanitizarNomeArquivo(''), 'arquivo');
    assert.equal(sanitizarNomeArquivo(undefined), 'arquivo');
  });

  test('nome muito longo é truncado a 255 chars', () => {
    const longo = `${'a'.repeat(300)}.csv`;
    const out = sanitizarNomeArquivo(longo);
    assert.ok(out.length <= 255);
  });
});

describe('caminhoArmazenamento', () => {
  test('é determinístico por id, nunca pelo nome do usuário', () => {
    const caminho = caminhoArmazenamento(42, '.csv');
    assert.ok(caminho.startsWith(UPLOADS_DIR));
    assert.ok(caminho.endsWith(`${require('path').sep}42${require('path').sep}original.csv`));
  });

  test('ids diferentes -> diretórios diferentes', () => {
    assert.notEqual(caminhoArmazenamento(1, '.csv'), caminhoArmazenamento(2, '.csv'));
  });
});

describe('validarConteudo', () => {
  test('CSV simples com header + 1 linha -> resolve sem lançar', async () => {
    const buf = Buffer.from('col_a;col_b\nvalor1;valor2\n', 'utf8');
    const out = await validarConteudo(buf, 'dados.csv');
    assert.equal(out.toString('utf8'), buf.toString('utf8'));
  });

  test('conteúdo vazio -> HubImportParseError motivo conteudo_vazio', async () => {
    await assert.rejects(
      () => validarConteudo(Buffer.alloc(0), 'dados.csv'),
      (err) => err instanceof HubImportParseError && err.motivo === 'conteudo_vazio'
    );
  });

  test('CSV só com quebra de linha (sem linha decodificável) -> conteudo_vazio', async () => {
    await assert.rejects(
      () => validarConteudo(Buffer.from('\n\n', 'utf8'), 'dados.csv'),
      (err) => err instanceof HubImportParseError && err.motivo === 'conteudo_vazio'
    );
  });

  test('ZIP inválido (sem EOCD) -> HubImportParseError motivo zip_invalido', async () => {
    await assert.rejects(
      () => validarConteudo(Buffer.from('não é um zip de verdade'), 'dados.zip'),
      (err) => err instanceof HubImportParseError && err.motivo === 'zip_invalido'
    );
  });
});
