// corrigir-movimento FASE 6 — mensagem de movimento gerado pelo hub (re-render do molde).
// CORRECAO_LIB permite o controle negativo (implementacao so-ancorada).
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const lib = require(process.env.CORRECAO_LIB || '../lib/envio-massa-correcao');
const { renderizarMensagem } = require('../lib/adiantamento-mensagem');
const { corrigirPelaTela } = lib;

// Molde SEM a frase-ancora do legado: o ajuste ancorado nao acharia nada aqui.
const MODELO = 'Ola {nome}, semana {periodo_inicio} a {periodo_fim}: nota de R$ {valor}, gorjeta R$ {gorjeta}, total R$ {total}.';
const PER = { periodoInicio: '2026-09-21', periodoFim: '2026-09-27' };
const dados = (valor, gorjeta) => ({ nome: 'Joao', valor, gorjeta, total: valor + gorjeta, ...PER });

function mundo({ modeloAtual = MODELO, hub = true, mensagem1 = renderizarMensagem(MODELO, dados(500, 20)) } = {}) {
  const banco = { 10: { empresa: 6, nome: 'Joao', valor: 500, gorjeta: 20, mensagem1 } };
  const deps = {
    lerMovimento: async (id, emp) => (banco[id] && banco[id].empresa === emp ? banco[id] : null),
    lerOrigemHub: async () => (hub ? { modelo: modeloAtual, ...PER } : null),
    corrigir: async ({ movimentos }) => {
      const m = movimentos[0];
      banco[m.id].valor = m.valor;
      if (m.mensagem1) banco[m.id].mensagem1 = m.mensagem1;
      return [{ movimento_id: m.id, desfecho: 'atualizado', msg_valor_antigo: false }];
    },
  };
  return { banco, deps };
}
const req = (body) => ({ id: '10', idEmp: 6, body });

describe('6.1 movimento do hub', () => {
  test('re-renderiza o molde com o valor novo (sem frase-ancora)', async () => {
    const w = mundo();
    const r = await corrigirPelaTela(req({ valor: '300,50', motivo: 'x' }), w.deps);
    assert.equal(r.status, 200);
    assert.equal(r.body.mensagem_ajustada, true);
    assert.equal(w.banco[10].mensagem1, renderizarMensagem(MODELO, dados(300.5, 20)));
  });
  test('gorjeta corrigida tambem entra no total', async () => {
    const w = mundo();
    await corrigirPelaTela(req({ valor: 500, gorjeta: '0', motivo: 'x' }), w.deps);
    assert.equal(w.banco[10].mensagem1, renderizarMensagem(MODELO, dados(500, 0)));
  });
  test('molde editado depois da geracao => aviso e mensagem intocada', async () => {
    const w = mundo({ modeloAtual: MODELO + ' Obrigado!' });
    const antes = w.banco[10].mensagem1;
    const r = await corrigirPelaTela(req({ valor: 300, motivo: 'x' }), w.deps);
    assert.equal(r.status, 200);
    assert.equal(r.body.mensagem_ajustada, false);
    assert.ok(r.body.aviso);
    assert.equal(w.banco[10].mensagem1, antes);
  });
  test('molde ausente ou com placeholder invalido => aviso, sem lancar', async () => {
    for (const modeloAtual of [null, 'oi {cpf}']) {
      const w = mundo({ modeloAtual });
      const r = await corrigirPelaTela(req({ valor: 300, motivo: 'x' }), w.deps);
      assert.equal(r.body.mensagem_ajustada, false);
    }
  });
  test('movimento de planilha segue pelo caminho ancorado', async () => {
    const msg = 'O valor total para emissão da NF é de R$242,24. O valor de gorjetas é de R$0,00.';
    const w = mundo({ hub: false, mensagem1: msg });
    const r = await corrigirPelaTela(req({ valor: '300,50', motivo: 'x' }), w.deps);
    assert.equal(r.body.mensagem_ajustada, true);
    assert.ok(w.banco[10].mensagem1.includes('R$300,50'));
  });
});
