/**
 * Testes unitários — lib/hub-performance-dto.js (hub-performance/S7,
 * tasks.md 2.1.4). Rodam com: node --test tests/hub-performance-dto.test.js
 *
 * Cobre o mapper de lista (entregadorId/entregadorNome SEMPRE presentes —
 * Decision 4, sem bucket "sem entregador"), parseFiltros (válidos/
 * inválidos, default de 30 dias, de > ate), parsePaginacao (limites/
 * defaults) e os mappers de resumo (cards/agregado, FR-003/FR-004/FR-011).
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
  parseGrao,
  chaveTurno,
  mapPerformanceTurnoItem,
  mapPerformanceListItem,
  formatarTaxasReais,
  groupByValido,
  mapResumoCards,
  mapResumoAgrupado,
} = require('../lib/hub-performance-dto');

describe('mapPerformanceListItem', () => {
  test('mapeia turno completo — entregadorId/Nome sempre presentes (Decision 4)', () => {
    const row = {
      id: 12345, data_periodo: '2026-06-15', periodo: 'ALMOCO 11H30-15H29',
      entregador_id: 42, entregador: { nome: 'F*** S***' }, subpraca: 'PINHEIROS', praca: 'SAO PAULO',
      corridas_ofertadas: 18, corridas_aceitas: 15, corridas_rejeitadas: 3,
      corridas_completadas: 14, corridas_canceladas: 1, pedidos_concluidos: 20,
      tempo_disponivel_periodo_pct: 92.5, taxas_centavos: 1234,
    };
    const item = mapPerformanceListItem(row);
    assert.deepEqual(item, {
      id: 12345, dataPeriodo: '2026-06-15', periodo: 'ALMOCO 11H30-15H29',
      entregadorId: 42, entregadorNome: 'F*** S***', subpraca: 'PINHEIROS', praca: 'SAO PAULO',
      corridasOfertadas: 18, corridasAceitas: 15, corridasRejeitadas: 3,
      corridasCompletadas: 14, corridasCanceladas: 1, pedidosConcluidos: 20,
      tempoDisponivelPct: 92.5, taxas: '12.34',
    });
  });

  test('tempoDisponivelPct null (ausente na linha) -> null (nunca 0)', () => {
    const row = {
      id: 1, data_periodo: '2026-06-15', periodo: 'x', entregador_id: 1,
      entregador: { nome: 'A' }, subpraca: null, praca: null,
      corridas_ofertadas: 0, corridas_aceitas: 0, corridas_rejeitadas: 0,
      corridas_completadas: 0, corridas_canceladas: 0, pedidos_concluidos: null,
      tempo_disponivel_periodo_pct: null, taxas_centavos: null,
    };
    const item = mapPerformanceListItem(row);
    assert.equal(item.tempoDisponivelPct, null);
    assert.equal(item.taxas, '0.00');
  });

  test('entregador join ausente (defensivo) -> entregadorNome null, entregadorId preservado', () => {
    const row = {
      id: 1, data_periodo: '2026-06-15', periodo: 'x', entregador_id: 7,
      entregador: null, subpraca: null, praca: null,
      corridas_ofertadas: 1, corridas_aceitas: 1, corridas_rejeitadas: 0,
      corridas_completadas: 1, corridas_canceladas: 0, pedidos_concluidos: 1,
      tempo_disponivel_periodo_pct: 50, taxas_centavos: 0,
    };
    const item = mapPerformanceListItem(row);
    assert.equal(item.entregadorId, 7);
    assert.equal(item.entregadorNome, null);
  });
});

describe('formatarTaxasReais', () => {
  test('centavos -> reais com 2 casas fixas', () => {
    assert.equal(formatarTaxasReais(13254), '132.54');
    assert.equal(formatarTaxasReais(1), '0.01');
  });

  test('null/undefined -> "0.00" (nunca "0")', () => {
    assert.equal(formatarTaxasReais(null), '0.00');
    assert.equal(formatarTaxasReais(undefined), '0.00');
    assert.equal(formatarTaxasReais(0), '0.00');
  });
});

describe('dataValida', () => {
  test('datas reais válidas', () => {
    assert.equal(dataValida('2026-07-01'), true);
    assert.equal(dataValida('2024-02-29'), true); // ano bissexto
  });

  test('datas sintaticamente inválidas ou inexistentes', () => {
    assert.equal(dataValida('2026-13-01'), false);
    assert.equal(dataValida('2026-02-30'), false);
    assert.equal(dataValida('2025-02-29'), false);
    assert.equal(dataValida('01-07-2026'), false);
    assert.equal(dataValida('não é data'), false);
    assert.equal(dataValida(''), false);
    assert.equal(dataValida(null), false);
    assert.equal(dataValida(undefined), false);
  });
});

describe('parseFiltros', () => {
  const AGORA_FIXO = () => new Date('2026-07-08T12:00:00.000Z');

  test('sem de/ate -> default últimos 30 dias (UTC), filtro sobre data_periodo (Cenário 5)', () => {
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

  test('só de informado -> ate usa default (hoje)', () => {
    const r1 = parseFiltros({ de: '2026-01-01' }, AGORA_FIXO);
    assert.equal(r1.ok, true);
    assert.equal(r1.de, '2026-01-01');
    assert.equal(r1.ate, '2026-07-08');
  });

  test('só ate informado (recente) -> de usa default fixo (hoje - 30 dias, contrato)', () => {
    const r2 = parseFiltros({ ate: '2026-07-05' }, AGORA_FIXO);
    assert.equal(r2.ok, true);
    assert.equal(r2.ate, '2026-07-05');
    assert.equal(r2.de, '2026-06-08');
  });

  test('só ate informado (distante no passado) -> default fixo de "hoje-30" excede ate -> DATA_INVALIDA (task 2.1.2)', () => {
    // Contrato define default de `de` como "hoje - 30 dias" (fixo, não
    // relativo a `ate`) — se o `ate` explícito for anterior a esse
    // default fixo, a combinação vira de > ate, corretamente rejeitada.
    assert.deepEqual(
      parseFiltros({ ate: '2026-01-31' }, AGORA_FIXO),
      { ok: false, erro: 'DATA_INVALIDA' }
    );
  });

  test('data inválida em de ou ate -> DATA_INVALIDA', () => {
    assert.deepEqual(parseFiltros({ de: '2026-02-30' }, AGORA_FIXO), { ok: false, erro: 'DATA_INVALIDA' });
    assert.deepEqual(parseFiltros({ ate: 'lixo' }, AGORA_FIXO), { ok: false, erro: 'DATA_INVALIDA' });
  });

  test('de > ate -> DATA_INVALIDA (task 2.1.2)', () => {
    assert.deepEqual(
      parseFiltros({ de: '2026-07-10', ate: '2026-07-01' }, AGORA_FIXO),
      { ok: false, erro: 'DATA_INVALIDA' }
    );
  });

  test('de === ate é válido (janela de 1 dia)', () => {
    const r = parseFiltros({ de: '2026-07-01', ate: '2026-07-01' }, AGORA_FIXO);
    assert.equal(r.ok, true);
  });

  test('periodo/subpraca passam como string; ausentes -> null', () => {
    const r = parseFiltros({ periodo: 'ALMOCO 11H30-15H29', subpraca: 'PINHEIROS' }, AGORA_FIXO);
    assert.equal(r.periodo, 'ALMOCO 11H30-15H29');
    assert.equal(r.subpraca, 'PINHEIROS');
    const r2 = parseFiltros({}, AGORA_FIXO);
    assert.equal(r2.periodo, null);
    assert.equal(r2.subpraca, null);
  });

  test('periodo aceita valor fora dos 16 turnos documentados (Edge Case — texto livre)', () => {
    const r = parseFiltros({ periodo: 'TURNO_INEXISTENTE_XYZ' }, AGORA_FIXO);
    assert.equal(r.ok, true);
    assert.equal(r.periodo, 'TURNO_INEXISTENTE_XYZ');
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

describe('groupByValido (Decision 12 — periodo, não turno)', () => {
  test('aceita exatamente dia/periodo/entregador', () => {
    assert.equal(groupByValido('dia'), true);
    assert.equal(groupByValido('periodo'), true);
    assert.equal(groupByValido('entregador'), true);
  });

  test('rejeita qualquer outro valor, incluindo "turno"', () => {
    assert.equal(groupByValido('turno'), false);
    assert.equal(groupByValido('mes'), false);
    assert.equal(groupByValido(''), false);
    assert.equal(groupByValido(undefined), false);
    assert.equal(groupByValido('Dia'), false); // case-sensitive
  });
});

describe('mapResumoCards (FR-003/FR-011/SC-009)', () => {
  test('mapeia os 5 campos da RPC hub_performance_totais -> camelCase', () => {
    const r = mapResumoCards({
      corridas_completadas: 1842, taxa_aceitacao: '0.8333', taxa_conclusao: '0.9333',
      tempo_disponivel_medio: '87.42', taxas_reais: '9821.40',
    });
    assert.deepEqual(r, {
      corridasCompletadas: 1842, taxaAceitacao: '0.8333', taxaConclusao: '0.9333',
      tempoDisponivelMedio: '87.42', taxasReais: '9821.40',
    });
  });

  test('período sem dados (row undefined) -> shape zerado, nunca erro (FR-011)', () => {
    const r = mapResumoCards(undefined);
    assert.deepEqual(r, {
      corridasCompletadas: 0, taxaAceitacao: null, taxaConclusao: null,
      tempoDisponivelMedio: null, taxasReais: '0.00',
    });
  });

  test('divisão por zero (RPC já retorna null) é preservada, nunca 0/1 (SC-009)', () => {
    const r = mapResumoCards({
      corridas_completadas: 0, taxa_aceitacao: null, taxa_conclusao: null,
      tempo_disponivel_medio: null, taxas_reais: '0.00',
    });
    assert.equal(r.taxaAceitacao, null);
    assert.equal(r.taxaConclusao, null);
    assert.equal(r.tempoDisponivelMedio, null);
  });
});

describe('mapResumoAgrupado (FR-004, Decision 4 — sem bucket agregados)', () => {
  test('groupBy=dia -> rotulo === chave (sem lookup)', () => {
    const rows = [{
      chave: '2026-07-01', quantidade: 3, corridas_completadas: 14,
      taxa_aceitacao: '0.9000', taxa_conclusao: '0.9500', tempo_disponivel_medio: '80.00', taxas_reais: '150.00',
    }];
    const r = mapResumoAgrupado(rows, 'dia');
    assert.deepEqual(r, [{
      chave: '2026-07-01', rotulo: '2026-07-01', quantidade: 3, corridasCompletadas: 14,
      taxaAceitacao: '0.9000', taxaConclusao: '0.9500', tempoDisponivelMedio: '80.00', taxasReais: '150.00',
    }]);
  });

  test('groupBy=periodo -> rotulo === chave, incluindo valor fora dos 16 turnos documentados', () => {
    const rows = [{
      chave: 'TURNO_INEXISTENTE_XYZ', quantidade: 1, corridas_completadas: 1,
      taxa_aceitacao: '1.0000', taxa_conclusao: '1.0000', tempo_disponivel_medio: '100.00', taxas_reais: '0.00',
    }];
    const r = mapResumoAgrupado(rows, 'periodo');
    assert.equal(r[0].rotulo, 'TURNO_INEXISTENTE_XYZ');
  });

  test('groupBy=entregador -> rotulo resolvido via nomeMap (join Entregador.nome)', () => {
    const rows = [{
      chave: '42', quantidade: 6, corridas_completadas: 84,
      taxa_aceitacao: '0.9000', taxa_conclusao: '0.9524', tempo_disponivel_medio: '91.10', taxas_reais: '612.40',
    }];
    const nomeMap = new Map([['42', 'F*** S***']]);
    const r = mapResumoAgrupado(rows, 'entregador', nomeMap);
    assert.equal(r[0].rotulo, 'F*** S***');
    assert.equal(r[0].chave, '42');
  });

  test('groupBy=entregador, chave sem entrada no nomeMap -> rotulo cai para a própria chave (defensivo)', () => {
    const rows = [{
      chave: '999', quantidade: 1, corridas_completadas: 1,
      taxa_aceitacao: null, taxa_conclusao: null, tempo_disponivel_medio: null, taxas_reais: '0.00',
    }];
    const r = mapResumoAgrupado(rows, 'entregador', new Map());
    assert.equal(r[0].rotulo, '999');
  });

  test('array vazio -> array vazio (período sem dados no agrupado)', () => {
    assert.deepEqual(mapResumoAgrupado([], 'dia'), []);
    assert.deepEqual(mapResumoAgrupado(undefined, 'dia'), []);
  });

  test('soma de corridasCompletadas dos grupos bate com o total (verificação preparatória p/ task 3.1.5)', () => {
    const rows = [
      { chave: '104', quantidade: 1, corridas_completadas: 7, taxa_aceitacao: '0.8000', taxa_conclusao: '0.8750', tempo_disponivel_medio: '80.00', taxas_reais: '10.00' },
      { chave: '105', quantidade: 1, corridas_completadas: 9, taxa_aceitacao: '0.9000', taxa_conclusao: '1.0000', tempo_disponivel_medio: '90.00', taxas_reais: '20.00' },
      { chave: '106', quantidade: 1, corridas_completadas: 6, taxa_aceitacao: '0.7000', taxa_conclusao: '0.8571', tempo_disponivel_medio: '70.00', taxas_reais: '0.00' },
    ];
    const r = mapResumoAgrupado(rows, 'entregador', new Map());
    const somaCompletadas = r.reduce((acc, g) => acc + g.corridasCompletadas, 0);
    assert.equal(somaCompletadas, 22);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Grão do TURNO (migration 0051, docs/plans/performance-linha-por-turno.md)
// ────────────────────────────────────────────────────────────────────────────

describe('parseGrao', () => {
  test('ausente/vazio -> turno (o padrão da tela)', () => {
    assert.equal(parseGrao({}), 'turno');
    assert.equal(parseGrao({ grao: '' }), 'turno');
    assert.equal(parseGrao(undefined), 'turno');
  });

  test('valores aceitos passam intactos', () => {
    assert.equal(parseGrao({ grao: 'turno' }), 'turno');
    assert.equal(parseGrao({ grao: 'linha' }), 'linha');
  });

  test('valor desconhecido -> null (a rota devolve 400 GRAO_INVALIDO)', () => {
    // Não cai no padrão silenciosamente: `?grao=Turno` respondido como se
    // fosse `turno` esconde um erro de quem chama, e `?grao=praca` devolveria
    // outro grão sem avisar.
    assert.equal(parseGrao({ grao: 'praca' }), null);
    assert.equal(parseGrao({ grao: 'Turno' }), null);
    assert.equal(parseGrao({ grao: '1' }), null);
  });
});

describe('chaveTurno', () => {
  test('identifica o turno pela tupla (entregador, dia, período)', () => {
    assert.equal(
      chaveTurno({ entregador_id: 7, data_periodo: '2026-08-10', periodo: 'ALMOCO 11H30-15H29' }),
      '7|2026-08-10|ALMOCO 11H30-15H29'
    );
  });

  test('turnos diferentes do mesmo dia não colidem', () => {
    const base = { entregador_id: 7, data_periodo: '2026-08-10' };
    assert.notEqual(
      chaveTurno({ ...base, periodo: 'ALMOCO' }),
      chaveTurno({ ...base, periodo: 'JANTAR' })
    );
  });
});

describe('mapPerformanceTurnoItem', () => {
  // Turno real do hub-homolog (seed `DEMO 0050 Duas Pracas`, 2026-08-10):
  // duas praças, 25,00% + 12,50% de tempo de período -> 37,50% no turno.
  const linhaRpc = {
    entregador_id: 42,
    entregador_nome: 'DEMO 0050 Duas Pracas',
    data_periodo: '2026-08-10',
    periodo: 'ALMOCO 11H30-15H29',
    praca: 'SAO PAULO',
    corridas_ofertadas: 12,
    corridas_aceitas: 8,
    corridas_rejeitadas: 4,
    corridas_completadas: 7,
    corridas_canceladas: 0,
    pedidos_concluidos: 7,
    taxas_centavos: 2000,
    tempo_disponivel_periodo_pct: '37.50',
    total_turnos: 4,
    pracas: [
      {
        subpraca: 'ZONA SUL', praca: 'SAO PAULO', tempoDisponivelPct: 25,
        corridasOfertadas: 8, corridasAceitas: 6, corridasCompletadas: 5, taxasCentavos: 1500,
      },
      {
        subpraca: 'CENTRO', praca: 'SAO PAULO', tempoDisponivelPct: 12.5,
        corridasOfertadas: 4, corridasAceitas: 2, corridasCompletadas: 2, taxasCentavos: 500,
      },
    ],
  };

  test('mapeia o turno inteiro, com as praças como detalhe', () => {
    const item = mapPerformanceTurnoItem(linhaRpc);
    assert.equal(item.chave, '42|2026-08-10|ALMOCO 11H30-15H29');
    assert.equal(item.entregadorNome, 'DEMO 0050 Duas Pracas');
    assert.equal(item.praca, 'SAO PAULO');
    assert.equal(item.corridasOfertadas, 12);
    assert.equal(item.corridasRejeitadas, 4);
    assert.equal(item.pedidosConcluidos, 7);
    assert.equal(item.tempoDisponivelPct, 37.5);
    assert.equal(item.taxas, '20.00');
    assert.equal(item.pracas.length, 2);
    assert.equal(item.pracas[0].subpraca, 'ZONA SUL');
    assert.equal(item.pracas[0].tempoDisponivelPct, 25);
    assert.equal(item.pracas[1].taxas, '5.00');
  });

  test('as praças somam o tempo do turno — é o que torna o veredito único honesto', () => {
    const item = mapPerformanceTurnoItem(linhaRpc);
    const soma = item.pracas.reduce((acc, p) => acc + (p.tempoDisponivelPct ?? 0), 0);
    assert.equal(soma, item.tempoDisponivelPct);
  });

  test('turno SEM leitura: tempo/pedidos ficam null, nunca 0 nem 100 (SC-009)', () => {
    // A armadilha do `LEAST` que ignora NULL (0050/0051): ausência de leitura
    // virando nota máxima é o pior resultado possível.
    const item = mapPerformanceTurnoItem({
      ...linhaRpc,
      tempo_disponivel_periodo_pct: null,
      pedidos_concluidos: null,
      taxas_centavos: null,
      pracas: [{ subpraca: 'ZONA SUL', praca: 'SAO PAULO', tempoDisponivelPct: null }],
    });
    assert.equal(item.tempoDisponivelPct, null);
    assert.equal(item.pedidosConcluidos, null);
    assert.equal(item.taxas, '0.00');
    assert.equal(item.pracas[0].tempoDisponivelPct, null);
    assert.equal(item.pracas[0].corridasOfertadas, 0);
  });

  test('`pracas` ausente/não-array vira lista vazia, não quebra a linha', () => {
    assert.deepEqual(mapPerformanceTurnoItem({ ...linhaRpc, pracas: null }).pracas, []);
    assert.deepEqual(mapPerformanceTurnoItem({ ...linhaRpc, pracas: undefined }).pracas, []);
  });

  test('contadores chegando como string (bigint serializado) viram número', () => {
    const item = mapPerformanceTurnoItem({ ...linhaRpc, corridas_ofertadas: '12', taxas_centavos: '2000' });
    assert.equal(item.corridasOfertadas, 12);
    assert.equal(item.taxas, '20.00');
  });
});
