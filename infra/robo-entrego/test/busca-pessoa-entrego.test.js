// test/busca-pessoa-entrego.test.js (hub-motorista-360 FASE 5, tasks.md
// 5.3.2) — mock de `page` (interface .click/.fill, mesma técnica de
// test/entrego-portal.test.js#mockPageLogin), sem Playwright real.
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { ErroAntibotSuspeito } = require('../src/entrego-portal');
const {
  buscarDadosPessoaPorUuid,
  extrairDadosPessoaPlaceholder,
  ErroExtracaoNaoLevantada,
  XPATHS,
} = require('../src/busca-pessoa-entrego');

function mockPage({ falharEm = null } = {}) {
  const chamadas = [];
  const metodo = (nome) => async (...args) => {
    chamadas.push({ nome, args });
    if (falharEm === nome) throw new Error(`TimeoutError: esperando por elemento (${nome})`);
  };
  return {
    chamadas,
    click: metodo('click'),
    fill: metodo('fill'),
  };
}

describe('buscarDadosPessoaPorUuid — navegação (6 passos, contracts/entrego-enriquecimento.md §3)', () => {
  test('navega os 6 passos na ordem, com xpath= prefixado (convenção Playwright), UUID preenchido no campo certo', async () => {
    const page = mockPage();
    const extrairDadosPessoa = async () => ({ ok: true });
    const resultado = await buscarDadosPessoaPorUuid(page, { uuid: '11111111-1111-1111-1111-111111111111', extrairDadosPessoa });
    assert.deepEqual(resultado, { ok: true });

    const cliques = page.chamadas.filter((c) => c.nome === 'click').map((c) => c.args[0]);
    assert.deepEqual(cliques, [
      `xpath=${XPATHS.menu}`,
      `xpath=${XPATHS.itemBuscaPessoas}`,
      `xpath=${XPATHS.botaoFiltro}`,
      `xpath=${XPATHS.botaoAplicarFiltros}`,
      `xpath=${XPATHS.botaoVerDetalhes}`,
    ]);
    const preenchimento = page.chamadas.find((c) => c.nome === 'fill');
    assert.equal(preenchimento.args[0], `xpath=${XPATHS.campoUuid}`);
    assert.equal(preenchimento.args[1], '11111111-1111-1111-1111-111111111111');
  });

  test('elemento de navegação não aparece dentro do timeout -> ErroAntibotSuspeito (nunca retry)', async () => {
    const page = mockPage({ falharEm: 'click' });
    await assert.rejects(
      () => buscarDadosPessoaPorUuid(page, { uuid: 'x', extrairDadosPessoa: async () => ({}) }),
      ErroAntibotSuspeito
    );
  });

  test('extrairDadosPessoa SÓ é chamado depois dos 6 passos completarem', async () => {
    const page = mockPage();
    let extraiuApos = null;
    await buscarDadosPessoaPorUuid(page, {
      uuid: 'x',
      extrairDadosPessoa: async () => { extraiuApos = page.chamadas.length; return {}; },
    });
    assert.equal(extraiuApos, 6);
  });
});

describe('extrairDadosPessoaPlaceholder — gap deliberado (Constitution VI)', () => {
  test('default: lança ErroExtracaoNaoLevantada, NUNCA inventa um shape de dado', async () => {
    await assert.rejects(() => extrairDadosPessoaPlaceholder({}), ErroExtracaoNaoLevantada);
  });

  test('buscarDadosPessoaPorUuid SEM extrairDadosPessoa customizado propaga ErroExtracaoNaoLevantada (não ErroAntibotSuspeito)', async () => {
    const page = mockPage();
    await assert.rejects(() => buscarDadosPessoaPorUuid(page, { uuid: 'x' }), ErroExtracaoNaoLevantada);
  });
});
