/**
 * FR-051: célula NATIVA do Excel (data como serial, valor como número), planilha
 * gerada pelo SheetJS, cellDates ligado/desligado x epoch 1900/1904.
 * Rodam com: node --test tests/lancamento-externo-xlsx-nativo.test.js
 */
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { lerLancamentos, interpretarLinhas } = require('../lib/lancamento-externo');
const { xlsxDeAoa, comCabecalho, cnpjSintetico, serial } = require('./helpers/xlsx-sintetico');

const HOJE = '2026-10-22';
const ler = (aoa, o) => lerLancamentos(xlsxDeAoa(aoa, o), { hoje: HOJE });

for (const date1904 of [false, true]) {
  for (const cellDates of [false, true]) {
    describe(`epoch ${date1904 ? 1904 : 1900} x cellDates ${cellDates ? 'on' : 'off'}`, () => {
      test('data nativa vira a data de calendário certa e date1904 é lido do arquivo', () => {
        // Date local ao meio-dia: o SheetJS grava via fuso do host; o meio-dia mantém o dia de calendário.
        const cel = cellDates ? new Date(2026, 9, 21, 12) : serial(2026, 10, 21, date1904);
        const r = ler(comCabecalho([cnpjSintetico(1), cel, 30]), { date1904, cellDates });
        assert.equal(r.date1904, date1904);
        assert.deepEqual(r.recusadas, []);
        assert.equal(r.validas[0].data, '2026-10-21');
      });
    });
  }
}

describe('célula nativa — bordas', () => {
  test('fração de dia é ignorada (46316.875 ainda é 2026-10-21)', () => {
    const r = ler(comCabecalho([cnpjSintetico(1), serial(2026, 10, 21) + 0.875, 30]));
    assert.equal(r.validas[0].data, '2026-10-21');
  });
  test('serial inválido (parse_date_code -> null) -> DATA_INVALIDA, sem exceção', () => {
    assert.deepEqual(ler(comCabecalho([cnpjSintetico(1), -5, 30])).recusadas, [{ i: 0, motivo: 'DATA_INVALIDA' }]);
  });
  test('epoch ilegível (date1904 null) -> EPOCH_ILEGIVEL, nunca assume 1900', () => {
    const r = interpretarLinhas([[cnpjSintetico(1), serial(2026, 10, 21), 30]], null, HOJE);
    assert.deepEqual(r.recusadas, [{ i: 0, motivo: 'EPOCH_ILEGIVEL' }]);
    // data em TEXTO não depende do epoch e segue aceita
    assert.equal(interpretarLinhas([[cnpjSintetico(1), '21/10/2026', 30]], null, HOJE).validas.length, 1);
  });
  test('valor numérico nativo: 30.5 -> "30.50"; fração de centavo recusa', () => {
    const r = ler(comCabecalho([cnpjSintetico(1), serial(2026, 10, 21), 30.5], [cnpjSintetico(2), serial(2026, 10, 21), 1234.565]));
    assert.equal(r.validas[0].valor, '30.50');
    assert.deepEqual(r.recusadas, [{ i: 1, motivo: 'VALOR_FRACAO_DE_CENTAVO' }]);
  });
  test('CNPJ numérico nativo de 14 dígitos é lido', () => {
    assert.equal(ler(comCabecalho([Number(cnpjSintetico(2)), serial(2026, 10, 21), 30])).validas[0].cnpj, cnpjSintetico(2));
  });
});

// P17: o revisor temia que um export SEM `<workbookPr date1904>` (Google Sheets/LibreOffice) fizesse TODA data
// numérica virar EPOCH_ILEGIVEL. MEDIDO: o SheetJS devolve `date1904:false` mesmo com o `<workbookPr>` REMOVIDO do
// workbook.xml — o ramo `null` só é alcançável por `interpretarLinhas` (testado acima). Este teste PRENDE a medição
// com um arquivo real adulterado (reempacotado com zlib); se o SheetJS mudar o default, ele reprova.
const zlib = require('node:zlib');
function semWorkbookPr(xlsx) {
  // lê o diretório central, descomprime cada entrada, remove <workbookPr/> e reempacota (CRC zerado: o leitor não o confere).
  const eocd = xlsx.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = xlsx.readUInt16LE(eocd + 10); let p = xlsx.readUInt32LE(eocd + 16);
  const entradas = [];
  for (let i = 0; i < n; i += 1) {
    const comp = xlsx.readUInt32LE(p + 20); const nomeLen = xlsx.readUInt16LE(p + 28);
    const extraLen = xlsx.readUInt16LE(p + 30); const comLen = xlsx.readUInt16LE(p + 32); const off = xlsx.readUInt32LE(p + 42);
    const nome = xlsx.subarray(p + 46, p + 46 + nomeLen).toString();
    const ini = off + 30 + xlsx.readUInt16LE(off + 26) + xlsx.readUInt16LE(off + 28);
    const metodo = xlsx.readUInt16LE(off + 8);
    let dados = metodo === 8 ? zlib.inflateRawSync(xlsx.subarray(ini, ini + comp)) : xlsx.subarray(ini, ini + comp);
    if (nome === 'xl/workbook.xml') dados = Buffer.from(dados.toString().replace(/<workbookPr[^>]*\/>/, ''));
    entradas.push({ nome, dados });
    p += 46 + nomeLen + extraLen + comLen;
  }
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
  const locais = []; const centrais = []; let offset = 0;
  for (const e of entradas) {
    const nome = Buffer.from(e.nome); const c = zlib.deflateRawSync(e.dados);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0), u32(0), u32(c.length), u32(e.dados.length), u16(nome.length), u16(0), nome, c]);
    centrais.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0), u32(0), u32(c.length), u32(e.dados.length), u16(nome.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nome]));
    locais.push(local); offset += local.length;
  }
  const dir = Buffer.concat(centrais);
  return Buffer.concat([...locais, dir, u32(0x06054b50), u16(0), u16(0), u16(entradas.length), u16(entradas.length), u32(dir.length), u32(offset), u16(0)]);
}
describe('workbook sem <workbookPr> (export de Sheets/LibreOffice)', () => {
  test('arquivo adulterado de verdade: data numérica é lida em 1900, nunca EPOCH_ILEGIVEL', () => {
    const base = xlsxDeAoa(comCabecalho([cnpjSintetico(1), serial(2026, 10, 21), 30]));
    const adulterado = semWorkbookPr(base);
    assert.notEqual(adulterado.length, base.length); // a adulteração aconteceu (o <workbookPr> saiu)
    const r = lerLancamentos(adulterado, { hoje: HOJE });
    assert.deepEqual(r.recusadas, []);
    assert.equal(r.validas[0].data, '2026-10-21');
    assert.equal(r.date1904, false);
  });
});

// A2: coluna "Geral" do Excel guarda 00.000.000/0001-92 como o número 192.
describe('CNPJ numérico com raiz iniciada em zero (A2)', () => {
  test('número 192 é recomposto para 00000000000192 e NÃO é CNPJ_INVALIDO', () => {
    const r = ler(comCabecalho([192, serial(2026, 10, 21), 30]));
    assert.deepEqual(r.recusadas, []);
    assert.equal(r.validas[0].cnpj, '00000000000192');
  });
  test('texto com máscara continua igual; número curto demais ainda não vira dado de outro CNPJ', () => {
    assert.equal(ler(comCabecalho(['00.000.000/0001-92', serial(2026, 10, 21), 30])).validas[0].cnpj, '00000000000192');
    assert.equal(ler(comCabecalho(['192', serial(2026, 10, 21), 30])).recusadas[0].motivo, 'CNPJ_INVALIDO');
  });
  // O ramo NUMÉRICO (typeof number) é o único que passa por padStart; '192' (string) vai pelo ramo de texto.
  // O gate conta DÍGITOS: notação científica (1e21 -> "1e+21") e inteiros com mais de 14 dígitos NÃO passam.
  test('célula NUMÉRICA: 1e21, 15 dígitos, fração e não-seguro são CNPJ_INVALIDO; 14 dígitos e curto (recomposto) seguem', () => {
    const m = (v) => ler(comCabecalho([v, serial(2026, 10, 21), 30])).recusadas.map((r) => r.motivo);
    assert.deepEqual(m(1e21), ['CNPJ_INVALIDO']);
    assert.deepEqual(m(123456789012345), ['CNPJ_INVALIDO']);
    assert.deepEqual(m(1.5), ['CNPJ_INVALIDO']);
    assert.deepEqual(m(2 ** 60), ['CNPJ_INVALIDO']);
    assert.deepEqual(m(Number(cnpjSintetico(2))), []);
    assert.deepEqual(m(192), []);
  });
});
