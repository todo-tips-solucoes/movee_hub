// corrigir-movimento — defeitos da revisao adversarial (C1..C5). CORRECAO_LIB aponta para a lib SEM as correcoes
// (controle negativo). C6 (btrim) e a prova de C5 no banco vivem em envio-massa-correcao-db-integration.test.js.
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const lib = require(process.env.CORRECAO_LIB || '../lib/envio-massa-correcao');
const { reimportar, corrigirPelaTela, ajustarMensagem, criarDepsCorrecao } = lib;

const INI = '2026-09-01T03:00:00-03:00';
const FIM = '2026-09-07T03:00:00-03:00';
const C1 = '11222333000181';
const MSG = (v) => `Ola. O valor total para emissao da NF e de R$ ${v}. Obrigado.`;

function mundo(seed = {}) {
  const banco = [{ id: 1, cnpj_prestador: C1, valor: 242.24, gorjeta: 35.5, mensagem1: MSG('242,24'), uuid: 'u1', ...seed }];
  const enviados = [];
  const deps = {
    buscarExistentes: async () => banco,
    corrigir: async ({ movimentos }) => {
      enviados.push(...movimentos);
      return movimentos.map((m) => {
        const r = banco.find((x) => x.id === m.id);
        if ('gorjeta' in m) r.gorjeta = m.gorjeta;
        r.valor = m.valor;
        if (m.mensagem1) r.mensagem1 = m.mensagem1;
        return { movimento_id: m.id, desfecho: 'atualizado', msg_valor_antigo: false };
      });
    },
    inserir: async () => {},
  };
  return { banco, enviados, deps };
}
const run = (w, linha, extra = {}) => reimportar(
  { linhas: [{ cnpj_prestador: C1, uuid: 'u1', gorjeta: null, ...linha }], idEmp: 6, dtIni: INI, dtFim: FIM, motivo: 'corrigido', ...extra }, w.deps);

describe('C1 mensagem1 da planilha divergente do valor', () => {
  test('so o valor mudou na planilha: a mensagem e ajustada ao valor novo', async () => {
    const w = mundo();
    const r = await run(w, { valor: '300.00', gorjeta: 35.5, mensagem1: MSG('242,24') });
    assert.equal(r.status, 200);
    assert.equal(w.banco[0].mensagem1, MSG('300,00'));
    assert.equal(r.body.resumo.mensagem_divergente, 0);
  });
  test('divergencia que nao da para ajustar (2 ancoras) => contada no resumo', async () => {
    const w = mundo();
    const dupla = `${MSG('242,24')} ${MSG('242,24')}`;
    const r = await run(w, { valor: '300.00', gorjeta: 35.5, mensagem1: dupla });
    assert.equal(r.body.resumo.mensagem_divergente, 1);
  });
  test('mensagem coerente com o valor nao e tocada nem contada', async () => {
    const w = mundo();
    const r = await run(w, { valor: '300.00', gorjeta: 35.5, mensagem1: MSG('300,00') });
    assert.equal(w.banco[0].mensagem1, MSG('300,00'));
    assert.equal(r.body.resumo.mensagem_divergente, 0);
  });
});

describe('C2 coluna gorjeta ausente nao apaga a gorjeta', () => {
  test('temColunaGorjeta:false => a chave gorjeta nem vai e o valor gravado fica', async () => {
    const w = mundo();
    await run(w, { valor: '300.00' }, { temColunaGorjeta: false });
    assert.ok(!('gorjeta' in w.enviados[0]));
    assert.equal(w.banco[0].gorjeta, 35.5);
  });
  test('coluna presente e celula vazia continua zerando (FR-003)', async () => {
    const w = mundo();
    await run(w, { valor: '242.24', gorjeta: null }, { temColunaGorjeta: true });
    assert.equal(w.banco[0].gorjeta, null);
  });
  test('sem coluna e so a gorjeta difere => nao exige motivo (nada mudaria)', async () => {
    const w = mundo();
    const r = await run(w, { valor: '242.24' }, { temColunaGorjeta: false, motivo: '' });
    assert.equal(r.status, 200);
  });
  test('server.js passa o resultado da leitura do cabecalho', () => {
    const src = require('node:fs').readFileSync(require.resolve('../server.js'), 'utf8');
    assert.match(src, /temColunaGorjeta/);
    assert.match(src, /cabecalho\.includes\('gorjeta'\)/);
  });
});

describe('C3 tela arredonda a 2 casas como a importacao', () => {
  test('1234,567 grava 1234.57 (e gorjeta idem)', async () => {
    let enviado;
    const deps = { lerMovimento: async () => ({ nome: 'x', valor: 1, gorjeta: 0, mensagem1: MSG('1,00') }),
      corrigir: async ({ movimentos }) => { enviado = movimentos[0]; return [{ movimento_id: 1, desfecho: 'atualizado' }]; } };
    await corrigirPelaTela({ id: '1', idEmp: 6, body: { valor: '1234,567', gorjeta: '10,004', motivo: 'x' } }, deps);
    assert.equal(enviado.valor, 1234.57);
    assert.equal(enviado.gorjeta, 10);
  });
});

describe('C4 ancora nao casa numero parcial', () => {
  test('"242.24" (ponto, sem virgula) => ajustada:false e texto intocado', () => {
    const t = 'O valor total para emissao da NF e de R$ 242.24. Obrigado.';
    const r = ajustarMensagem(t, { valor: 1000 });
    assert.equal(r.ajustada, false);
    assert.equal(r.texto, t);
  });
  test('numero completo seguido de ponto final continua casando', () => {
    const r = ajustarMensagem('O valor total para emissao da NF e de R$ 242,24. Obrigado.', { valor: 1000 });
    assert.equal(r.ajustada, true);
    assert.match(r.texto, /R\$ 1\.000,00\. Obrigado/);
  });
});

describe('C5 lerOrigemHub assina as claims de escopo', () => {
  test('as 3 leituras vao com escopo [emp] e empresa_ativa, pelo cliente do hub', async () => {
    const chamadas = [];
    const respostas = { ApuracaoRepasseMovimento: [{ apuracao_id: 7 }], ApuracaoRepasse: [{ periodo_inicio: 'a', periodo_fim: 'b' }],
      AdiantamentoConfiguracao: [{ mensagem1_modelo: 'oi' }] };
    const hub = async (endpoint, method, body, claims) => {
      chamadas.push({ endpoint, claims });
      return respostas[Object.keys(respostas).find((k) => endpoint.startsWith(k))];
    };
    const legado = async () => { throw new Error('legado nao pode ser usado para a trilha'); };
    const o = await criarDepsCorrecao(legado, hub).lerOrigemHub('10', 6);
    assert.deepEqual(o, { modelo: 'oi', periodoInicio: 'a', periodoFim: 'b' });
    assert.equal(chamadas.length, 3);
    for (const c of chamadas) assert.deepEqual(c.claims, { empresaAtiva: 6, escopo: [6] });
  });
});
