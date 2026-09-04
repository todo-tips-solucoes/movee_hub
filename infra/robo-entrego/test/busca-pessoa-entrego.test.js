// test/busca-pessoa-entrego.test.js (hub-motorista-360 FASE 5, tasks.md
// 5.3.2) — mock de `page` (interface .url/.goto/.evaluate, mesma técnica de
// test/entrego-portal.test.js#mockPageEvaluate), sem Playwright real nem
// HTTP real. Todos os valores de PII abaixo são SINTÉTICOS/claramente
// falsos (CPF/RG/CNH em sequência, nomes "Teste"/"Exemplo", domínio
// .invalid) — nunca dado real capturado do portal (regra dura da sessão).
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { ErroAntibotSuspeito, ErroPortalTransitorio, HEADERS_API } = require('../src/entrego-portal');
const { buscarDadosPessoaPorUuid, mapearParaShapeInterno } = require('../src/busca-pessoa-entrego');

// Mesmo padrão de test/entrego-portal.test.js#mockPageEvaluate.
function mockPageEvaluate(retorno, { urlAtual = 'https://franqueado.entregolog.com/' } = {}) {
  const gotos = [];
  return {
    gotos,
    url: () => urlAtual,
    goto: async (u) => { gotos.push(u); urlAtual = u; },
    evaluate: async (fn, args) => (typeof retorno === 'function' ? retorno(fn, args) : retorno),
  };
}

// ACHADOS-PORTAL.md §9.5.3, Caso A: modal BICYCLE — rg presente, cnh e
// fatherName AUSENTES. Inclui as 4 chaves de foto (dec-072 exige que sejam
// descartadas na saída, nunca que estejam ausentes na ENTRADA).
const PAYLOAD_MODAL_BICYCLE = Object.freeze({
  uuid: '11111111-1111-1111-1111-111111111111',
  personalData: {
    fullName: 'Fulano De Tal Teste',
    birthdate: '1990-01-15',
    email: 'fulano.teste@example.invalid',
    cpf: '00000000191',
    motherName: 'Ciclana De Tal Mae Teste',
    phone: '(11) 90000-0000',
    // fatherName AUSENTE — medido no Caso A.
  },
  documentDriver: {
    rg: '000000000-SP',
    identityDocumentFrontPhoto: 'https://fake-cdn.example.invalid/doc-frente.jpg',
    identityDocumentBackPhoto: 'https://fake-cdn.example.invalid/doc-verso.jpg',
    workerPhoto: 'https://fake-cdn.example.invalid/foto-trabalhador.jpg',
    // cnh e driverLicensePhoto AUSENTES — medido no Caso A.
  },
  emergencyContact: { name: 'Contato Emergencia Teste', phone: '(11) 90000-0001', relationship: 'SPOUSE' },
  lastDelivery: { logisticOperatorName: 'FRANQUIA_MOVEE_SP', possibleModals: ['BICYCLE'], region: '' },
  currentModal: { modalName: 'BICYCLE', modalUuid: '22222222-2222-2222-2222-222222222222' },
  quality: { cashOnDeliveryEnabled: true, reasonInactivation: null },
});

// ACHADOS-PORTAL.md §9.5.3, Caso B: modal MOTORCYCLE — cnh e fatherName
// presentes, rg AUSENTE. Forma DIFERENTE do Caso A (chaves distintas) —
// prova de que o mapeamento não assume um shape fixo de documentDriver.
const PAYLOAD_MODAL_MOTORCYCLE = Object.freeze({
  uuid: '33333333-3333-3333-3333-333333333333',
  personalData: {
    fullName: 'Beltrano Exemplo Teste',
    birthdate: '1988-07-22',
    email: 'beltrano.teste@example.invalid',
    cpf: '00000000272',
    motherName: 'Sicrana Exemplo Mae Teste',
    fatherName: 'Ciclano Exemplo Pai Teste',
    phone: '(21) 90000-0002',
  },
  documentDriver: {
    cnh: '00000000003',
    driverLicensePhoto: 'https://fake-cdn.example.invalid/cnh.jpg',
    workerPhoto: 'https://fake-cdn.example.invalid/foto-trabalhador-2.jpg',
    // rg e identityDocumentFrontPhoto/BackPhoto AUSENTES — medido no Caso B.
  },
  emergencyContact: { name: 'Contato Emergencia Dois', phone: '(21) 90000-0003', relationship: 'SPOUSE' },
  lastDelivery: { logisticOperatorName: 'FRANQUIA_MOVEE_RJ', possibleModals: ['MOTORCYCLE'], region: '' },
  currentModal: { modalName: 'MOTORCYCLE', modalUuid: '44444444-4444-4444-4444-444444444444' },
  quality: { cashOnDeliveryEnabled: false, reasonInactivation: null },
});

const TODAS_URLS_DE_FOTO = [
  'https://fake-cdn.example.invalid/doc-frente.jpg',
  'https://fake-cdn.example.invalid/doc-verso.jpg',
  'https://fake-cdn.example.invalid/foto-trabalhador.jpg',
  'https://fake-cdn.example.invalid/cnh.jpg',
  'https://fake-cdn.example.invalid/foto-trabalhador-2.jpg',
];

describe('mapearParaShapeInterno — ACHADOS-PORTAL.md §9.4/§9.5.3', () => {
  test('Caso A (modal BICYCLE): mapeia campos presentes, null para fatherName/cnh ausentes', () => {
    assert.deepEqual(mapearParaShapeInterno(PAYLOAD_MODAL_BICYCLE), {
      dadosPessoais: {
        nomeCompleto: 'Fulano De Tal Teste',
        dataNascimento: '1990-01-15',
        email: 'fulano.teste@example.invalid',
        cpf: '00000000191',
        nomeMae: 'Ciclana De Tal Mae Teste',
        nomePai: null,
        telefone: '(11) 90000-0000',
      },
      documentos: { rg: '000000000-SP', cnh: null },
      contatoEmergencia: { grauParentesco: 'SPOUSE', nome: 'Contato Emergencia Teste', telefone: '(11) 90000-0001' },
      informacoesEntrega: { operadorLogistico: 'FRANQUIA_MOVEE_SP', modal: 'BICYCLE' },
    });
  });

  test('Caso B (modal MOTORCYCLE): rg ausente -> null, cnh/fatherName presentes -> mapeados', () => {
    assert.deepEqual(mapearParaShapeInterno(PAYLOAD_MODAL_MOTORCYCLE), {
      dadosPessoais: {
        nomeCompleto: 'Beltrano Exemplo Teste',
        dataNascimento: '1988-07-22',
        email: 'beltrano.teste@example.invalid',
        cpf: '00000000272',
        nomeMae: 'Sicrana Exemplo Mae Teste',
        nomePai: 'Ciclano Exemplo Pai Teste',
        telefone: '(21) 90000-0002',
      },
      documentos: { rg: null, cnh: '00000000003' },
      contatoEmergencia: { grauParentesco: 'SPOUSE', nome: 'Contato Emergencia Dois', telefone: '(21) 90000-0003' },
      informacoesEntrega: { operadorLogistico: 'FRANQUIA_MOVEE_RJ', modal: 'MOTORCYCLE' },
    });
  });

  // dec-072 (instrução literal do operador): nenhuma URL de foto sobrevive
  // ao mapeamento, em NENHUM dos 2 casos medidos — allowlist, nunca denylist.
  test('dec-072: nenhuma das 4 chaves/URLs de foto aparece no objeto mapeado (nem Caso A, nem Caso B)', () => {
    const mapeadoA = mapearParaShapeInterno(PAYLOAD_MODAL_BICYCLE);
    const mapeadoB = mapearParaShapeInterno(PAYLOAD_MODAL_MOTORCYCLE);
    const chavesDeFoto = ['identityDocumentFrontPhoto', 'identityDocumentBackPhoto', 'driverLicensePhoto', 'workerPhoto'];
    for (const mapeado of [mapeadoA, mapeadoB]) {
      const serializado = JSON.stringify(mapeado);
      for (const chave of chavesDeFoto) {
        assert.equal(serializado.includes(chave), false, `chave de foto "${chave}" vazou para o shape interno`);
      }
      for (const url of TODAS_URLS_DE_FOTO) {
        assert.equal(serializado.includes(url), false, `URL de foto "${url}" vazou para o shape interno`);
      }
    }
  });

  test('campos ausentes de emergencyContact/lastDelivery/currentModal também viram null (defesa, não medido nos 2 casos)', () => {
    assert.deepEqual(mapearParaShapeInterno({}), {
      dadosPessoais: { nomeCompleto: null, dataNascimento: null, email: null, cpf: null, nomeMae: null, nomePai: null, telefone: null },
      documentos: { rg: null, cnh: null },
      contatoEmergencia: { grauParentesco: null, nome: null, telefone: null },
      informacoesEntrega: { operadorLogistico: null, modal: null },
    });
  });
});

describe('buscarDadosPessoaPorUuid — ACHADOS-PORTAL.md §9.3 (endpoint confirmado)', () => {
  test('about:blank -> navega para o portal ANTES de chamar a API (mesma guarda de sondarSessaoValida)', async () => {
    const page = mockPageEvaluate({ status: 200, contentType: 'application/json', corpo: PAYLOAD_MODAL_BICYCLE }, { urlAtual: 'about:blank' });
    await buscarDadosPessoaPorUuid(page, { uuid: PAYLOAD_MODAL_BICYCLE.uuid });
    assert.deepEqual(page.gotos, ['https://franqueado.entregolog.com']);
  });

  test('já na origem do portal -> NÃO navega de novo', async () => {
    const page = mockPageEvaluate(
      { status: 200, contentType: 'application/json', corpo: PAYLOAD_MODAL_BICYCLE },
      { urlAtual: 'https://franqueado.entregolog.com/supply/driver-list' }
    );
    await buscarDadosPessoaPorUuid(page, { uuid: PAYLOAD_MODAL_BICYCLE.uuid });
    assert.deepEqual(page.gotos, []);
  });

  test('chama /operation/logistics-operator/drivers/{uuid} com os headers do BFF (§9.3) e credentials:include implícito no evaluate real', async () => {
    let argsRecebidos;
    const page = mockPageEvaluate((fn, args) => {
      argsRecebidos = args;
      return { status: 200, contentType: 'application/json', corpo: PAYLOAD_MODAL_BICYCLE };
    });
    await buscarDadosPessoaPorUuid(page, { uuid: PAYLOAD_MODAL_BICYCLE.uuid });
    assert.equal(argsRecebidos.uuid, PAYLOAD_MODAL_BICYCLE.uuid);
    assert.deepEqual(argsRecebidos.headers, HEADERS_API);
    assert.equal(argsRecebidos.headers['X-IFood-Logistics-Auth'], 'true');
    assert.equal(argsRecebidos.headers['x-cookie-login'], 'true');
  });

  test('200 + JSON válido -> retorna o shape interno mapeado (Caso A)', async () => {
    const page = mockPageEvaluate({ status: 200, contentType: 'application/json', corpo: PAYLOAD_MODAL_BICYCLE });
    const resultado = await buscarDadosPessoaPorUuid(page, { uuid: PAYLOAD_MODAL_BICYCLE.uuid });
    assert.deepEqual(resultado, mapearParaShapeInterno(PAYLOAD_MODAL_BICYCLE));
  });

  test('200 + JSON válido -> retorna o shape interno mapeado (Caso B, forma diferente de documentDriver)', async () => {
    const page = mockPageEvaluate({ status: 200, contentType: 'application/json', corpo: PAYLOAD_MODAL_MOTORCYCLE });
    const resultado = await buscarDadosPessoaPorUuid(page, { uuid: PAYLOAD_MODAL_MOTORCYCLE.uuid });
    assert.deepEqual(resultado, mapearParaShapeInterno(PAYLOAD_MODAL_MOTORCYCLE));
  });

  test('401 -> ErroPortalTransitorio sinal sessao_expirada_401', async () => {
    const page = mockPageEvaluate({ status: 401, contentType: 'application/json', corpo: {} });
    await assert.rejects(
      () => buscarDadosPessoaPorUuid(page, { uuid: 'x' }),
      (e) => e instanceof ErroPortalTransitorio && e.sinal === 'sessao_expirada_401'
    );
  });

  test('5xx -> ErroPortalTransitorio sinal http_5xx_portal', async () => {
    const page = mockPageEvaluate({ status: 503, contentType: 'application/json', corpo: {} });
    await assert.rejects(
      () => buscarDadosPessoaPorUuid(page, { uuid: 'x' }),
      (e) => e instanceof ErroPortalTransitorio && e.sinal === 'http_5xx_portal'
    );
  });

  test('exceção de rede no evaluate -> ErroPortalTransitorio sinal erro_conexao', async () => {
    const page = { url: () => 'https://franqueado.entregolog.com/', evaluate: async () => { throw new Error('net::ERR_CONNECTION_RESET'); } };
    await assert.rejects(
      () => buscarDadosPessoaPorUuid(page, { uuid: 'x' }),
      (e) => e instanceof ErroPortalTransitorio && e.sinal === 'erro_conexao'
    );
  });

  test('navegação para o portal falha -> ErroPortalTransitorio sinal erro_conexao', async () => {
    const page = { url: () => 'about:blank', goto: async () => { throw new Error('net::ERR_TIMED_OUT'); } };
    await assert.rejects(
      () => buscarDadosPessoaPorUuid(page, { uuid: 'x' }),
      (e) => e instanceof ErroPortalTransitorio && e.sinal === 'erro_conexao'
    );
  });

  test('resposta é HTML (não JSON) -> ErroAntibotSuspeito, nunca retry transitório', async () => {
    const page = mockPageEvaluate({ status: 200, contentType: 'text/html', corpo: '<html>challenge</html>' });
    await assert.rejects(() => buscarDadosPessoaPorUuid(page, { uuid: 'x' }), ErroAntibotSuspeito);
  });

  test('status inesperado (ex.: 403) -> ErroAntibotSuspeito', async () => {
    const page = mockPageEvaluate({ status: 403, contentType: 'application/json', corpo: {} });
    await assert.rejects(() => buscarDadosPessoaPorUuid(page, { uuid: 'x' }), ErroAntibotSuspeito);
  });

  test('200 mas corpo não é objeto (ex.: array/null) -> ErroAntibotSuspeito', async () => {
    const page = mockPageEvaluate({ status: 200, contentType: 'application/json', corpo: null });
    await assert.rejects(() => buscarDadosPessoaPorUuid(page, { uuid: 'x' }), ErroAntibotSuspeito);
  });
});
