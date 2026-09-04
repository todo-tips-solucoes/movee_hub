// test/enriquecimento.test.js (hub-motorista-360 FASE 5, tasks.md 5.3.4/5.3.5)
// — mock de `clienteHub`/`page`/`dormir`, sem Playwright/HTTP real (mesma
// técnica de test/index.test.js).
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { ErroAntibotSuspeito } = require('../src/entrego-portal');
const { ErroExtracaoNaoLevantada } = require('../src/busca-pessoa-entrego');
const { executarRodadaEnriquecimento, THROTTLE_MS_ENTRE_MOTORISTAS } = require('../src/enriquecimento');

function mockClienteHub({ itens = [], atualizarImpl = null } = {}) {
  const chamadasAtualizar = [];
  return {
    chamadasAtualizar,
    login: async () => ({ entidadeAtiva: 6 }),
    buscarMotoristasParaEnriquecer: async () => itens,
    atualizarEnriquecimento: async (id, resultado) => {
      chamadasAtualizar.push({ id, resultado });
      if (atualizarImpl) return atualizarImpl(id, resultado);
      return { sinal: 'enriquecimento_200' };
    },
  };
}

const configFake = { hubServicoEmail: 'x', hubServicoSenha: 'y', entregoEmail: 'a', entregoSenha: 'b', storageStatePath: '/tmp/nao-usado.json' };

/** `garantirSessaoValida` real chama `page.evaluate`/`page.goto` — mock mínimo
 * que sempre reporta sessão válida (não é o foco deste teste, coberto em
 * test/entrego-portal.test.js). */
function pageComSessaoValida() {
  return {
    url: () => 'https://franqueado.entregolog.com/',
    goto: async () => {},
    evaluate: async () => ({ status: 200 }),
    click: async () => {},
    fill: async () => {},
  };
}

describe('executarRodadaEnriquecimento (task 5.3.4)', () => {
  test('modo inválido -> lança sem chamar o hub', async () => {
    await assert.rejects(
      () => executarRodadaEnriquecimento({ modo: 'diario', page: pageComSessaoValida(), clienteHub: mockClienteHub(), config: configFake, dormir: async () => {} }),
      /modo inválido/
    );
  });

  test('fila vazia -> resultado sem_dados, nenhuma chamada de atualização', async () => {
    const clienteHub = mockClienteHub({ itens: [] });
    const r = await executarRodadaEnriquecimento({ modo: 'sob-demanda', page: pageComSessaoValida(), clienteHub, config: configFake, dormir: async () => {} });
    assert.equal(r.resultado, 'sem_dados');
    assert.equal(r.total, 0);
    assert.equal(clienteHub.chamadasAtualizar.length, 0);
  });

  test('2 motoristas, ambos com sucesso -> resultado sucesso, throttle de 60s ENTRE eles (não antes do 1º)', async () => {
    const itens = [{ id: 1, idExterno: 'uuid-1' }, { id: 2, idExterno: 'uuid-2' }];
    const clienteHub = mockClienteHub({ itens });
    const dormires = [];
    const r = await executarRodadaEnriquecimento({
      modo: 'sob-demanda',
      page: pageComSessaoValida(),
      clienteHub,
      config: configFake,
      dormir: async (ms) => { dormires.push(ms); },
      extrairDadosPessoa: async () => ({ dadosPessoais: {} }),
    });
    assert.equal(r.resultado, 'sucesso');
    assert.equal(r.sucessos, 2);
    assert.equal(r.falhas, 0);
    assert.deepEqual(dormires, [THROTTLE_MS_ENTRE_MOTORISTAS]);
    assert.equal(clienteHub.chamadasAtualizar.length, 2);
    assert.equal(clienteHub.chamadasAtualizar[0].resultado.sucesso, true);
    assert.equal(clienteHub.chamadasAtualizar[0].resultado.dados.dadosPessoais !== undefined, true);
  });

  test('ErroAntibotSuspeito no meio da rodada -> PARA (não processa os seguintes), item corrente NÃO é reportado (fica pendente pra próxima janela)', async () => {
    const itens = [{ id: 1, idExterno: 'uuid-1' }, { id: 2, idExterno: 'uuid-2' }, { id: 3, idExterno: 'uuid-3' }];
    const clienteHub = mockClienteHub({ itens });
    let chamadas = 0;
    const r = await executarRodadaEnriquecimento({
      modo: 'sob-demanda',
      page: pageComSessaoValida(),
      clienteHub,
      config: configFake,
      dormir: async () => {},
      extrairDadosPessoa: async () => {
        chamadas += 1;
        if (chamadas === 2) throw new ErroAntibotSuspeito('suspeita detectada');
        return {};
      },
    });
    assert.equal(chamadas, 2, 'só deveria tentar até o item que disparou o antibot');
    assert.equal(r.sucessos, 1);
    assert.equal(r.falhas, 0);
    assert.equal(r.parouPorAntibotOuGap, true);
    assert.equal(r.resultado, 'falha_parcial');
    // item 2 (o que falhou) e item 3 (nunca tentado) NÃO foram reportados ao hub.
    assert.equal(clienteHub.chamadasAtualizar.length, 1);
    assert.equal(clienteHub.chamadasAtualizar[0].id, 1);
  });

  test('ErroExtracaoNaoLevantada (gap de implementação, default sem extrairDadosPessoa) -> PARA a rodada, falha_total', async () => {
    const itens = [{ id: 1, idExterno: 'uuid-1' }];
    const clienteHub = mockClienteHub({ itens });
    const r = await executarRodadaEnriquecimento({
      modo: 'sob-demanda',
      page: pageComSessaoValida(),
      clienteHub,
      config: configFake,
      dormir: async () => {},
      // extrairDadosPessoa OMITIDO -> usa o placeholder real (comportamento de produção hoje).
    });
    assert.equal(r.resultado, 'falha_total');
    assert.equal(r.parouPorAntibotOuGap, true);
    assert.match(r.motivoParada, /não foram levantados empiricamente/);
    assert.equal(clienteHub.chamadasAtualizar.length, 0);
  });

  test('FR-007 — falha ISOLADA de 1 motorista (não antibot) reporta sucesso=false e SEGUE pro próximo, sem dados no PATCH', async () => {
    const itens = [{ id: 1, idExterno: 'uuid-1' }, { id: 2, idExterno: 'uuid-2' }];
    const clienteHub = mockClienteHub({ itens });
    let chamadas = 0;
    const r = await executarRodadaEnriquecimento({
      modo: 'semestral',
      page: pageComSessaoValida(),
      clienteHub,
      config: configFake,
      dormir: async () => {},
      extrairDadosPessoa: async () => {
        chamadas += 1;
        if (chamadas === 1) throw new Error('falha pontual qualquer, ex.: campo ausente na página');
        return { dadosPessoais: {} };
      },
    });
    assert.equal(chamadas, 2, 'deveria seguir para o 2º motorista mesmo após falha isolada do 1º');
    assert.equal(r.sucessos, 1);
    assert.equal(r.falhas, 1);
    assert.equal(r.parouPorAntibotOuGap, false);
    assert.equal(r.resultado, 'falha_parcial');
    assert.equal(clienteHub.chamadasAtualizar.length, 2);
    assert.equal(clienteHub.chamadasAtualizar[0].resultado.sucesso, false);
    assert.equal('dados' in clienteHub.chamadasAtualizar[0].resultado, false);
    assert.equal(clienteHub.chamadasAtualizar[0].resultado.motivoFalha, 'falha pontual qualquer, ex.: campo ausente na página');
  });

  test('todos os motoristas falham (sem antibot) -> falha_total', async () => {
    const itens = [{ id: 1, idExterno: 'uuid-1' }];
    const clienteHub = mockClienteHub({ itens });
    const r = await executarRodadaEnriquecimento({
      modo: 'sob-demanda',
      page: pageComSessaoValida(),
      clienteHub,
      config: configFake,
      dormir: async () => {},
      extrairDadosPessoa: async () => { throw new Error('falha isolada'); },
    });
    assert.equal(r.resultado, 'falha_total');
    assert.equal(r.sucessos, 0);
    assert.equal(r.falhas, 1);
  });
});
