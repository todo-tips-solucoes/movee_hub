const test = require('node:test');
const assert = require('node:assert');
const { planejarGeracao } = require('../lib/adiantamento-geracao-movimento');

const CTX = {
  cnpjTomador: '48904673000100', idEmpresa: 6,
  periodoInicio: '2026-09-21', periodoFim: '2026-09-27',
  mensagem1Modelo: 'Ola {nome}, emita nota de {valor}.',
  mensagem2Modelo: 'Gorjeta {gorjeta}, total {total}.',
};
const conta = (over = {}) => ({ cnpjPrestador: '89000000000100', nome: 'Fulano', telefone: '5511900000001', ...over });
const item = (over = {}) => ({ entregador_id: 1, creditos: '500.00', valor_nota: '480.00', valor_fora_nota: '20.00', ...over });
const planejar = (itens, contas, jaGerados = [], abertos = []) =>
  planejarGeracao(itens, new Map(contas), new Set(jaGerados), new Set(abertos), CTX);

test.describe('planejarGeracao() — o que vira movimento (F4-B)', () => {
  test('caso feliz: valor = base da nota, gorjeta = o que fica fora', () => {
    const { aGerar, recusados } = planejar([item()], [[1, conta()]]);
    assert.equal(recusados.length, 0);
    assert.equal(aGerar.length, 1);
    const l = aGerar[0].linha;
    assert.equal(l.valor, 480);
    assert.equal(l.gorjeta, 20);
    assert.equal(l.cnpj_prestador, '89000000000100');
    assert.equal(l.dt_inicial, '2026-09-21');
    assert.equal(l.enviado, 'off');
    assert.equal(l.mov_fechado, false);
  });

  // O ponto da F4 inteira: a nota NÃO inclui a gorjeta, mas o motorista recebe
  // os dois. Se esta asserção cair, a nota sai pelo valor errado.
  test('a gorjeta NUNCA entra no `valor` da nota', () => {
    const { aGerar } = planejar([item()], [[1, conta()]]);
    assert.equal(aGerar[0].linha.valor, 480);
    assert.notEqual(aGerar[0].linha.valor, 500);
    assert.equal(aGerar[0].linha.valor + aGerar[0].linha.gorjeta, 500);
  });

  test('sem gorjeta, o campo vai NULO — como a planilha grava (CL-002)', () => {
    const { aGerar } = planejar([item({ valor_fora_nota: '0.00' })], [[1, conta()]]);
    assert.equal(aGerar[0].linha.gorjeta, null);
  });

  test('as mensagens saem renderizadas com os valores do motorista', () => {
    const { aGerar } = planejar([item()], [[1, conta()]]);
    assert.equal(aGerar[0].linha.mensagem1, 'Ola Fulano, emita nota de 480,00.');
    assert.equal(aGerar[0].linha.mensagem2, 'Gorjeta 20,00, total 500,00.');
  });

  test('sem telefone GERA assim mesmo, marcado no relatório (decisão do operador)', () => {
    const { aGerar, recusados } = planejar([item()], [[1, conta({ telefone: null })]]);
    assert.equal(recusados.length, 0);
    assert.equal(aGerar[0].semTelefone, true);
    assert.equal(aGerar[0].linha.number, null);
  });
});

test.describe('planejarGeracao() — as recusas, cada uma com motivo próprio', () => {
  test('sem CNPJ no hub', () => {
    const { aGerar, recusados } = planejar([item()], []);
    assert.equal(aGerar.length, 0);
    assert.equal(recusados[0].motivo, 'SEM_CNPJ');
  });

  test('apuração fechada antes de "entra na nota" existir', () => {
    const { recusados } = planejar([item({ valor_nota: null, valor_fora_nota: null })], [[1, conta()]]);
    assert.equal(recusados[0].motivo, 'SEM_DIVISAO');
  });

  test('base da nota zero não vira nota', () => {
    const { recusados } = planejar([item({ valor_nota: '0.00' })], [[1, conta()]]);
    assert.equal(recusados[0].motivo, 'VALOR_ZERO');
  });

  test('já gerado nesta apuração — idempotência', () => {
    const { aGerar, recusados } = planejar([item()], [[1, conta()]], [1]);
    assert.equal(aGerar.length, 0);
    assert.equal(recusados[0].motivo, 'JA_GERADO');
  });

  test('já tem movimento aberto (planilha) — convivência, decisão 7', () => {
    const { aGerar, recusados } = planejar([item()], [[1, conta()]], [], ['89000000000100']);
    assert.equal(aGerar.length, 0);
    assert.equal(recusados[0].motivo, 'MOVIMENTO_ABERTO');
  });

  // A ordem importa: se o hub já gerou e o movimento foi fechado depois, o
  // motivo certo é JA_GERADO. Invertê-la faria a trilha parecer vazia.
  test('já gerado vence movimento aberto no motivo relatado', () => {
    const { recusados } = planejar([item()], [[1, conta()]], [1], ['89000000000100']);
    assert.equal(recusados[0].motivo, 'JA_GERADO');
  });

  test('cada recusa traz nome e explicação legível', () => {
    const { recusados } = planejar([item()], [[1, conta()]], [1]);
    assert.equal(recusados[0].nome, 'Fulano');
    assert.match(recusados[0].detalhe, /já gerou/);
  });
});

test.describe('planejarGeracao() — lote', () => {
  test('separa quem gera de quem não, sem perder ninguém', () => {
    const itens = [item({ entregador_id: 1 }), item({ entregador_id: 2 }), item({ entregador_id: 3, valor_nota: null })];
    const contas = [[1, conta()], [2, conta({ cnpjPrestador: '89000000000200' })], [3, conta()]];
    const { aGerar, recusados } = planejar(itens, contas, [], ['89000000000200']);
    assert.equal(aGerar.length, 1);
    assert.equal(recusados.length, 2);
    assert.equal(aGerar.length + recusados.length, itens.length);
  });
});
