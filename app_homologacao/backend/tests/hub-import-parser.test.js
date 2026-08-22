/**
 * Testes unitários — hub-import-parser.js (tasks.md 2.1.5).
 * Rodam com: node --test tests/hub-import-parser.test.js
 *
 * Cobre:
 *   - BOM UTF-8 removido (stripBom + iterarLinhas na 1ª linha)
 *   - split de linha por `;`
 *   - ZIP com path traversal rejeitado
 *   - ZIP declarando tamanho descomprimido > 100 MB rejeitado (via cabeçalho
 *     forjado — não precisa materializar um payload real de 100 MB)
 *   - ZIP com 0 ou >1 entradas rejeitado
 *   - streaming: iterarLinhas entrega linhas incrementalmente, sem esperar
 *     o stream inteiro terminar (prova que não materializa o arquivo
 *     inteiro antes de processar)
 *
 * Ref: research.md Decision 3; briefing s4-pipeline-importacoes.md "Testes
 * exigidos > Unit".
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { PassThrough } = require('stream');

const {
  stripBom,
  splitLinhaCsv,
  resolverConteudoCsv,
  iterarLinhas,
  bufferParaStream,
  validarTipo,
  ehZip,
  HubImportParseError,
} = require('../lib/hub-import-parser');

// ---------------------------------------------------------------------------
// Helpers de fixture ZIP (formato PKZIP mínimo, construído manualmente para
// não depender de nenhuma lib externa de leitura/escrita de ZIP).
// ---------------------------------------------------------------------------

function construirLocalHeader({ nome, metodo, tamanhoComprimido, tamanhoDescomprimido }) {
  const nomeBuf = Buffer.from(nome, 'utf8');
  const buf = Buffer.alloc(30);
  buf.writeUInt32LE(0x04034b50, 0);
  buf.writeUInt16LE(20, 4);
  buf.writeUInt16LE(0, 6);
  buf.writeUInt16LE(metodo, 8);
  buf.writeUInt16LE(0, 10);
  buf.writeUInt16LE(0, 12);
  buf.writeUInt32LE(0, 14);
  buf.writeUInt32LE(tamanhoComprimido, 18);
  buf.writeUInt32LE(tamanhoDescomprimido, 22);
  buf.writeUInt16LE(nomeBuf.length, 26);
  buf.writeUInt16LE(0, 28);
  return Buffer.concat([buf, nomeBuf]);
}

function construirCentralDirEntry({
  nome, metodo, tamanhoComprimido, tamanhoDescomprimido, offsetLocal, tamanhoDescomprimidoForjado,
}) {
  const nomeBuf = Buffer.from(nome, 'utf8');
  const buf = Buffer.alloc(46);
  buf.writeUInt32LE(0x02014b50, 0);
  buf.writeUInt16LE(20, 4);
  buf.writeUInt16LE(20, 6);
  buf.writeUInt16LE(0, 8);
  buf.writeUInt16LE(metodo, 10);
  buf.writeUInt16LE(0, 12);
  buf.writeUInt16LE(0, 14);
  buf.writeUInt32LE(0, 16);
  buf.writeUInt32LE(tamanhoComprimido, 20);
  buf.writeUInt32LE(
    tamanhoDescomprimidoForjado !== undefined ? tamanhoDescomprimidoForjado : tamanhoDescomprimido,
    24
  );
  buf.writeUInt16LE(nomeBuf.length, 28);
  buf.writeUInt16LE(0, 30);
  buf.writeUInt16LE(0, 32);
  buf.writeUInt16LE(0, 34);
  buf.writeUInt16LE(0, 36);
  buf.writeUInt32LE(0, 38);
  buf.writeUInt32LE(offsetLocal, 42);
  return Buffer.concat([buf, nomeBuf]);
}

function construirEocd({ totalEntradas, tamanhoDiretorioCentral, offsetDiretorioCentral }) {
  const buf = Buffer.alloc(22);
  buf.writeUInt32LE(0x06054b50, 0);
  buf.writeUInt16LE(0, 4);
  buf.writeUInt16LE(0, 6);
  buf.writeUInt16LE(totalEntradas, 8);
  buf.writeUInt16LE(totalEntradas, 10);
  buf.writeUInt32LE(tamanhoDiretorioCentral, 12);
  buf.writeUInt32LE(offsetDiretorioCentral, 16);
  buf.writeUInt16LE(0, 20);
  return buf;
}

/** ZIP de 1 entrada válida (DEFLATE real). */
function construirZipUmaEntrada({ nome = 'dados.csv', conteudo = 'a;b\n1;2\n', tamanhoDescomprimidoForjado } = {}) {
  const dadosOriginais = Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(conteudo, 'utf8');
  const comprimido = zlib.deflateRawSync(dadosOriginais);
  const localHeader = construirLocalHeader({
    nome, metodo: 8, tamanhoComprimido: comprimido.length, tamanhoDescomprimido: dadosOriginais.length,
  });
  const localBloco = Buffer.concat([localHeader, comprimido]);
  const centralEntry = construirCentralDirEntry({
    nome, metodo: 8, tamanhoComprimido: comprimido.length, tamanhoDescomprimido: dadosOriginais.length,
    offsetLocal: 0, tamanhoDescomprimidoForjado,
  });
  const eocd = construirEocd({
    totalEntradas: 1,
    tamanhoDiretorioCentral: centralEntry.length,
    offsetDiretorioCentral: localBloco.length,
  });
  return Buffer.concat([localBloco, centralEntry, eocd]);
}

/** ZIP com 2 entradas (deve ser rejeitado — só 1 entrada é aceita). */
function construirZipDuasEntradas() {
  const a = Buffer.from('a\n', 'utf8');
  const b = Buffer.from('b\n', 'utf8');
  const compA = zlib.deflateRawSync(a);
  const compB = zlib.deflateRawSync(b);
  const localA = Buffer.concat([
    construirLocalHeader({ nome: 'a.csv', metodo: 8, tamanhoComprimido: compA.length, tamanhoDescomprimido: a.length }),
    compA,
  ]);
  const localB = Buffer.concat([
    construirLocalHeader({ nome: 'b.csv', metodo: 8, tamanhoComprimido: compB.length, tamanhoDescomprimido: b.length }),
    compB,
  ]);
  const offsetA = 0;
  const offsetB = localA.length;
  const centralA = construirCentralDirEntry({
    nome: 'a.csv', metodo: 8, tamanhoComprimido: compA.length, tamanhoDescomprimido: a.length, offsetLocal: offsetA,
  });
  const centralB = construirCentralDirEntry({
    nome: 'b.csv', metodo: 8, tamanhoComprimido: compB.length, tamanhoDescomprimido: b.length, offsetLocal: offsetB,
  });
  const centralDir = Buffer.concat([centralA, centralB]);
  const eocd = construirEocd({
    totalEntradas: 2,
    tamanhoDiretorioCentral: centralDir.length,
    offsetDiretorioCentral: localA.length + localB.length,
  });
  return Buffer.concat([localA, localB, centralDir, eocd]);
}

// ---------------------------------------------------------------------------

describe('hub-import-parser — stripBom + splitLinhaCsv (2.1.1)', () => {
  test('remove BOM UTF-8 de Buffer', () => {
    const comBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a;b', 'utf8')]);
    const semBom = stripBom(comBom);
    assert.equal(semBom.toString('utf8'), 'a;b');
  });

  test('remove BOM UTF-8 de string', () => {
    const comBom = '﻿data_do_lancamento_financeiro;periodo';
    assert.equal(stripBom(comBom), 'data_do_lancamento_financeiro;periodo');
  });

  test('stripBom é idempotente (sem BOM não altera nada)', () => {
    assert.equal(stripBom('a;b'), 'a;b');
    assert.deepEqual(stripBom(Buffer.from('a;b')), Buffer.from('a;b'));
  });

  test('splitLinhaCsv separa por ; e remove \\r residual', () => {
    assert.deepEqual(splitLinhaCsv('a;b;c'), ['a', 'b', 'c']);
    assert.deepEqual(splitLinhaCsv('a;b;c\r'), ['a', 'b', 'c']);
    assert.deepEqual(splitLinhaCsv(''), []);
  });

  test('splitLinhaCsv desaspa campos: `""` vazio (dialeto real) e quotados', () => {
    // Linha real da plataforma parceira: campo vazio vem como `""` — sem
    // desaspagem, o id_da_pessoa_entregadora vazio de franquia virava
    // "UUID inválido" (179 linhas rejeitadas na importação de 2026-07-03).
    assert.deepEqual(splitLinhaCsv('a;"";c'), ['a', '', 'c']);
    assert.deepEqual(splitLinhaCsv('"a";b;""\r'), ['a', 'b', '']);
    assert.deepEqual(splitLinhaCsv('"diz ""oi"" ali";b'), ['diz "oi" ali', 'b']);
    // aspa solta / desbalanceada NÃO é desaspada (não é campo quotado)
    assert.deepEqual(splitLinhaCsv('a";b;"'), ['a"', 'b', '"']);
  });
});

describe('hub-import-parser — iterarLinhas (2.1.2, streaming)', () => {
  test('remove BOM só da primeira linha e numera linhas a partir de 1', async () => {
    const conteudo = '﻿col1;col2\nval1;val2\nval3;val4\n';
    const stream = bufferParaStream(conteudo);
    const linhas = [];
    for await (const linha of iterarLinhas(stream)) {
      linhas.push(linha);
    }
    assert.equal(linhas.length, 3);
    assert.equal(linhas[0].numeroLinha, 1);
    assert.deepEqual(linhas[0].campos, ['col1', 'col2']);
    assert.deepEqual(linhas[1].campos, ['val1', 'val2']);
    assert.deepEqual(linhas[2].campos, ['val3', 'val4']);
  });

  test('ignora linha vazia final', async () => {
    const stream = bufferParaStream('a;b\nc;d\n');
    const linhas = [];
    for await (const linha of iterarLinhas(stream)) linhas.push(linha);
    assert.equal(linhas.length, 2);
  });

  test('processa incrementalmente sem esperar o stream inteiro (não materializa arquivo inteiro em memória)', async () => {
    const stream = new PassThrough();
    const iterator = iterarLinhas(stream)[Symbol.asyncIterator]();

    stream.write('linha1;a\n');
    const primeiro = await iterator.next();
    assert.equal(primeiro.done, false);
    assert.equal(primeiro.value.bruta, 'linha1;a');

    // A 2ª linha só é escrita DEPOIS de a 1ª já ter sido consumida — prova
    // que iterarLinhas entrega resultados progressivamente, não espera
    // `stream.end()` para começar a produzir (comportamento incompatível
    // com "ler tudo para uma string e fazer .split('\n')").
    stream.write('linha2;b\n');
    const segundo = await iterator.next();
    assert.equal(segundo.value.bruta, 'linha2;b');

    stream.end();
    const terceiro = await iterator.next();
    assert.equal(terceiro.done, true);
  });
});

describe('hub-import-parser — seleção de tipo (2.1.3, sem sniffing)', () => {
  test('validarTipo aceita faturamento/performance', () => {
    assert.equal(validarTipo('faturamento'), 'faturamento');
    assert.equal(validarTipo('performance'), 'performance');
  });

  test('validarTipo rejeita tipo desconhecido', () => {
    assert.throws(() => validarTipo('envio_massa'), HubImportParseError);
    assert.throws(() => validarTipo(undefined), HubImportParseError);
  });

  test('ehZip detecta extensão .zip case-insensitive', () => {
    assert.equal(ehZip('Faturamento.ZIP'), true);
    assert.equal(ehZip('dados.csv'), false);
    assert.equal(ehZip(undefined), false);
  });
});

describe('hub-import-parser — extração de ZIP segura (2.1.4)', () => {
  test('extrai corretamente ZIP de 1 entrada válida', () => {
    const zip = construirZipUmaEntrada({ conteudo: 'col1;col2\nval1;val2\n' });
    const conteudo = resolverConteudoCsv(zip, { nomeArquivo: 'arquivo.zip' });
    assert.equal(conteudo.toString('utf8'), 'col1;col2\nval1;val2\n');
  });

  test('CSV puro (não .zip) passa direto, sem tentar extrair', () => {
    const buffer = Buffer.from('col1;col2\n', 'utf8');
    const resultado = resolverConteudoCsv(buffer, { nomeArquivo: 'arquivo.csv' });
    assert.equal(resultado, buffer);
  });

  test('rejeita ZIP com path traversal no nome da entrada', () => {
    const zip = construirZipUmaEntrada({ nome: '../../etc/passwd', conteudo: 'x' });
    assert.throws(
      () => resolverConteudoCsv(zip, { nomeArquivo: 'malicioso.zip' }),
      (err) => err instanceof HubImportParseError && err.motivo === 'zip_path_traversal'
    );
  });

  test('rejeita ZIP com path absoluto no nome da entrada', () => {
    const zip = construirZipUmaEntrada({ nome: '/etc/passwd', conteudo: 'x' });
    assert.throws(
      () => resolverConteudoCsv(zip, { nomeArquivo: 'malicioso.zip' }),
      (err) => err instanceof HubImportParseError && err.motivo === 'zip_path_traversal'
    );
  });

  test('rejeita ZIP que declara tamanho descomprimido > limite (100 MB)', () => {
    const zip = construirZipUmaEntrada({
      conteudo: 'linha pequena',
      tamanhoDescomprimidoForjado: 200 * 1024 * 1024, // mente no cabeçalho — não precisa gerar payload real
    });
    assert.throws(
      () => resolverConteudoCsv(zip, { nomeArquivo: 'bomba.zip' }),
      (err) => err instanceof HubImportParseError && err.motivo === 'zip_tamanho_excedido'
    );
  });

  test('respeita limite customizado via maxZipDescomprimidoBytes', () => {
    const zip = construirZipUmaEntrada({ conteudo: 'x'.repeat(1000) });
    assert.throws(
      () => resolverConteudoCsv(zip, { nomeArquivo: 'a.zip', maxZipDescomprimidoBytes: 100 }),
      (err) => err instanceof HubImportParseError && err.motivo === 'zip_tamanho_excedido'
    );
  });

  test('rejeita ZIP com múltiplas entradas (só 1 é aceita)', () => {
    const zip = construirZipDuasEntradas();
    assert.throws(
      () => resolverConteudoCsv(zip, { nomeArquivo: 'duas.zip' }),
      (err) => err instanceof HubImportParseError && err.motivo === 'zip_multiplas_entradas'
    );
  });

  test('rejeita buffer que não é um ZIP válido', () => {
    const naoZip = Buffer.from('isto nao e um zip', 'utf8');
    assert.throws(
      () => resolverConteudoCsv(naoZip, { nomeArquivo: 'falso.zip' }),
      HubImportParseError
    );
  });

  test('pipeline completo: ZIP -> resolverConteudoCsv -> iterarLinhas', async () => {
    const zip = construirZipUmaEntrada({ conteudo: '﻿col1;col2\nval1;val2\n' });
    const conteudo = resolverConteudoCsv(zip, { nomeArquivo: 'arquivo.zip' });
    const stream = bufferParaStream(conteudo);
    const linhas = [];
    for await (const linha of iterarLinhas(stream)) linhas.push(linha);
    assert.equal(linhas.length, 2);
    assert.deepEqual(linhas[0].campos, ['col1', 'col2']);
  });
});
