'use strict';
/**
 * Rodada 5, C1/C2. O núcleo `xlsx-import-core` é compartilhado: o retorno da Transfeera (em produção desde
 * 30/09) TEM de se comportar como o HEAD; o lançamento externo (`areaReal`) lê a área real com colunas travadas.
 * Os valores esperados do bloco Transfeera foram MEDIDOS contra o leitor do HEAD (mesmos bytes) — as suítes
 * antigas da Transfeera passam com e sem a mudança, estas não.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { CABECALHO_ESPERADO: CAB, lerXlsx } = require('../lib/adiantamento-retorno-transfeera');
const { lerLancamentos, CABECALHO_ESPERADO: CAB_L } = require('../lib/lancamento-externo');
const { xlsxComDimensao } = require('./helpers/xlsx-sintetico');

const linha = (i) => CAB.map((n, k) => (n === 'Valor' ? '10.50' : n === 'Status' ? 'FINALIZADO' : n === 'ID integração' ? `ADI-${i}` : `x${k}`));
const dados = (n) => Array.from({ length: n }, (_, i) => linha(i));
const resultado = (buf) => { try { return `ok:${lerXlsx(buf).length}`; } catch (e) { return `erro:${e.motivo}`; } };
const celula = (col, r) => `<row r="${r}"><c r="${col}${r}" t="inlineStr"><is><t>nota</t></is></c></row>`;

describe('Transfeera: equivalência comportamental com o HEAD (areaReal desligado)', () => {
  test('<dimension> inflada A1:U20000 com 2 linhas reais -> RECUSA (HEAD recusava)', () => {
    assert.equal(resultado(xlsxComDimensao([CAB, ...dados(1)], 'A1:U20000')), 'erro:ARQUIVO_MUITO_GRANDE');
  });
  test('<dimension> A1:U3 com 50 linhas reais -> aceita 2 (HEAD só lia a declarada)', () => {
    assert.equal(resultado(xlsxComDimensao([CAB, ...dados(49)], 'A1:U3')), 'ok:2');
  });
  test('<dimension> A1:U1 com 5000 linhas reais -> ARQUIVO_VAZIO (HEAD)', () => {
    assert.equal(resultado(xlsxComDimensao([CAB, ...dados(4999)], 'A1:U1')), 'erro:ARQUIVO_VAZIO');
  });
  test('21 colunas + célula solta em V1 (dimension A1:U3) -> aceita 2, NÃO CABECALHO_INVALIDO', () => {
    assert.equal(resultado(xlsxComDimensao([[...CAB, 'nota'], ...dados(2)], 'A1:U3')), 'ok:2');
  });
  test('21 colunas + célula solta em V3 (dimension A1:U3) -> aceita 2', () => {
    assert.equal(resultado(xlsxComDimensao([CAB, dados(1)[0], [...linha(9), 'nota']], 'A1:U3')), 'ok:2');
  });
  test('célula solta abaixo dos dados fora da dimension -> não vira linha (aceita 2)', () => {
    assert.equal(resultado(xlsxComDimensao([CAB, ...dados(2)], 'A1:U3', celula('A', 4))), 'ok:2');
  });
  test('A1 + XFD1048576 continua recusado', () => {
    assert.equal(resultado(xlsxComDimensao([CAB, ...dados(1)], 'A1:XFD1048576', celula('XFD', 1048576))), 'erro:ARQUIVO_MUITO_GRANDE');
  });
});

describe('Lançamento externo (areaReal): linhas pela área real, colunas travadas no cabeçalho', () => {
  const cab = CAB_L;
  const ok = ['90000000001001', '2026-10-01', '10,50', 'Fulano', ''];
  const ler = (buf) => { try { return `ok:${lerLancamentos(buf, { hoje: '2026-10-22' }).validas.length}`; } catch (e) { return `erro:${e.motivo}`; } };

  test('célula solta longe (CU10002) é ignorada e é BARATA (< 300 ms; o HEAD custava 603 ms)', () => {
    const buf = xlsxComDimensao([cab, ok], 'A1:E2', celula('CU', 10002));
    const t0 = Date.now();
    assert.equal(ler(buf), 'ok:1');
    assert.ok(Date.now() - t0 < 300, `levou ${Date.now() - t0} ms`);
  });
  test('célula solta numa coluna fora do contrato, abaixo dos dados, NÃO cria linha de lixo', () => {
    assert.equal(ler(xlsxComDimensao([cab, ok], 'A1:E2', celula('H', 4))), 'ok:1');
  });
  test('ataque A1 + XFD1048576 recusado barato (< 100 ms)', () => {
    const t0 = Date.now();
    assert.equal(ler(xlsxComDimensao([cab, ok], 'A1:XFD1048576', celula('XFD', 1048576))), 'erro:ARQUIVO_MUITO_GRANDE');
    assert.ok(Date.now() - t0 < 100, `levou ${Date.now() - t0} ms`);
  });
  test('dimension MENOR que o real continua curada (A4: 50 linhas reais, A1:E3 declarada)', () => {
    const linhas = [cab, ...Array.from({ length: 49 }, (_, i) => ['9000000000' + String(1001 + i).padStart(4, '0'), '2026-10-01', '10,50', 'F', ''])];
    assert.equal(ler(xlsxComDimensao(linhas, 'A1:E3')), 'ok:49');
  });
  test('coluna a mais com texto no cabeçalho (F) segue recusada', () => {
    assert.equal(ler(xlsxComDimensao([[...cab, 'extra'], ok], 'A1:F2')), 'erro:CABECALHO_INVALIDO');
  });
});

describe('lerValor: mais de uma vírgula nunca vira valor (R5)', () => {
  test('"1,5,5" e "1,234,56" são VALOR_INVALIDO, não um número truncado', () => {
    const { xlsxDeAoa, comCabecalho } = require('./helpers/xlsx-sintetico');
    const r = lerLancamentos(xlsxDeAoa(comCabecalho(
      ['90000000001001', '2026-10-01', '1,5,5', 'F', ''], ['90000000000002', '2026-10-01', '1,234,56', 'F', ''],
    )), { hoje: '2026-10-22' });
    assert.deepEqual(r.recusadas.map((x) => x.motivo), ['VALOR_INVALIDO', 'VALOR_INVALIDO']);
  });
});
