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
  idValido,
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

  // F2 (pós-review PR #57) — ZIP estruturalmente válido: a rota valida SÓ a
  // estrutura (1 entrada, nome seguro, tamanho declarado) SEM inflar. Prova
  // indireta de "não inflou": o conteúdo devolvido é o BUFFER ORIGINAL do
  // upload (ainda comprimido), não o CSV extraído — bem diferente do
  // comportamento antigo (que devolvia o CSV já descomprimido).
  test('F2: ZIP estruturalmente válido -> resolve sem lançar e SEM inflar (devolve o buffer ORIGINAL do upload, não o CSV extraído)', async () => {
    const zlib = require('zlib');
    const csvOriginal = 'col1;col2\nval1;val2\n';
    const comprimido = zlib.deflateRawSync(Buffer.from(csvOriginal, 'utf8'));
    const nome = Buffer.from('dados.csv', 'utf8');
    const localHeader = Buffer.alloc(30 + nome.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(8, 8); // DEFLATE
    localHeader.writeUInt32LE(comprimido.length, 18);
    localHeader.writeUInt32LE(csvOriginal.length, 22);
    localHeader.writeUInt16LE(nome.length, 26);
    nome.copy(localHeader, 30);
    const localBloco = Buffer.concat([localHeader, comprimido]);

    const centralEntry = Buffer.alloc(46 + nome.length);
    centralEntry.writeUInt32LE(0x02014b50, 0);
    centralEntry.writeUInt16LE(20, 4);
    centralEntry.writeUInt16LE(20, 6);
    centralEntry.writeUInt16LE(8, 10); // DEFLATE
    centralEntry.writeUInt32LE(comprimido.length, 20);
    centralEntry.writeUInt32LE(csvOriginal.length, 24);
    centralEntry.writeUInt16LE(nome.length, 28);
    centralEntry.writeUInt32LE(0, 42); // offsetLocal=0
    nome.copy(centralEntry, 46);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(centralEntry.length, 12);
    eocd.writeUInt32LE(localBloco.length, 16);

    const zip = Buffer.concat([localBloco, centralEntry, eocd]);

    const out = await validarConteudo(zip, 'dados.zip');
    assert.equal(Buffer.compare(out, zip), 0, 'validarConteudo NÃO deve transformar o buffer — a rota não infla');
  });

  test('F2: ZIP com >1 entrada -> rejeitado SEM inflar (mesma taxonomia de erro de antes)', async () => {
    // Reusa a fixture de 2 entradas do hub-import-parser.test.js seria
    // redundante — aqui só confirma que o motivo de erro (checado ANTES de
    // qualquer inflate) segue idêntico à API antiga.
    const eocdFalsoDuasEntradas = Buffer.alloc(22);
    eocdFalsoDuasEntradas.writeUInt32LE(0x06054b50, 0);
    eocdFalsoDuasEntradas.writeUInt16LE(2, 8);
    eocdFalsoDuasEntradas.writeUInt16LE(2, 10);
    eocdFalsoDuasEntradas.writeUInt32LE(0, 12);
    eocdFalsoDuasEntradas.writeUInt32LE(0, 16);
    await assert.rejects(
      () => validarConteudo(eocdFalsoDuasEntradas, 'duas.zip'),
      (err) => err instanceof HubImportParseError && err.motivo === 'zip_multiplas_entradas'
    );
  });
});

describe('idValido (F11 — pós-review PR #57)', () => {
  test('aceita string de só dígitos', () => {
    assert.equal(idValido('123'), true);
    assert.equal(idValido('0'), true);
    assert.equal(idValido('00042'), true); // zero à esquerda ainda é só-dígitos
  });

  test('rejeita lixo à direita/esquerda que parseInt aceitaria silenciosamente', () => {
    assert.equal(idValido('123abc'), false);
    assert.equal(idValido('abc123'), false);
    assert.equal(idValido('12.3'), false);
    assert.equal(idValido('1e10'), false);
    assert.equal(idValido(' 123'), false);
    assert.equal(idValido('123 '), false);
  });

  test('rejeita negativo/vazio/não-string', () => {
    assert.equal(idValido('-1'), false);
    assert.equal(idValido(''), false);
    assert.equal(idValido(undefined), false);
    assert.equal(idValido(null), false);
    assert.equal(idValido(123), false); // número, não string (req.params sempre é string)
  });
});
