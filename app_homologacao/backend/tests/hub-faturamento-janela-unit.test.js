/**
 * Qual COLUNA a janela `de`/`ate` do módulo Financeiro filtra.
 *
 * Até a migration 0055 era `data_referencia` (a competência — o dia do turno a
 * que o lançamento se refere). Desde 2026-08-30 é `data_lancamento` (o dia em
 * que o lançamento foi emitido), por decisão do operador, para o filtro
 * significar o mesmo que no módulo Performance.
 *
 * As duas colunas divergem de verdade: no arquivo real de 28/08/2026, 1.058 das
 * 4.786 linhas tinham competência 27/08. Trocar a coluna sem querer muda todo
 * total diário da tela, em silêncio — daí este teste existir, e ser unitário
 * (o de integração exige Docker e não roda no `npm test` padrão).
 *
 * A migration precisa acompanhar: as RPCs `hub_faturamento_totais`/`_agrupado`
 * e a `mv_faturamento_dia` usam a mesma coluna. Backend filtrando uma e MV
 * agregando outra = lista e cards discordando na mesma tela.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { montarFiltrosQuery } = require('../routes/hub-faturamento');

const FILTRO_BASE = {
  de: '2026-08-28',
  ate: '2026-08-28',
  categoria: null,
  entregadorId: null,
  subpraca: null,
  comEntregador: null,
};

describe('faturamento — a janela de datas filtra `data_lancamento` (0055)', () => {
  test('gte/lte usam data_lancamento, nunca data_referencia', () => {
    const filtros = montarFiltrosQuery(6, FILTRO_BASE);

    assert.ok(filtros.includes('data_lancamento=gte.2026-08-28'), `esperava gte por data_lancamento, veio: ${filtros.join('&')}`);
    assert.ok(filtros.includes('data_lancamento=lte.2026-08-28'), `esperava lte por data_lancamento, veio: ${filtros.join('&')}`);
    assert.equal(
      filtros.some((f) => f.startsWith('data_referencia=')),
      false,
      'competência não pode voltar a ser a coluna da janela — mudaria todo total diário em silêncio'
    );
  });

  test('o escopo da entidade continua sempre presente (Princípio II)', () => {
    assert.ok(montarFiltrosQuery(6, FILTRO_BASE).includes('id_empresa=eq.6'));
  });

  test('demais filtros seguem intactos e independentes da troca de coluna', () => {
    const filtros = montarFiltrosQuery(6, {
      ...FILTRO_BASE,
      categoria: 'Corridas concluidas',
      entregadorId: 42,
      subpraca: 'PANAMBY E VILA SONIA - SP',
      comEntregador: true,
    });
    assert.ok(filtros.includes('descricao=eq.Corridas%20concluidas'));
    assert.ok(filtros.includes('entregador_id=eq.42'));
    assert.ok(filtros.includes('subpraca=eq.PANAMBY%20E%20VILA%20SONIA%20-%20SP'));
    assert.ok(filtros.includes('entregador_id=not.is.null'));
  });
});
