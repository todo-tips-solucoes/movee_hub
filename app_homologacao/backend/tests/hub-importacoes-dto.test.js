/**
 * Testes unitários — lib/hub-importacoes-dto.js (tasks.md FASE 5, 5.1-5.3).
 * Rodam com: node --test tests/hub-importacoes-dto.test.js
 *
 * Cobre as funções PURAS (sem PostgREST/DB real): paginação Range,
 * janela padrão de 30 dias, mapeamento snake_case->camelCase (incl.
 * `aguardandoLock` derivado — dec-032/CHK013), e proteção CSV injection
 * (FR-016/CHK017 — 5.3.4).
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  parsePaginacao,
  parseJanelaPadrao,
  calcularDuracaoSegundos,
  mapImportacaoListItem,
  mapImportacaoDetalhe,
  mapErroItem,
  escaparCelulaCsvInjection,
  gerarCsvErros,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
} = require('../lib/hub-importacoes-dto');

describe('parsePaginacao', () => {
  test('default: page=1, pageSize default, from=0, to=pageSize-1', () => {
    const r = parsePaginacao({});
    assert.equal(r.page, 1);
    assert.equal(r.pageSize, PAGE_SIZE_DEFAULT);
    assert.equal(r.from, 0);
    assert.equal(r.to, PAGE_SIZE_DEFAULT - 1);
  });

  test('page=3, pageSize=10 -> from=20, to=29', () => {
    const r = parsePaginacao({ page: '3', pageSize: '10' });
    assert.equal(r.page, 3);
    assert.equal(r.pageSize, 10);
    assert.equal(r.from, 20);
    assert.equal(r.to, 29);
  });

  test('pageSize acima do máximo é clampado', () => {
    const r = parsePaginacao({ pageSize: '99999' });
    assert.equal(r.pageSize, PAGE_SIZE_MAX);
  });

  test('page/pageSize inválidos (não numéricos, negativos, zero) caem no default', () => {
    assert.equal(parsePaginacao({ page: 'abc' }).page, 1);
    assert.equal(parsePaginacao({ page: '-5' }).page, 1);
    assert.equal(parsePaginacao({ page: '0' }).page, 1);
    assert.equal(parsePaginacao({ pageSize: '0' }).pageSize, PAGE_SIZE_DEFAULT);
    assert.equal(parsePaginacao({ pageSize: '-1' }).pageSize, PAGE_SIZE_DEFAULT);
  });
});

describe('parseJanelaPadrao', () => {
  test('sem de/ate -> default 30 dias atrás até agora (ate=null, aplicado pelo caller)', () => {
    const agoraFixo = () => new Date('2026-07-07T12:00:00.000Z');
    const r = parseJanelaPadrao({}, agoraFixo);
    assert.equal(r.de, '2026-06-07T12:00:00.000Z');
    assert.equal(r.ate, null);
  });

  test('de informado, ate ausente -> respeita a intenção explícita', () => {
    const r = parseJanelaPadrao({ de: '2026-01-01' });
    assert.equal(r.de, '2026-01-01');
    assert.equal(r.ate, null);
  });

  test('ambos informados -> passthrough', () => {
    const r = parseJanelaPadrao({ de: '2026-01-01', ate: '2026-02-01' });
    assert.equal(r.de, '2026-01-01');
    assert.equal(r.ate, '2026-02-01');
  });
});

describe('calcularDuracaoSegundos', () => {
  test('ambas as pontas presentes -> diferença em segundos', () => {
    assert.equal(calcularDuracaoSegundos('2026-01-01T00:00:00Z', '2026-01-01T00:01:30Z'), 90);
  });

  test('faltando qualquer ponta -> null', () => {
    assert.equal(calcularDuracaoSegundos(null, '2026-01-01T00:01:30Z'), null);
    assert.equal(calcularDuracaoSegundos('2026-01-01T00:00:00Z', null), null);
  });

  test('concluido antes de iniciado (inconsistente) -> null', () => {
    assert.equal(calcularDuracaoSegundos('2026-01-01T01:00:00Z', '2026-01-01T00:00:00Z'), null);
  });
});

describe('mapImportacaoListItem — aguardandoLock (dec-032/CHK013)', () => {
  const rowBase = {
    id: 1, tipo: 'faturamento', status: 'pending', nome_arquivo: 'a.csv',
    total_linhas: null, linhas_validas: null, linhas_invalidas: null,
    data_referencia: null, criado_por: 7, iniciado_em: null, concluido_em: null,
  };

  test('pending SEM tipo ativo -> aguardandoLock=false (recém-criado)', () => {
    const r = mapImportacaoListItem(rowBase, new Set());
    assert.equal(r.aguardandoLock, false);
  });

  test('pending COM outro do mesmo tipo ativo -> aguardandoLock=true', () => {
    const r = mapImportacaoListItem(rowBase, new Set(['faturamento']));
    assert.equal(r.aguardandoLock, true);
  });

  test('status != pending -> aguardandoLock sempre false, mesmo com tipo ativo', () => {
    const r = mapImportacaoListItem({ ...rowBase, status: 'processing' }, new Set(['faturamento']));
    assert.equal(r.aguardandoLock, false);
  });

  test('mapeia todos os campos do contrato em camelCase', () => {
    const r = mapImportacaoListItem({
      ...rowBase,
      status: 'completed',
      total_linhas: 100,
      linhas_validas: 95,
      linhas_invalidas: 5,
      data_referencia: '2026-06-01',
      iniciado_em: '2026-06-01T00:00:00Z',
      concluido_em: '2026-06-01T00:02:00Z',
    }, new Set());
    assert.deepEqual(r, {
      id: 1,
      tipo: 'faturamento',
      status: 'completed',
      nomeArquivo: 'a.csv',
      totalLinhas: 100,
      linhasValidas: 95,
      linhasInvalidas: 5,
      dataReferencia: '2026-06-01',
      dataReferenciaFim: null,
      criadoPor: 7,
      iniciadoEm: '2026-06-01T00:00:00Z',
      concluidoEm: '2026-06-01T00:02:00Z',
      duracaoSegundos: 120,
      aguardandoLock: false,
    });
  });
});

describe('mapImportacaoDetalhe', () => {
  test('agrupa contadores + mantém erroResumo', () => {
    const r = mapImportacaoDetalhe({
      id: 5, tipo: 'performance', status: 'failed',
      total_linhas: 10, linhas_validas: 3, linhas_invalidas: 7,
      data_referencia: null, iniciado_em: '2026-01-01T00:00:00Z',
      concluido_em: '2026-01-01T00:00:05Z',
      erro_resumo: '7/10 linhas inválidas',
    });
    assert.deepEqual(r.contadores, { total: 10, validas: 3, invalidas: 7 });
    assert.equal(r.erroResumo, '7/10 linhas inválidas');
    assert.equal(r.duracaoSegundos, 5);
  });
});

describe('mapErroItem — nunca expõe campo bruto', () => {
  test('só expõe numeroLinha/campo/motivo/valorMascarado', () => {
    const r = mapErroItem({
      id: 1, importacao_id: 9, id_empresa: 1,
      numero_linha: 42, campo: 'cnpj', motivo: 'formato_invalido',
      valor_mascarado: '1*******9',
    });
    assert.deepEqual(r, { numeroLinha: 42, campo: 'cnpj', motivo: 'formato_invalido', valorMascarado: '1*******9' });
  });
});

describe('escaparCelulaCsvInjection (FR-016/CHK017)', () => {
  test('prefixa aspas simples em células iniciadas por = + - @', () => {
    assert.equal(escaparCelulaCsvInjection('=1+1'), "'=1+1");
    assert.equal(escaparCelulaCsvInjection('+1+1'), "'+1+1");
    assert.equal(escaparCelulaCsvInjection('-1+1'), "'-1+1");
    assert.equal(escaparCelulaCsvInjection('@SUM(A1)'), "'@SUM(A1)");
  });

  test('células normais passam intactas', () => {
    assert.equal(escaparCelulaCsvInjection('cnpj'), 'cnpj');
    assert.equal(escaparCelulaCsvInjection('formato_invalido'), 'formato_invalido');
  });

  test('null/undefined/vazio -> string vazia, sem lançar', () => {
    assert.equal(escaparCelulaCsvInjection(null), '');
    assert.equal(escaparCelulaCsvInjection(undefined), '');
    assert.equal(escaparCelulaCsvInjection(''), '');
  });
});

describe('gerarCsvErros — 5.3.4 (célula maliciosa recebe prefixo no CSV)', () => {
  test('célula =1+1 em valorMascarado vira \'=1+1 no CSV, cabeçalho fixo, CRLF', () => {
    const csv = gerarCsvErros([
      { numeroLinha: 1, campo: 'valor', motivo: 'formato', valorMascarado: '=1+1' },
    ]);
    const linhas = csv.split('\r\n');
    assert.equal(linhas[0], 'numeroLinha,campo,motivo,valorMascarado');
    assert.equal(linhas[1], "1,valor,formato,'=1+1");
    assert.equal(linhas[2], '');
  });

  test('JSON (mapErroItem) nunca contém UUID/nome bruto — só valorMascarado', () => {
    const item = mapErroItem({
      numero_linha: 1, campo: 'id_externo', motivo: 'uuid_invalido',
      valor_mascarado: 'a***********************************z',
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(item, 'valor_bruto'));
    assert.ok(!Object.prototype.hasOwnProperty.call(item, 'valorBruto'));
    assert.equal(Object.keys(item).length, 4);
  });

  test('vírgula/aspas na célula são quotadas (RFC 4180), sem quebrar o CSV', () => {
    const csv = gerarCsvErros([
      { numeroLinha: 2, campo: 'nome', motivo: 'contém, vírgula', valorMascarado: 'a"b' },
    ]);
    assert.match(csv, /"contém, vírgula"/);
    assert.match(csv, /"a""b"/);
  });
});
