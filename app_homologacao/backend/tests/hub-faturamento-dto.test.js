/**
 * Testes unitários — lib/hub-faturamento-dto.js (hub-faturamento/S6,
 * tasks.md 3.1.4). Rodam com: node --test tests/hub-faturamento-dto.test.js
 *
 * Cobre o mapper (comEntregador derivado), parseFiltros (válidos/inválidos/
 * contraditório, default de 30 dias) e parsePaginacao (limites/defaults).
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  dataValida,
  parseFiltros,
  parsePaginacao,
  mapFaturamentoListItem,
} = require('../lib/hub-faturamento-dto');

describe('mapFaturamentoListItem', () => {
  test('lançamento COM entregador: comEntregador=true, entregadorId/Nome preenchidos', () => {
    const row = {
      id: 1, data_referencia: '2026-07-01', data_lancamento: '2026-07-01', data_repasse: '2026-07-06',
      descricao: 'Corridas concluidas', valor: '61.50', entregador_id: 42,
      entregador: { nome: 'F*** S***' }, subpraca: 'SAO PAULO - ZONA SUL', praca: 'SAO PAULO',
      periodo: 'ALMOCO 11H30-15H29',
    };
    const item = mapFaturamentoListItem(row);
    assert.deepEqual(item, {
      id: 1, dataReferencia: '2026-07-01', dataLancamento: '2026-07-01', dataRepasse: '2026-07-06',
      categoria: 'Corridas concluidas', valor: '61.50', entregadorId: 42, entregadorNome: 'F*** S***',
      subpraca: 'SAO PAULO - ZONA SUL', praca: 'SAO PAULO', periodo: 'ALMOCO 11H30-15H29', comEntregador: true,
    });
  });

  test('lançamento agregado/bônus (entregador_id null): comEntregador=false, entregadorId/Nome null', () => {
    const row = {
      id: 2, data_referencia: '2026-07-01', data_lancamento: '2026-07-01', data_repasse: null,
      descricao: 'Bonus semanal', valor: '300.00', entregador_id: null, entregador: null,
      subpraca: 'CENTRO - SP', praca: 'SAO PAULO', periodo: null,
    };
    const item = mapFaturamentoListItem(row);
    assert.equal(item.comEntregador, false);
    assert.equal(item.entregadorId, null);
    assert.equal(item.entregadorNome, null);
  });

  test('valor sempre trafega como veio da PostgREST (string) — nunca convertido a number', () => {
    const row = {
      id: 3, data_referencia: '2026-07-01', data_lancamento: '2026-07-01', data_repasse: null,
      descricao: 'x', valor: '0.10', entregador_id: null, entregador: null,
      subpraca: null, praca: null, periodo: null,
    };
    const item = mapFaturamentoListItem(row);
    assert.equal(typeof item.valor, 'string');
    assert.equal(item.valor, '0.10');
  });
});

describe('dataValida', () => {
  test('datas reais válidas', () => {
    assert.equal(dataValida('2026-07-01'), true);
    assert.equal(dataValida('2024-02-29'), true); // ano bissexto
  });

  test('datas sintaticamente inválidas ou inexistentes', () => {
    assert.equal(dataValida('2026-13-01'), false);
    assert.equal(dataValida('2026-02-30'), false); // fevereiro não tem 30
    assert.equal(dataValida('2025-02-29'), false); // não bissexto
    assert.equal(dataValida('01-07-2026'), false);
    assert.equal(dataValida('não é data'), false);
    assert.equal(dataValida(''), false);
    assert.equal(dataValida(null), false);
    assert.equal(dataValida(undefined), false);
  });
});

describe('parseFiltros', () => {
  const AGORA_FIXO = () => new Date('2026-07-08T12:00:00.000Z');

  test('sem de/ate -> default últimos 30 dias (UTC)', () => {
    const r = parseFiltros({}, AGORA_FIXO);
    assert.equal(r.ok, true);
    assert.equal(r.ate, '2026-07-08');
    assert.equal(r.de, '2026-06-08');
  });

  test('de/ate informados e válidos são respeitados', () => {
    const r = parseFiltros({ de: '2026-01-01', ate: '2026-01-31' }, AGORA_FIXO);
    assert.equal(r.ok, true);
    assert.equal(r.de, '2026-01-01');
    assert.equal(r.ate, '2026-01-31');
  });

  test('só de informado -> ate usa default (hoje); só ate informado -> de usa default (30 dias antes)', () => {
    const r1 = parseFiltros({ de: '2026-01-01' }, AGORA_FIXO);
    assert.equal(r1.ok, true);
    assert.equal(r1.de, '2026-01-01');
    assert.equal(r1.ate, '2026-07-08');

    const r2 = parseFiltros({ ate: '2026-01-31' }, AGORA_FIXO);
    assert.equal(r2.ok, true);
    assert.equal(r2.ate, '2026-01-31');
    assert.equal(r2.de, '2026-06-08');
  });

  test('data inválida em de ou ate -> DATA_INVALIDA', () => {
    assert.deepEqual(parseFiltros({ de: '2026-02-30' }, AGORA_FIXO), { ok: false, erro: 'DATA_INVALIDA' });
    assert.deepEqual(parseFiltros({ ate: 'lixo' }, AGORA_FIXO), { ok: false, erro: 'DATA_INVALIDA' });
  });

  test('categoria/subpraca passam como string; ausentes -> null', () => {
    const r = parseFiltros({ categoria: 'Corridas', subpraca: 'ZONA SUL' }, AGORA_FIXO);
    assert.equal(r.categoria, 'Corridas');
    assert.equal(r.subpraca, 'ZONA SUL');
    const r2 = parseFiltros({}, AGORA_FIXO);
    assert.equal(r2.categoria, null);
    assert.equal(r2.subpraca, null);
  });

  test('entregadorId válido é parseado como inteiro; ausente -> null', () => {
    const r = parseFiltros({ entregadorId: '42' }, AGORA_FIXO);
    assert.equal(r.entregadorId, 42);
    const r2 = parseFiltros({}, AGORA_FIXO);
    assert.equal(r2.entregadorId, null);
  });

  test('entregadorId inválido (não numérico, zero, negativo) -> ENTREGADOR_ID_INVALIDO', () => {
    assert.deepEqual(parseFiltros({ entregadorId: 'abc' }, AGORA_FIXO), { ok: false, erro: 'ENTREGADOR_ID_INVALIDO' });
    assert.deepEqual(parseFiltros({ entregadorId: '0' }, AGORA_FIXO), { ok: false, erro: 'ENTREGADOR_ID_INVALIDO' });
    assert.deepEqual(parseFiltros({ entregadorId: '-1' }, AGORA_FIXO), { ok: false, erro: 'ENTREGADOR_ID_INVALIDO' });
  });

  test('comEntregador true/false parseados; qualquer outro valor -> null (sem filtro)', () => {
    assert.equal(parseFiltros({ comEntregador: 'true' }, AGORA_FIXO).comEntregador, true);
    assert.equal(parseFiltros({ comEntregador: 'false' }, AGORA_FIXO).comEntregador, false);
    assert.equal(parseFiltros({ comEntregador: 'xyz' }, AGORA_FIXO).comEntregador, null);
    assert.equal(parseFiltros({}, AGORA_FIXO).comEntregador, null);
  });

  test('entregadorId + comEntregador=false -> FILTRO_CONTRADITORIO', () => {
    assert.deepEqual(
      parseFiltros({ entregadorId: '42', comEntregador: 'false' }, AGORA_FIXO),
      { ok: false, erro: 'FILTRO_CONTRADITORIO' }
    );
  });

  test('entregadorId + comEntregador=true NÃO é contraditório (redundante, mas válido)', () => {
    const r = parseFiltros({ entregadorId: '42', comEntregador: 'true' }, AGORA_FIXO);
    assert.equal(r.ok, true);
    assert.equal(r.entregadorId, 42);
    assert.equal(r.comEntregador, true);
  });
});

describe('parsePaginacao', () => {
  test('default: page=1, pageSize default, from=0, to=pageSize-1', () => {
    const r = parsePaginacao({});
    assert.equal(r.page, 1);
    assert.equal(r.pageSize, PAGE_SIZE_DEFAULT);
    assert.equal(r.from, 0);
    assert.equal(r.to, PAGE_SIZE_DEFAULT - 1);
  });

  test('page/pageSize customizados', () => {
    const r = parsePaginacao({ page: '3', pageSize: '10' });
    assert.equal(r.page, 3);
    assert.equal(r.pageSize, 10);
    assert.equal(r.from, 20);
    assert.equal(r.to, 29);
  });

  test('pageSize acima do máximo é clampado', () => {
    const r = parsePaginacao({ pageSize: '500' });
    assert.equal(r.pageSize, PAGE_SIZE_MAX);
  });

  test('page/pageSize inválidos (não numérico, <1) caem no default', () => {
    const r = parsePaginacao({ page: '0', pageSize: 'abc' });
    assert.equal(r.page, 1);
    assert.equal(r.pageSize, PAGE_SIZE_DEFAULT);
  });
});
