/**
 * Testes unitários — hub-import-normalizer.js (tasks.md 2.2.5, 2.3.7).
 * Rodam com: node --test tests/hub-import-normalizer.test.js
 *
 * Cobre dialeto FATURAMENTO (decimal vírgula, header `subpraca`, margem_fee
 * regex, UUID opcional) e dialeto PERFORMANCE (decimal ponto, header
 * `sub_praca`, HH:MM:SS, UUID obrigatório, taxas em centavos).
 *
 * Ref: research.md Decision 3; data-model.md; plano técnico §10 (matriz);
 * briefing s4-pipeline-importacoes.md "Testes exigidos > Unit".
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  HEADER_FATURAMENTO,
  HEADER_PERFORMANCE,
  indiceHeader,
  validarHeader,
  normalizarDecimalVirgula,
  normalizarDecimalPonto,
  extrairZonaDePraca,
  normalizarMargemFee,
  normalizarDuracaoHHMMSS,
  uuidValido,
  normalizarLinhaFaturamento,
  normalizarLinhaPerformance,
} = require('../lib/hub-import-normalizer');

const IDX_FATURAMENTO = indiceHeader(HEADER_FATURAMENTO);
const IDX_PERFORMANCE = indiceHeader(HEADER_PERFORMANCE);

/** Monta uma linha de faturamento válida (campos na ORDEM do header), com
 * overrides por nome de coluna de origem. */
function linhaFaturamento(overrides = {}) {
  const base = {
    data_do_lancamento_financeiro: '2026-07-03',
    data_do_periodo_de_referencia: '2026-07-02',
    data_do_repasse: '2026-07-08',
    periodo: 'almoco 11h30-15h29',
    praca: 'SAO PAULO - LESTE (ZONA)',
    subpraca: 'ITAQUERA',
    origem: '',
    id_da_pessoa_entregadora: 'd9752e14-1234-4abc-9def-0123456789ab',
    recebedor: 'Fulano de Tal',
    tipo: 'Credito',
    valor: '1.234,56',
    descricao: 'Corridas concluidas',
    atingido: '',
    percentual_de_tempo_disponivel: '',
    percentual_de_aceitacao: '',
    percentual_de_conclusao: '',
    criterio_tempo_disponivel: '',
    criterio_rotas_aceitas: '',
    criterio_rotas_concluidas: '',
    margem_fee_porcentagem: '',
  };
  const linha = { ...base, ...overrides };
  return HEADER_FATURAMENTO.map((h) => linha[h]);
}

function linhaPerformance(overrides = {}) {
  const base = {
    data_do_periodo: '2026-07-03',
    periodo: 'almoco',
    duracao_do_periodo: '02:29:00',
    numero_minimo_de_entregadores_regulares_na_escala: '5',
    tag: 'REGULAR',
    id_da_pessoa_entregadora: 'd9752e14-1234-4abc-9def-0123456789ab',
    pessoa_entregadora: 'Fulano de Tal',
    praca: 'SAO PAULO',
    sub_praca: 'ITAQUERA',
    origem: '',
    tempo_disponivel_escalado: '44.82',
    tempo_disponivel_absoluto: '100:00:00',
    numero_de_corridas_ofertadas: '10',
    numero_de_corridas_aceitas: '8',
    numero_de_corridas_rejeitadas: '2',
    numero_de_corridas_completadas: '7',
    numero_de_corridas_canceladas_pela_pessoa_entregadora: '1',
    numero_de_pedidos_aceitos_e_concluidos: '9',
    soma_das_taxas_das_corridas_aceitas: '13254',
  };
  const linha = { ...base, ...overrides };
  return HEADER_PERFORMANCE.map((h) => linha[h]);
}

describe('normalizarDecimalVirgula (2.2.1)', () => {
  test('remove separador de milhar ANTES de trocar vírgula por ponto', () => {
    assert.equal(normalizarDecimalVirgula('1.234,56'), 1234.56);
  });

  test('valor sem milhar', () => {
    assert.equal(normalizarDecimalVirgula('25,19'), 25.19);
  });

  test('múltiplos separadores de milhar', () => {
    assert.equal(normalizarDecimalVirgula('1.234.567,89'), 1234567.89);
  });

  test('vazio/nulo retorna null', () => {
    assert.equal(normalizarDecimalVirgula(''), null);
    assert.equal(normalizarDecimalVirgula(null), null);
    assert.equal(normalizarDecimalVirgula(undefined), null);
  });

  test('sem vírgula (só ponto) trata ponto como decimal, não milhar', () => {
    // Caso do texto capturado por margem_fee ("MIN: 30.0, INTER: 33")
    assert.equal(normalizarDecimalVirgula('30.0'), 30.0);
  });
});

describe('normalizarDecimalPonto (performance, 2.3.1)', () => {
  test('ponto direto, sem transformação', () => {
    assert.equal(normalizarDecimalPonto('44.82'), 44.82);
    assert.equal(normalizarDecimalPonto('100.14'), 100.14);
  });

  test('vazio retorna null', () => {
    assert.equal(normalizarDecimalPonto(''), null);
  });
});

describe('extrairZonaDePraca (2.2.2)', () => {
  test('extrai zona do sufixo "(ZONA)"', () => {
    const { praca, zonaExtraida } = extrairZonaDePraca('SAO PAULO - LESTE (ZONA)');
    assert.equal(praca, 'SAO PAULO - LESTE (ZONA)'); // texto completo preservado (D4 — sem coluna própria p/ zona)
    assert.equal(zonaExtraida, 'LESTE');
  });

  test('sem sufixo "(ZONA)" não extrai nada', () => {
    const { praca, zonaExtraida } = extrairZonaDePraca('SAO PAULO');
    assert.equal(praca, 'SAO PAULO');
    assert.equal(zonaExtraida, null);
  });

  test('vazio retorna praca null', () => {
    assert.equal(extrairZonaDePraca('').praca, null);
  });
});

describe('normalizarMargemFee (2.2.3)', () => {
  test('regex casa e deriva min/inter', () => {
    const r = normalizarMargemFee('MIN: 30.0, INTER: 33');
    assert.equal(r.raw, 'MIN: 30.0, INTER: 33');
    assert.equal(r.min, 30.0);
    assert.equal(r.inter, 33);
  });

  test('regex NÃO casa -> só raw preenchido, sem erro (D4)', () => {
    const r = normalizarMargemFee('texto qualquer sem o padrao esperado');
    assert.equal(r.raw, 'texto qualquer sem o padrao esperado');
    assert.equal(r.min, null);
    assert.equal(r.inter, null);
  });

  test('vazio -> tudo null', () => {
    const r = normalizarMargemFee('');
    assert.equal(r.raw, null);
    assert.equal(r.min, null);
    assert.equal(r.inter, null);
  });
});

describe('normalizarDuracaoHHMMSS (2.3.3)', () => {
  test('formato válido é aceito e devolvido como está', () => {
    assert.deepEqual(normalizarDuracaoHHMMSS('02:29:00'), { valor: '02:29:00', valido: true });
  });

  test('aceita horas > 24 (duração acumulada, não hora do relógio)', () => {
    assert.deepEqual(normalizarDuracaoHHMMSS('100:00:00'), { valor: '100:00:00', valido: true });
  });

  test('formato inválido é rejeitado', () => {
    assert.equal(normalizarDuracaoHHMMSS('99:99:99').valido, false);
    assert.equal(normalizarDuracaoHHMMSS('abc').valido, false);
  });

  test('vazio é válido (campo NULL)', () => {
    assert.deepEqual(normalizarDuracaoHHMMSS(''), { valor: null, valido: true });
  });
});

describe('uuidValido', () => {
  test('aceita UUID bem formado', () => {
    assert.equal(uuidValido('d9752e14-1234-4abc-9def-0123456789ab'), true);
  });

  test('rejeita string que não é UUID', () => {
    assert.equal(uuidValido('nao-e-um-uuid'), false);
    assert.equal(uuidValido(''), false);
  });
});

describe('validarHeader', () => {
  test('header faturamento correto é válido', () => {
    assert.equal(validarHeader(HEADER_FATURAMENTO, 'faturamento').valido, true);
  });

  test('header performance correto é válido', () => {
    assert.equal(validarHeader(HEADER_PERFORMANCE, 'performance').valido, true);
  });

  test('header com nome trocado é inválido (falha estrutural)', () => {
    const headerErrado = [...HEADER_FATURAMENTO];
    headerErrado[0] = 'coluna_errada';
    assert.equal(validarHeader(headerErrado, 'faturamento').valido, false);
  });

  test('tolera diferenças de case/espaço no header', () => {
    const headerComEspacos = HEADER_FATURAMENTO.map((h) => `  ${h.toUpperCase()}  `);
    assert.equal(validarHeader(headerComEspacos, 'faturamento').valido, true);
  });
});

describe('normalizarLinhaFaturamento (2.2)', () => {
  test('linha válida completa: sem erros, valor convertido corretamente', () => {
    const { valores, erros } = normalizarLinhaFaturamento(linhaFaturamento(), IDX_FATURAMENTO);
    assert.deepEqual(erros, []);
    assert.equal(valores.valor, 1234.56);
    assert.equal(valores.tipo, 'Credito');
    assert.equal(valores.periodo, 'ALMOCO 11H30-15H29');
    assert.equal(valores.id_externo, 'd9752e14-1234-4abc-9def-0123456789ab');
  });

  test('ausência de UUID é VÁLIDA (4,5% legítimo — bônus agregado)', () => {
    const { valores, erros } = normalizarLinhaFaturamento(
      linhaFaturamento({ id_da_pessoa_entregadora: '' }),
      IDX_FATURAMENTO
    );
    assert.equal(valores.id_externo, null);
    assert.equal(erros.some((e) => e.campo === 'id_da_pessoa_entregadora'), false);
  });

  test('UUID malformado gera erro de linha', () => {
    const { erros } = normalizarLinhaFaturamento(
      linhaFaturamento({ id_da_pessoa_entregadora: 'nao-e-uuid' }),
      IDX_FATURAMENTO
    );
    assert.ok(erros.some((e) => e.campo === 'id_da_pessoa_entregadora'));
  });

  test('atingido fora da faixa 0-1000 gera erro de linha', () => {
    const { erros, valores } = normalizarLinhaFaturamento(
      linhaFaturamento({ atingido: '1500,00' }),
      IDX_FATURAMENTO
    );
    assert.ok(erros.some((e) => e.campo === 'atingido'));
    assert.equal(valores.atingido, null);
  });

  test('atingido dentro da faixa é aceito', () => {
    const { erros, valores } = normalizarLinhaFaturamento(
      linhaFaturamento({ atingido: '80,5' }),
      IDX_FATURAMENTO
    );
    assert.equal(erros.some((e) => e.campo === 'atingido'), false);
    assert.equal(valores.atingido, 80.5);
  });

  test('valor <= 0 gera erro de linha', () => {
    const { erros } = normalizarLinhaFaturamento(linhaFaturamento({ valor: '0,00' }), IDX_FATURAMENTO);
    assert.ok(erros.some((e) => e.campo === 'valor'));
  });

  test('tipo novo (nem Credito nem Debito) gera AVISO, não erro (Gotcha do briefing)', () => {
    const { erros, avisos } = normalizarLinhaFaturamento(
      linhaFaturamento({ tipo: 'Estorno' }),
      IDX_FATURAMENTO
    );
    assert.equal(erros.some((e) => e.campo === 'tipo'), false);
    assert.ok(avisos.some((a) => a.campo === 'tipo'));
  });

  test('Debito é aceito sem aviso (domínio conhecido)', () => {
    const { avisos } = normalizarLinhaFaturamento(linhaFaturamento({ tipo: 'Debito' }), IDX_FATURAMENTO);
    assert.equal(avisos.some((a) => a.campo === 'tipo'), false);
  });

  test('campo obrigatório ausente (descricao) gera erro de linha', () => {
    const { erros } = normalizarLinhaFaturamento(linhaFaturamento({ descricao: '' }), IDX_FATURAMENTO);
    assert.ok(erros.some((e) => e.campo === 'descricao'));
  });

  test('margem_fee integrado na linha completa', () => {
    const { valores } = normalizarLinhaFaturamento(
      linhaFaturamento({ margem_fee_porcentagem: 'MIN: 30.0, INTER: 33' }),
      IDX_FATURAMENTO
    );
    assert.equal(valores.margem_fee_raw, 'MIN: 30.0, INTER: 33');
    assert.equal(valores.margem_fee_min, 30.0);
    assert.equal(valores.margem_fee_inter, 33);
  });
});

describe('normalizarLinhaPerformance (2.3)', () => {
  test('linha válida completa: sem erros', () => {
    const { valores, erros } = normalizarLinhaPerformance(linhaPerformance(), IDX_PERFORMANCE);
    assert.deepEqual(erros, []);
    assert.equal(valores.tempo_disponivel_pct, 44.82);
    assert.equal(valores.duracao, '02:29:00');
    assert.equal(valores.taxas_centavos, 13254);
  });

  test('HH:MM:SS parseado corretamente (duracao e tempo_disponivel)', () => {
    const { valores } = normalizarLinhaPerformance(
      linhaPerformance({ duracao_do_periodo: '03:59:00', tempo_disponivel_absoluto: '100:00:00' }),
      IDX_PERFORMANCE
    );
    assert.equal(valores.duracao, '03:59:00');
    assert.equal(valores.tempo_disponivel, '100:00:00');
  });

  test('taxas em centavos: inteiro direto, SEM divisão', () => {
    const { valores } = normalizarLinhaPerformance(
      linhaPerformance({ soma_das_taxas_das_corridas_aceitas: '13254' }),
      IDX_PERFORMANCE
    );
    assert.equal(valores.taxas_centavos, 13254);
  });

  test('linha SEM UUID é rejeitada com motivo claro (obrigatório em performance)', () => {
    const { erros, valores } = normalizarLinhaPerformance(
      linhaPerformance({ id_da_pessoa_entregadora: '' }),
      IDX_PERFORMANCE
    );
    assert.equal(valores.id_externo, null);
    const erroUuid = erros.find((e) => e.campo === 'id_da_pessoa_entregadora');
    assert.ok(erroUuid, 'esperava erro de linha para UUID ausente');
    assert.match(erroUuid.motivo, /obrigat/i);
  });

  test('UUID malformado em performance também é erro', () => {
    const { erros } = normalizarLinhaPerformance(
      linhaPerformance({ id_da_pessoa_entregadora: 'xyz' }),
      IDX_PERFORMANCE
    );
    assert.ok(erros.some((e) => e.campo === 'id_da_pessoa_entregadora'));
  });

  test('tempo_disponivel_escalado fora da faixa 0-150 gera erro', () => {
    const { erros } = normalizarLinhaPerformance(
      linhaPerformance({ tempo_disponivel_escalado: '200.0' }),
      IDX_PERFORMANCE
    );
    assert.ok(erros.some((e) => e.campo === 'tempo_disponivel_pct'));
  });

  test('consistência aceitas+rejeitadas > ofertadas gera AVISO, não erro', () => {
    const { erros, avisos } = normalizarLinhaPerformance(
      linhaPerformance({
        numero_de_corridas_ofertadas: '5',
        numero_de_corridas_aceitas: '4',
        numero_de_corridas_rejeitadas: '3',
      }),
      IDX_PERFORMANCE
    );
    assert.equal(erros.some((e) => e.campo === 'corridas_aceitas'), false);
    assert.ok(avisos.some((a) => a.campo === 'corridas_aceitas'));
  });

  test('header sub_praca (com underscore) é lido corretamente', () => {
    const { valores } = normalizarLinhaPerformance(
      linhaPerformance({ sub_praca: 'MINI BTU FD' }),
      IDX_PERFORMANCE
    );
    assert.equal(valores.subpraca, 'MINI BTU FD');
  });
});
