/**
 * Testes unitários — lib/hub-motoristas-dto.js (tasks.md FASE 3, 3.1.5).
 * Rodam com: node --test tests/hub-motoristas-dto.test.js
 *
 * Cobre as funções PURAS (sem PostgREST/DB real): paginação, normalização
 * de acento/caixa, filtro de nome/área, agrupamento de áreas por
 * entregador, mapeamento de item de lista e de detalhe, e TODOS os casos
 * de máscara de CNPJ (contracts/motoristas-api.md §Mascaramento de CNPJ).
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  parsePaginacao,
  normalizarNome,
  nomeCasa,
  areaCasa,
  agruparAreasPorEntregador,
  mapMotoristaListItem,
  mapMotoristaDetalhe,
  mascararCnpj,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
} = require('../lib/hub-motoristas-dto');

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

  test('pageSize acima do máximo (100) é clampado', () => {
    const r = parsePaginacao({ pageSize: '99999' });
    assert.equal(r.pageSize, PAGE_SIZE_MAX);
  });

  test('page < 1 ou não numérico -> 1', () => {
    assert.equal(parsePaginacao({ page: '0' }).page, 1);
    assert.equal(parsePaginacao({ page: '-5' }).page, 1);
    assert.equal(parsePaginacao({ page: 'abc' }).page, 1);
  });

  test('pageSize não numérico -> default', () => {
    assert.equal(parsePaginacao({ pageSize: 'xyz' }).pageSize, PAGE_SIZE_DEFAULT);
  });
});

describe('normalizarNome — tolerância a acento/caixa', () => {
  test('remove acentos comuns (á, ã, ç, é, ô, í, ú)', () => {
    assert.equal(normalizarNome('José'), 'jose');
    assert.equal(normalizarNome('João Ção'), 'joao cao');
    assert.equal(normalizarNome('Área Única'), 'area unica');
    assert.equal(normalizarNome('Zoé Ibañez'), 'zoe ibanez');
  });

  test('lowercase', () => {
    assert.equal(normalizarNome('FULANO DA SILVA'), 'fulano da silva');
  });

  test('null/undefined -> string vazia', () => {
    assert.equal(normalizarNome(null), '');
    assert.equal(normalizarNome(undefined), '');
  });

  test('trim de espaços nas pontas', () => {
    assert.equal(normalizarNome('  Fulano  '), 'fulano');
  });
});

describe('nomeCasa — busca parcial tolerante a acento', () => {
  test('termo sem acento casa nome COM acento (prova de tolerância)', () => {
    assert.equal(nomeCasa('jose', 'José da Silva'), true);
    assert.equal(nomeCasa('joao', 'João Ção'), true);
  });

  test('termo COM acento casa nome sem acento', () => {
    assert.equal(nomeCasa('josé', 'jose da silva'), true);
  });

  test('caixa diferente casa', () => {
    assert.equal(nomeCasa('FULANO', 'fulano da silva'), true);
  });

  test('substring que não existe não casa', () => {
    assert.equal(nomeCasa('carlos', 'José da Silva'), false);
  });

  test('termo vazio/ausente casa tudo', () => {
    assert.equal(nomeCasa('', 'qualquer nome'), true);
    assert.equal(nomeCasa(undefined, 'qualquer nome'), true);
    assert.equal(nomeCasa(null, 'qualquer nome'), true);
  });
});

describe('areaCasa — qualquer área distinta corresponde', () => {
  const areas = [{ subpraca: 'Zona Sul' }, { subpraca: 'Centro' }];

  test('área presente na lista (normalizada) casa', () => {
    assert.equal(areaCasa('zona sul', areas), true);
    assert.equal(areaCasa('CENTRO', areas), true);
  });

  test('área ausente não casa', () => {
    assert.equal(areaCasa('Zona Norte', areas), false);
  });

  test('área vazia/ausente casa tudo', () => {
    assert.equal(areaCasa('', areas), true);
    assert.equal(areaCasa(undefined, areas), true);
  });

  test('lista de áreas vazia nunca casa (exceto termo vazio)', () => {
    assert.equal(areaCasa('Centro', []), false);
    assert.equal(areaCasa('', []), true);
  });
});

describe('agruparAreasPorEntregador', () => {
  test('agrupa por entregador_id e ordena por dataMaisRecente DESC', () => {
    const linhas = [
      { entregador_id: 1, subpraca: 'Centro', data_mais_recente: '2026-05-14' },
      { entregador_id: 1, subpraca: 'Zona Sul', data_mais_recente: '2026-07-01' },
      { entregador_id: 2, subpraca: 'Norte', data_mais_recente: '2026-01-01' },
    ];
    const mapa = agruparAreasPorEntregador(linhas);
    assert.deepEqual(mapa.get(1), [
      { subpraca: 'Zona Sul', dataMaisRecente: '2026-07-01' },
      { subpraca: 'Centro', dataMaisRecente: '2026-05-14' },
    ]);
    assert.deepEqual(mapa.get(2), [{ subpraca: 'Norte', dataMaisRecente: '2026-01-01' }]);
  });

  test('entrada vazia/nula -> mapa vazio', () => {
    assert.equal(agruparAreasPorEntregador([]).size, 0);
    assert.equal(agruparAreasPorEntregador(null).size, 0);
  });
});

describe('mapMotoristaListItem', () => {
  test('mapeia comVinculo=true quando motorista_id presente', () => {
    const item = mapMotoristaListItem(
      { id: 1, nome: 'Fulano', ativo: true, motorista_id: 7 },
      [{ subpraca: 'Zona Sul', dataMaisRecente: '2026-07-01' }]
    );
    assert.deepEqual(item, { id: 1, nome: 'Fulano', ativo: true, comVinculo: true, areas: ['Zona Sul'] });
  });

  test('mapeia comVinculo=false quando motorista_id null', () => {
    const item = mapMotoristaListItem({ id: 2, nome: 'Ciclano', ativo: false, motorista_id: null }, []);
    assert.deepEqual(item, { id: 2, nome: 'Ciclano', ativo: false, comVinculo: false, areas: [] });
  });

  test('areas default para [] quando não informado', () => {
    const item = mapMotoristaListItem({ id: 3, nome: 'X', ativo: true, motorista_id: null });
    assert.deepEqual(item.areas, []);
  });
});

describe('mapMotoristaDetalhe', () => {
  test('vinculo presente -> objeto com cnpjPrestadorMascarado', () => {
    const row = {
      id: 1,
      nome: 'Fulano da Silva',
      ativo: true,
      nome_editado_manualmente: false,
      ContaMotorista: { id: 7, nome: 'Fulano da Silva', cnpj_prestador: '12345678000195' },
    };
    const areas = [{ subpraca: 'Zona Sul', dataMaisRecente: '2026-07-01' }];
    const resumo = { totalFaturamento: 42, totalPerformance: 30, dataMaisRecente: '2026-07-01' };
    const detalhe = mapMotoristaDetalhe(row, areas, resumo);
    assert.deepEqual(detalhe, {
      id: 1,
      nome: 'Fulano da Silva',
      ativo: true,
      nomeEditadoManualmente: false,
      areas: [{ subpraca: 'Zona Sul', dataMaisRecente: '2026-07-01' }],
      resumo: { totalFaturamento: 42, totalPerformance: 30, dataMaisRecente: '2026-07-01' },
      vinculo: { contaMotoristaId: 7, nome: 'Fulano da Silva', cnpjPrestadorMascarado: '12.***.***/0001-**' },
    });
  });

  test('vinculo ausente -> null, sem erro', () => {
    const row = { id: 2, nome: 'Ciclano', ativo: true, nome_editado_manualmente: true, ContaMotorista: null };
    const detalhe = mapMotoristaDetalhe(row, [], { totalFaturamento: 0, totalPerformance: 0, dataMaisRecente: null });
    assert.equal(detalhe.vinculo, null);
    assert.equal(detalhe.nomeEditadoManualmente, true);
  });

  test('sem histórico de importação -> resumo zerado, areas vazio, sem erro', () => {
    const row = { id: 3, nome: 'Sem Historico', ativo: true, nome_editado_manualmente: false, ContaMotorista: null };
    const detalhe = mapMotoristaDetalhe(row, [], { totalFaturamento: 0, totalPerformance: 0, dataMaisRecente: null });
    assert.deepEqual(detalhe.resumo, { totalFaturamento: 0, totalPerformance: 0, dataMaisRecente: null });
    assert.deepEqual(detalhe.areas, []);
  });

  test('resumo undefined -> defaults zerados (nunca lança)', () => {
    const row = { id: 4, nome: 'X', ativo: true, nome_editado_manualmente: false, ContaMotorista: null };
    const detalhe = mapMotoristaDetalhe(row, [], undefined);
    assert.deepEqual(detalhe.resumo, { totalFaturamento: 0, totalPerformance: 0, dataMaisRecente: null });
  });
});

describe('mascararCnpj — LGPD, formato NN.***.***/NNNN-**', () => {
  test('14 dígitos puros', () => {
    assert.equal(mascararCnpj('12345678000195'), '12.***.***/0001-**');
  });

  test('CNPJ com pontuação (normaliza para dígitos antes de fatiar)', () => {
    assert.equal(mascararCnpj('12.345.678/0001-95'), '12.***.***/0001-**');
  });

  test('outro CNPJ formatado — confere prefixo/bloco distintos', () => {
    assert.equal(mascararCnpj('98.765.432/0003-21'), '98.***.***/0003-**');
  });

  test('entrada inválida/curta não quebra — retorna null', () => {
    assert.equal(mascararCnpj('123'), null);
    assert.equal(mascararCnpj(''), null);
    assert.equal(mascararCnpj('12345678'), null);
  });

  test('entrada null/undefined -> null, nunca lança', () => {
    assert.equal(mascararCnpj(null), null);
    assert.equal(mascararCnpj(undefined), null);
  });

  test('entrada com dígitos além de 14 (inválida) -> null', () => {
    assert.equal(mascararCnpj('123456780001955555'), null);
  });
});
