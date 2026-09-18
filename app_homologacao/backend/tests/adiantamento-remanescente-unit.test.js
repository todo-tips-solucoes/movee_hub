/**
 * Testes unitários — lib/adiantamento-remanescente.js (tasks.md 2.4).
 * Rodam com: node --test tests/adiantamento-remanescente-unit.test.js
 *
 * Ref: Spec §FR-037, §FR-038, §FR-040, §FR-041; contracts/hub-api.md
 * §Repasse; PLANO.md §18 (R-15, R-16, D-09..D-12).
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  calcularPeriodo,
  dataNoPeriodo,
  somaAdiantamentosNoPeriodo,
  calcularLinhaRemanescente,
  serializarCsvRemanescente,
  paraCentavos,
  formatarCentavos,
} = require('../lib/adiantamento-remanescente');

const CONFIG_PADRAO = {
  apuracao_dia_inicio: 4, // quinta
  apuracao_dias_ate_repasse: 0,
  desconto_adiantamentos: true,
  desconto_debitos: false,
};

describe('calcularPeriodo() — janela W de 7 dias + data de repasse (2.4.1, PLANO §18)', () => {
  test('7 dias de calendário, dataRepasse = fim + apuracao_dias_ate_repasse', () => {
    const p = calcularPeriodo(CONFIG_PADRAO, '2026-09-10');
    assert.deepEqual(p, { inicio: '2026-09-10', fim: '2026-09-16', dataRepasse: '2026-09-16' });
  });

  test('apuracao_dias_ate_repasse desloca a data de repasse', () => {
    const p = calcularPeriodo({ ...CONFIG_PADRAO, apuracao_dias_ate_repasse: 2 }, '2026-09-10');
    assert.equal(p.dataRepasse, '2026-09-18');
  });

  test('janela cruzando virada de mês/ano funciona (aritmética de calendário pura)', () => {
    const p = calcularPeriodo(CONFIG_PADRAO, '2026-12-28');
    assert.equal(p.fim, '2027-01-03');
  });
});

describe('dataNoPeriodo() / somaAdiantamentosNoPeriodo() — D-12 (2.4.1, 2.4.4)', () => {
  const periodo = { inicio: '2026-09-10', fim: '2026-09-16', dataRepasse: '2026-09-16' };

  test('data dentro dos limites (inclusive) do período', () => {
    assert.equal(dataNoPeriodo('2026-09-10', periodo), true);
    assert.equal(dataNoPeriodo('2026-09-16', periodo), true);
    assert.equal(dataNoPeriodo('2026-09-09', periodo), false);
    assert.equal(dataNoPeriodo('2026-09-17', periodo), false);
  });

  test('um adiantamento entra no período da sua data_producao, não da data de pagamento (D-12)', () => {
    const adiantamentos = [
      { data_producao: '2026-09-12', valor_bruto: 100 }, // dentro
      { data_producao: '2026-09-09', valor_bruto: 999 }, // fora (véspera do início)
      { data_producao: '2026-09-16', valor_bruto: 50 }, // fronteira: último dia, dentro
    ];
    assert.equal(somaAdiantamentosNoPeriodo(adiantamentos, periodo), 150);
  });
});

describe('calcularLinhaRemanescente() — R-15/R-16, FR-040 (2.4.1, 2.4.2, 2.4.4)', () => {
  const periodo = { inicio: '2026-09-10', fim: '2026-09-16', dataRepasse: '2026-09-16' };

  test('créditos − adiantamentos pagos bruto (D-11) no período', () => {
    const linha = calcularLinhaRemanescente(
      {
        entregadorId: 42,
        nome: 'Fulano de Tal',
        creditos: 1000,
        adiantamentosPagos: [{ data_producao: '2026-09-12', valor_bruto: 129.4 }],
        debitos: 50,
      },
      periodo,
      CONFIG_PADRAO,
    );
    assert.equal(linha.creditos, 1000);
    assert.equal(linha.adiantamentos, 129.4);
    assert.equal(linha.debitos, 0); // desconto_debitos desligado no CONFIG_PADRAO
    assert.equal(linha.remanescente, 870.6);
    assert.equal(linha.negativo, false);
  });

  test('débitos desligados não entram na soma mesmo com valor presente', () => {
    const linha = calcularLinhaRemanescente(
      { entregadorId: 1, nome: 'X', creditos: 100, adiantamentosPagos: [], debitos: 40 },
      periodo,
      { ...CONFIG_PADRAO, desconto_debitos: false },
    );
    assert.equal(linha.debitos, 0);
    assert.equal(linha.remanescente, 100);
  });

  test('débitos ligados entram na soma', () => {
    const linha = calcularLinhaRemanescente(
      { entregadorId: 1, nome: 'X', creditos: 100, adiantamentosPagos: [], debitos: 40 },
      periodo,
      { ...CONFIG_PADRAO, desconto_debitos: true },
    );
    assert.equal(linha.debitos, 40);
    assert.equal(linha.remanescente, 60);
  });

  test('remanescente negativo é sinalizado, sem transporte automático (FR-040)', () => {
    const linha = calcularLinhaRemanescente(
      {
        entregadorId: 1,
        nome: 'X',
        creditos: 100,
        adiantamentosPagos: [{ data_producao: '2026-09-11', valor_bruto: 250 }],
        debitos: 0,
      },
      periodo,
      CONFIG_PADRAO,
    );
    assert.equal(linha.remanescente, -150);
    assert.equal(linha.negativo, true);
    assert.equal(linha.remanescenteCentavos, -15000);
  });

  test('adiantamentos desligados (interruptor) não entram, mesmo com data_producao no período', () => {
    const linha = calcularLinhaRemanescente(
      {
        entregadorId: 1,
        nome: 'X',
        creditos: 100,
        adiantamentosPagos: [{ data_producao: '2026-09-12', valor_bruto: 60 }],
        debitos: 0,
      },
      periodo,
      { ...CONFIG_PADRAO, desconto_adiantamentos: false },
    );
    assert.equal(linha.adiantamentos, 0);
    assert.equal(linha.remanescente, 100);
  });
});

describe('soma em centavos inteiros — correção dec-063 (2.7.1-2.7.3)', () => {
  const periodo = { inicio: '2026-09-10', fim: '2026-09-16', dataRepasse: '2026-09-16' };

  test('duas linhas 0,10 + 0,20 somam exatamente 0.30 — reduce() de floats dava 0.30000000000000004', () => {
    const linha = calcularLinhaRemanescente(
      {
        entregadorId: 1,
        nome: 'X',
        creditos: 1,
        adiantamentosPagos: [
          { data_producao: '2026-09-11', valor_bruto: 0.1 },
          { data_producao: '2026-09-12', valor_bruto: 0.2 },
        ],
        debitos: 0,
      },
      periodo,
      CONFIG_PADRAO,
    );
    assert.equal(linha.adiantamentosCentavos, 30);
    assert.equal(linha.adiantamentos, 0.3);
  });

  test('créditos 2,675 arredonda meio-para-cima para 2.68 — Number(2.675).toFixed(2) dava "2.67" (FR-010)', () => {
    const linha = calcularLinhaRemanescente(
      { entregadorId: 1, nome: 'X', creditos: 2.675, adiantamentosPagos: [], debitos: 0 },
      periodo,
      CONFIG_PADRAO,
    );
    assert.equal(linha.creditosCentavos, 268);
    assert.equal(serializarCsvRemanescente([linha]).split('\r\n')[1], 'X,2.68,0.00,0.00,2.68');
  });

  test('300 linhas de 0,07 somam exatamente 2100 centavos (21.00) — reduce() de floats acumulava ruído (21.000000000000064)', () => {
    const adiantamentosPagos = Array.from({ length: 300 }, (_v, i) => ({
      data_producao: '2026-09-12',
      valor_bruto: 0.07,
      i,
    }));
    const linha = calcularLinhaRemanescente(
      { entregadorId: 1, nome: 'X', creditos: 21, adiantamentosPagos, debitos: 0 },
      periodo,
      CONFIG_PADRAO,
    );
    assert.equal(linha.adiantamentosCentavos, 2100);
    assert.equal(linha.remanescenteCentavos, 0);
    assert.equal(linha.remanescente, 0);
  });
});

describe('paraCentavos() — arredondamento sem multiplicação em ponto flutuante (dec-067, revisão onda-013, 2.8.1-2.8.3)', () => {
  // Terceira casa decimal = 5: `Math.round(Number(v) * 100)` errava por sorte
  // do binário (100/816 em vez de 101/817) porque `1.005 * 100` não é exato.
  const CASOS_TERCEIRA_CASA_5 = [
    ['1.005', 101],
    ['2.675', 268],
    ['8.165', 817],
    ['129.345', 12935],
    ['0.005', 1],
  ];

  for (const [entrada, esperado] of CASOS_TERCEIRA_CASA_5) {
    test(`"${entrada}" → ${esperado} centavos (meio-para-cima, FR-010)`, () => {
      assert.equal(paraCentavos(entrada), esperado);
    });
    test(`"-${entrada}" → ${-esperado} centavos (mesma magnitude, sinal aplicado por último)`, () => {
      assert.equal(paraCentavos(`-${entrada}`), -esperado);
    });
  }

  test('valores já com 2 casas ficam inalterados', () => {
    assert.equal(paraCentavos('129.40'), 12940);
    assert.equal(paraCentavos('0.35'), 35);
  });

  test('formatarCentavos(paraCentavos(x)) reproduz a string de 2 casas para toda a tabela', () => {
    assert.equal(formatarCentavos(paraCentavos('1.005')), '1.01');
    assert.equal(formatarCentavos(paraCentavos('8.165')), '8.17');
    assert.equal(formatarCentavos(paraCentavos('-1.005')), '-1.01');
  });

  test('aceita number além de string (mesma conversão via String(valor))', () => {
    assert.equal(paraCentavos(1.005), 101);
    assert.equal(paraCentavos(8.165), 817);
  });
});

describe('serializarCsvRemanescente() — proteção de injeção de fórmula (2.4.3, S5)', () => {
  test('cabeçalho + linhas, valores em 2 casas', () => {
    const csv = serializarCsvRemanescente([
      { nome: 'Fulano de Tal', creditos: 1000, adiantamentos: 129.4, debitos: 0, remanescente: 870.6 },
    ]);
    const linhas = csv.split('\r\n');
    assert.equal(linhas[0], 'Entregador,Créditos,Adiantamentos,Débitos,Remanescente');
    assert.equal(linhas[1], 'Fulano de Tal,1000.00,129.40,0.00,870.60');
  });

  test('nome começando com "=" ganha prefixo de neutralização (fórmula em Excel/Sheets)', () => {
    const csv = serializarCsvRemanescente([{ nome: '=SOMA(A1:A9)', creditos: 0, adiantamentos: 0, debitos: 0, remanescente: 0 }]);
    assert.match(csv, /^Entregador.*\r\n'=SOMA\(A1:A9\),/s);
  });

  test('nome com vírgula é quotado (RFC 4180)', () => {
    const csv = serializarCsvRemanescente([{ nome: 'Silva, João', creditos: 0, adiantamentos: 0, debitos: 0, remanescente: 0 }]);
    assert.match(csv, /"Silva, João"/);
  });
});
