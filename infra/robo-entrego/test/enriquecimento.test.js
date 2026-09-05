// test/enriquecimento.test.js (hub-motorista-360 FASE 5, tasks.md 5.3.4/5.3.5)
// — mock de `clienteHub`/`page`/`dormir`, sem Playwright/HTTP real (mesma
// técnica de test/index.test.js).
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { ErroAntibotSuspeito, ErroPortalTransitorio } = require('../src/entrego-portal');
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

/** Mesma coisa, mas o `evaluate` sabe responder à chamada REAL de
 * busca-pessoa-entrego.js (`args.uuid` presente) com um corpo de API —
 * usado só pelo teste "sem buscarDadosPessoa customizado" abaixo. */
function pageComSessaoEDados(corpoPessoa) {
  return {
    url: () => 'https://franqueado.entregolog.com/',
    goto: async () => {},
    evaluate: async (_fn, args) => (
      args && args.uuid
        ? { status: 200, contentType: 'application/json', corpo: corpoPessoa }
        : { status: 200 }
    ),
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

  // O retorno de `garantirSessaoValida` era descartado, então o log não
  // distinguia "reusou a sessão" de "fez login completo" — e login completo
  // dispara código de validação por e-mail para o operador. Ele só descobriu
  // pela caixa de entrada. Estes 3 testes prendem a propagação do estado.
  test('sessão reusada -> resultado carrega sessao=reusada', async () => {
    const clienteHub = mockClienteHub({ itens: [{ id: 1, idExterno: 'u1' }] });
    const r = await executarRodadaEnriquecimento({
      modo: 'sob-demanda', page: pageComSessaoValida(), clienteHub, config: configFake,
      dormir: async () => {}, buscarDadosPessoa: async () => ({ dadosPessoais: {} }),
    });
    assert.equal(r.sessao, 'reusada');
  });

  test('login completo (sonda 401) -> resultado carrega sessao=relogou', async () => {
    // Mesma montagem de page do cenário de relogin em entrego-portal.test.js:
    // a sonda devolve 401 e o fluxo de login é todo satisfeito por mocks.
    const page = {
      url: () => 'https://franqueado.entregolog.com/',
      goto: async () => {},
      evaluate: async (_fn, args) => (args && args.uuid
        ? { status: 200, contentType: 'application/json', corpo: { personalData: {} } }
        : { status: 401 }),
      fill: async () => {},
      click: async () => {},
      waitForSelector: async () => {},
      waitForFunction: async () => {},
      context: () => ({ storageState: async () => ({ cookies: [] }) }),
    };
    const clienteHub = mockClienteHub({ itens: [{ id: 1, idExterno: 'u1' }] });
    const r = await executarRodadaEnriquecimento({
      modo: 'sob-demanda', page, clienteHub,
      config: { ...configFake, storageStatePath: `/tmp/sessao-teste-${Date.now()}.json` },
      dormir: async () => {}, obterCodigo: async () => '654321',
      buscarDadosPessoa: async () => ({ dadosPessoais: {} }),
    });
    assert.equal(r.sessao, 'relogou');
  });

  test('fila vazia -> sessao=nao-tocou (o portal nem é aberto)', async () => {
    const r = await executarRodadaEnriquecimento({
      modo: 'sob-demanda', page: pageComSessaoValida(), clienteHub: mockClienteHub({ itens: [] }),
      config: configFake, dormir: async () => {},
    });
    assert.equal(r.sessao, 'nao-tocou');
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
      buscarDadosPessoa: async () => ({ dadosPessoais: {} }),
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
      buscarDadosPessoa: async () => {
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

  // 6.1.4: mesmo comportamento "para em vez de insistir" já validado do robô
  // de importação — aqui estendido a ErroPortalTransitorio (401 mid-rodada/
  // 5xx persistente após os retries de comRetryTransitorio): não é culpa do
  // motorista corrente, então a rodada PARA em vez de queimar o resto da
  // fila como "falha" de cada item.
  // Medido 2026-09-05: token de acesso de 3 min x 60 s entre motoristas =
  // toda rodada com 4+ motoristas cruza a expiração NO MEIO. Antes, o 4º
  // motorista tomava 401 e a rodada parava; cada timer seguinte relogava
  // (código) e fazia mais 3. Aqui: 401 no motorista 2 -> refresh (não login)
  // -> retenta -> a rodada inteira conclui, sem nenhum passo de login.
  test('401 mid-rodada -> renova pelo REFRESH (sem login), retenta o item e conclui a rodada inteira', async () => {
    const itens = [{ id: 1, idExterno: 'uuid-1' }, { id: 2, idExterno: 'uuid-2' }, { id: 3, idExterno: 'uuid-3' }];
    const clienteHub = mockClienteHub({ itens });
    const evaluates = [];
    let loginTocado = false;
    const page = {
      url: () => 'https://franqueado.entregolog.com/',
      goto: async () => {},
      evaluate: async (fn) => {
        evaluates.push(fn.name);
        // sonda inicial 200 (sessão reusada); no meio da rodada, 401 -> refresh 200
        if (fn.name === '_evalSondaSessao') return { status: evaluates.filter((n) => n === '_evalSondaSessao').length === 1 ? 200 : 401 };
        if (fn.name === '_evalRenovarSessao') return { status: 200 };
        throw new Error(`evaluate inesperado: ${fn.name}`);
      },
      fill: async () => { loginTocado = true; },
      click: async () => { loginTocado = true; },
      context: () => ({ storageState: async () => ({ cookies: [] }) }),
    };
    let chamadas = 0;
    const r = await executarRodadaEnriquecimento({
      modo: 'sob-demanda',
      page,
      clienteHub,
      config: { ...configFake, storageStatePath: `/tmp/sessao-teste-${process.pid}-${Date.now()}.json` },
      dormir: async () => {},
      buscarDadosPessoa: async () => {
        chamadas += 1;
        if (chamadas === 2) throw new ErroPortalTransitorio('sessão expirada no meio da rodada', 'sessao_expirada_401');
        return {};
      },
    });
    assert.equal(r.resultado, 'sucesso');
    assert.equal(r.sucessos, 3);
    assert.equal(r.renovacoesNaRodada, 1);
    assert.equal(chamadas, 4); // 3 motoristas + 1 retentativa
    assert.equal(loginTocado, false);
    assert.deepEqual(evaluates, ['_evalSondaSessao', '_evalSondaSessao', '_evalRenovarSessao']);
    assert.equal(clienteHub.chamadasAtualizar.length, 3);
  });

  // Um 401 no meio da rodada agora renova a sessão e retenta o item UMA vez
  // (teste acima). Este cobre o 401 que PERSISTE depois de renovar: aí a
  // rodada para, como antes — o item corrente fica pendente para o timer.
  test('401 mid-rodada que PERSISTE após renovar -> PARA igual antibot, item corrente NÃO é reportado', async () => {
    const itens = [{ id: 1, idExterno: 'uuid-1' }, { id: 2, idExterno: 'uuid-2' }, { id: 3, idExterno: 'uuid-3' }];
    const clienteHub = mockClienteHub({ itens });
    let chamadas = 0;
    const r = await executarRodadaEnriquecimento({
      modo: 'sob-demanda',
      page: pageComSessaoValida(),
      clienteHub,
      config: configFake,
      dormir: async () => {},
      buscarDadosPessoa: async () => {
        chamadas += 1;
        // sessao_expirada_401 classifica NAO_E_FALHA (não TRANSITORIO) em
        // taxonomia-erro.js -> comRetryTransitorio NÃO retenta, propaga na hora.
        // 2ª chamada = motorista 2; 3ª = a retentativa dele após renovar.
        if (chamadas === 2 || chamadas === 3) throw new ErroPortalTransitorio('sessão expirada no meio da rodada', 'sessao_expirada_401');
        return {};
      },
    });
    assert.equal(chamadas, 3);
    assert.equal(r.renovacoesNaRodada, 1);
    assert.equal(r.sucessos, 1);
    assert.equal(r.falhas, 0);
    assert.equal(r.parouPorAntibotOuGap, true);
    assert.equal(r.resultado, 'falha_parcial');
    assert.equal(clienteHub.chamadasAtualizar.length, 1);
    assert.equal(clienteHub.chamadasAtualizar[0].id, 1);
  });

  // 6.1.3: reaproveita comRetryTransitorio (index.js) — mesmo backoff
  // 1/5/15min, até 3 tentativas — para erros TRANSITÓRIOS (rede/5xx) na
  // busca de 1 motorista. Sucesso após retry não conta como falha do item
  // nem para a rodada.
  test('6.1.3: erro transitório (5xx) retenta com o backoff do robô e sucede sem contar como falha', async () => {
    const itens = [{ id: 1, idExterno: 'uuid-1' }];
    const clienteHub = mockClienteHub({ itens });
    let chamadas = 0;
    const dormires = [];
    const r = await executarRodadaEnriquecimento({
      modo: 'sob-demanda',
      page: pageComSessaoValida(),
      clienteHub,
      config: configFake,
      dormir: async (ms) => { dormires.push(ms); },
      buscarDadosPessoa: async () => {
        chamadas += 1;
        if (chamadas < 2) throw new ErroPortalTransitorio('5xx transitório', 'http_5xx_portal');
        return { dadosPessoais: {} };
      },
    });
    assert.equal(chamadas, 2, 'deveria tentar de novo após o erro transitório');
    assert.equal(r.sucessos, 1);
    assert.equal(r.falhas, 0);
    assert.equal(r.resultado, 'sucesso');
    assert.deepEqual(dormires, [THROTTLE_MS_ENTRE_MOTORISTAS], 'sleep do retry usa o mesmo 1º degrau do backoff (60s)');
  });

  test('SEM buscarDadosPessoa customizado -> usa a implementação real (endpoint confirmado, ACHADOS-PORTAL.md §9) e reporta sucesso', async () => {
    const itens = [{ id: 1, idExterno: 'uuid-real-1' }];
    const clienteHub = mockClienteHub({ itens });
    const corpoPessoa = {
      personalData: { fullName: 'Fulano Teste', cpf: '00000000191' },
      documentDriver: {},
      emergencyContact: {},
      lastDelivery: {},
      currentModal: {},
    };
    const r = await executarRodadaEnriquecimento({
      modo: 'sob-demanda',
      page: pageComSessaoEDados(corpoPessoa),
      clienteHub,
      config: configFake,
      dormir: async () => {},
      // buscarDadosPessoa OMITIDO -> usa buscarDadosPessoaPorUuid real (busca-pessoa-entrego.js).
    });
    assert.equal(r.resultado, 'sucesso');
    assert.equal(r.sucessos, 1);
    assert.equal(clienteHub.chamadasAtualizar[0].resultado.dados.dadosPessoais.nomeCompleto, 'Fulano Teste');
    assert.equal(clienteHub.chamadasAtualizar[0].resultado.dados.dadosPessoais.cpf, '00000000191');
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
      buscarDadosPessoa: async () => {
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
      buscarDadosPessoa: async () => { throw new Error('falha isolada'); },
    });
    assert.equal(r.resultado, 'falha_total');
    assert.equal(r.sucessos, 0);
    assert.equal(r.falhas, 1);
  });
});
