/**
 * Testes unitários — lib/hub-faturamento-dto.js (hub-faturamento/S6,
 * tasks.md 3.1.4/4.1.5). Rodam com: node --test tests/hub-faturamento-dto.test.js
 *
 * Cobre o mapper de lista (comEntregador derivado), parseFiltros (válidos/
 * inválidos/contraditório, default de 30 dias), parsePaginacao (limites/
 * defaults) e os mappers de resumo (cards/agregado, bucket agregados/bônus,
 * FR-003/FR-004/FR-012).
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  CHAVE_AGREGADOS_BONUS,
  ROTULO_AGREGADOS_BONUS,
  dataValida,
  parseFiltros,
  parsePaginacao,
  groupByValido,
  mapFaturamentoListItem,
  mapResumoCards,
  mapResumoAgrupado,
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

  test('lançamento agregado COM recebedor_agregado: nome exibido é o recebedor (ex.: franquia)', () => {
    const row = {
      id: 4, data_referencia: '2026-07-02', data_lancamento: '2026-07-03', data_repasse: '2026-07-08',
      descricao: 'Percentual atingido de hora online', valor: '2.88', entregador_id: null,
      entregador: null, recebedor_agregado: 'FRANQUIA_MOVEE_SP',
      subpraca: null, praca: 'SAO PAULO', periodo: 'JANTAR 18H30-22H29',
    };
    const item = mapFaturamentoListItem(row);
    assert.equal(item.comEntregador, false);
    assert.equal(item.entregadorId, null);
    assert.equal(item.entregadorNome, 'FRANQUIA_MOVEE_SP');
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

describe('groupByValido', () => {
  test('aceita exatamente dia/categoria/entregador', () => {
    assert.equal(groupByValido('dia'), true);
    assert.equal(groupByValido('categoria'), true);
    assert.equal(groupByValido('entregador'), true);
  });

  test('rejeita qualquer outro valor', () => {
    assert.equal(groupByValido('mes'), false);
    assert.equal(groupByValido(''), false);
    assert.equal(groupByValido(undefined), false);
    assert.equal(groupByValido('Dia'), false); // case-sensitive
  });
});

describe('mapResumoCards (FR-003/FR-012)', () => {
  test('mapeia total_geral/categoria_maior_valor/entregadores_distintos -> camelCase', () => {
    const r = mapResumoCards({ total_geral: '98135.40', categoria_maior_valor: 'Corridas concluidas', entregadores_distintos: 691 });
    assert.deepEqual(r, { totalGeral: '98135.40', categoriaMaiorValor: 'Corridas concluidas', entregadoresDistintos: 691 });
  });

  test('período sem dados (row undefined) -> shape zerado, nunca erro (FR-012)', () => {
    const r = mapResumoCards(undefined);
    assert.deepEqual(r, { totalGeral: '0.00', categoriaMaiorValor: null, entregadoresDistintos: 0 });
  });

  test('row com categoria_maior_valor null (RPC já retorna null quando vazio) é preservado', () => {
    const r = mapResumoCards({ total_geral: '0.00', categoria_maior_valor: null, entregadores_distintos: 0 });
    assert.equal(r.categoriaMaiorValor, null);
  });
});

describe('mapResumoAgrupado (FR-004/FR-005, Decision 4)', () => {
  test('groupBy=dia -> rotulo === chave (sem lookup)', () => {
    const rows = [{ chave: '2026-07-01', total: '150.00', quantidade: 3 }];
    const r = mapResumoAgrupado(rows, 'dia');
    assert.deepEqual(r, [{ chave: '2026-07-01', rotulo: '2026-07-01', total: '150.00', quantidade: 3 }]);
  });

  test('groupBy=categoria -> rotulo === chave (sem lookup)', () => {
    const rows = [{ chave: 'Corridas concluidas', total: '500.00', quantidade: 10 }];
    const r = mapResumoAgrupado(rows, 'categoria');
    assert.equal(r[0].rotulo, 'Corridas concluidas');
  });

  test('groupBy=entregador -> rotulo resolvido via nomeMap (join Entregador.nome)', () => {
    const rows = [{ chave: '42', total: '1250.00', quantidade: 18 }];
    const nomeMap = new Map([['42', 'F*** S***']]);
    const r = mapResumoAgrupado(rows, 'entregador', nomeMap);
    assert.deepEqual(r, [{ chave: '42', rotulo: 'F*** S***', total: '1250.00', quantidade: 18 }]);
  });

  test('groupBy=entregador, chave sem entrada no nomeMap -> rotulo cai para a própria chave (defensivo)', () => {
    const rows = [{ chave: '999', total: '10.00', quantidade: 1 }];
    const r = mapResumoAgrupado(rows, 'entregador', new Map());
    assert.equal(r[0].rotulo, '999');
  });

  test('bucket agregados_bonus -> rotulo literal "Agregados/bônus", SEMPRE (independente do nomeMap)', () => {
    const rows = [{ chave: CHAVE_AGREGADOS_BONUS, total: '3940.40', quantidade: 885 }];
    const r = mapResumoAgrupado(rows, 'entregador', new Map([[CHAVE_AGREGADOS_BONUS, 'nao deveria ser usado']]));
    assert.equal(r[0].rotulo, ROTULO_AGREGADOS_BONUS);
  });

  test('array vazio -> array vazio (período sem dados no agrupado)', () => {
    assert.deepEqual(mapResumoAgrupado([], 'dia'), []);
    assert.deepEqual(mapResumoAgrupado(undefined, 'dia'), []);
  });

  test('exemplo do contrato (faturamento-api.md): grupo com entregador + bucket bônus juntos', () => {
    const rows = [
      { chave: '42', total: '1250.00', quantidade: 18 },
      { chave: CHAVE_AGREGADOS_BONUS, total: '3940.40', quantidade: 885 },
    ];
    const nomeMap = new Map([['42', 'F*** S***']]);
    const r = mapResumoAgrupado(rows, 'entregador', nomeMap);
    assert.deepEqual(r, [
      { chave: '42', rotulo: 'F*** S***', total: '1250.00', quantidade: 18 },
      { chave: 'agregados_bonus', rotulo: 'Agregados/bônus', total: '3940.40', quantidade: 885 },
    ]);
  });
});
