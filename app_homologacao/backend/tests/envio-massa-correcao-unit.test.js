// corrigir-movimento FASES 2-3 — helpers puros + caminho da tela.
// CORRECAO_LIB permite rodar o MESMO arquivo contra uma implementacao ingenua (controle negativo).
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lib = require(process.env.CORRECAO_LIB || '../lib/envio-massa-correcao');
const { casarLinha, resumir, ajustarMensagem, corrigirPelaTela } = lib;

const MSG = 'Prezado, NF 02461 CEP 04726-170 CNPJ 48.904.673/0001-00. O valor total para emissão da NF é de R$242,24. O valor de gorjetas é de R$0,00. Obrigado.';

describe('2.2 casamento', () => {
  const ex = [
    { id: 1, uuid: 'a', cnpj_prestador: '11222333000181' },
    { id: 2, uuid: 'b', cnpj_prestador: '99888777000166' },
  ];
  test('uuid que casa', () => assert.deepEqual(casarLinha({ uuid: 'b', cnpj_prestador: '11222333000181' }, ex), { acao: 'atualizar', id: 2 }));
  test('uuid inexistente cai no fallback por cnpj', () => assert.deepEqual(casarLinha({ uuid: 'zzz', cnpj_prestador: '11.222.333/0001-81' }, ex), { acao: 'atualizar', id: 1 }));
  test('sem uuid usa fallback', () => assert.equal(casarLinha({ cnpj_prestador: '99888777000166' }, ex).id, 2));
  test('uuid instavel entre planilhas: nao assume', () => assert.equal(casarLinha({ uuid: 'novo-da-outra-planilha', cnpj_prestador: '99888777000166' }, ex).id, 2));
  test('ambigua pelo fallback', () => {
    const r = casarLinha({ cnpj_prestador: '11222333000181' }, [...ex, { id: 3, uuid: 'c', cnpj_prestador: '11222333000181' }]);
    assert.deepEqual(r, { acao: 'ambiguo', candidatos: [1, 3] });
  });
  test('sem correspondente: criar; semUuid sinaliza', () => {
    assert.deepEqual(casarLinha({ cnpj_prestador: '00000000000000' }, ex), { acao: 'criar', semUuid: true });
    assert.deepEqual(casarLinha({ uuid: 'q', cnpj_prestador: '00000000000000' }, ex), { acao: 'criar', semUuid: false });
  });
});

describe('2.2.2 resumo', () => {
  test('soma == total', () => {
    const r = resumir(['criados', 'atualizados', 'atualizados', 'ambiguos'], 4, 1);
    assert.equal(r.atualizados, 2); assert.equal(r.mensagem_valor_antigo, 1);
  });
  test('linha nao contabilizada derruba, nao some', () => assert.throws(() => resumir(['criados'], 2)));
  test('desfecho desconhecido derruba', () => assert.throws(() => resumir(['nao_encontrado'], 1)));
});

describe('2.3 ajuste ancorado', () => {
  test('troca so o valor da NF', () => {
    const r = ajustarMensagem(MSG, { valor: 300.5 });
    assert.equal(r.ajustada, true);
    assert.equal(r.texto, MSG.replace('R$242,24', 'R$300,50'));
  });
  test('nao toca gorjeta, CNPJ, CEP nem codigos', () => {
    const r = ajustarMensagem(MSG, { valor: 1 });
    for (const t of ['R$0,00', '04726-170', '48.904.673/0001-00', '02461']) assert.ok(r.texto.includes(t), t);
  });
  test('R$ de outro campo ANTES da ancora nao e tocado', () => {
    const m = 'Taxa R$10,00 do servico 1.0703.00.00. O valor total para emissão da NF é de R$242,24.';
    assert.equal(ajustarMensagem(m, { valor: 7 }).texto, 'Taxa R$10,00 do servico 1.0703.00.00. O valor total para emissão da NF é de R$7,00.');
  });
  test('mesma grafia com espaco e R$ -', () => {
    const m = 'O valor total para emissao da NF e de R$ 21,20. O valor de gorjetas é de R$ -.';
    const r = ajustarMensagem(m, { valor: 50, gorjeta: 5 });
    assert.equal(r.texto, 'O valor total para emissao da NF e de R$ 50,00. O valor de gorjetas é de R$ 5,00.');
    assert.equal(ajustarMensagem(m, { valor: 50, gorjeta: null }).texto.includes('gorjetas é de R$ -.'), true);
  });
  test('ancora ausente => ajustada:false e texto intacto', () => {
    const r = ajustarMensagem('Pague R$100,00 e R$5,00', { valor: 9 });
    assert.deepEqual(r, { texto: 'Pague R$100,00 e R$5,00', ajustada: false });
  });
  test('ancora duplicada => ajustada:false', () => assert.equal(ajustarMensagem(MSG + ' ' + MSG, { valor: 9 }).ajustada, false));
});

// ── 3.2 caminho da tela ──
function mundo({ linhas, desfecho = 'atualizado', msgAntiga = false, falha = false } = {}) {
  const banco = linhas || { 10: { empresa: 6, mensagem1: MSG, valor: 242.24 } };
  const chamadas = { corrigir: [], lerMovimento: [] };
  const deps = {
    lerMovimento: async (id, emp) => { chamadas.lerMovimento.push([id, emp]); const l = banco[id]; return l && l.empresa === emp ? l : null; },
    corrigir: async (a) => {
      chamadas.corrigir.push(a);
      if (falha) throw new Error('boom');
      const m = a.movimentos[0]; const l = banco[m.id];
      if (!l || l.empresa !== a.idEmp) return [{ desfecho: 'nao_encontrado' }];
      if (desfecho === 'atualizado') { l.valor = m.valor; if (m.mensagem1) l.mensagem1 = m.mensagem1; }
      return [{ movimento_id: m.id, desfecho, msg_valor_antigo: msgAntiga }];
    },
  };
  return { banco, chamadas, deps };
}
const req = (body, idEmp = 6, id = '10') => ({ id, idEmp, body });

describe('3.2 correcao pela tela', () => {
  test('grava e a releitura mostra o valor novo, mensagem ajustada', async () => {
    const w = mundo();
    const r = await corrigirPelaTela(req({ valor: '300,50', motivo: 'erro de digitacao' }), w.deps);
    assert.equal(r.status, 200); assert.deepEqual(r.body, { resultado: 'atualizado', mensagem_ajustada: true });
    assert.equal(w.banco[10].valor, 300.5);
    assert.ok(w.banco[10].mensagem1.includes('R$300,50'));
  });
  test('sem motivo => 400 e nenhuma escrita', async () => {
    const w = mundo();
    for (const m of [undefined, '', '   ']) {
      const r = await corrigirPelaTela(req({ valor: 5, motivo: m }), w.deps);
      assert.equal(r.status, 400);
    }
    assert.equal(w.chamadas.corrigir.length, 0);
  });
  test('valor nao numerico/negativo => 400, sem escrita', async () => {
    const w = mundo();
    for (const v of ['abc', '', null, -1]) assert.equal((await corrigirPelaTela(req({ valor: v, motivo: 'x' }), w.deps)).status, 400);
    assert.equal(w.chamadas.corrigir.length, 0);
  });
  test('nota enviada => 409 e valor preservado, sem "atualizado"', async () => {
    const w = mundo({ desfecho: 'pulado_nota_enviada' });
    const r = await corrigirPelaTela(req({ valor: 9, motivo: 'x' }), w.deps);
    assert.equal(r.status, 409); assert.equal(r.body.resultado, 'pulado_nota_enviada');
    assert.equal(w.banco[10].valor, 242.24);
  });
  test('fechado => 409; inalterado => 200 inalterado', async () => {
    assert.equal((await corrigirPelaTela(req({ valor: 9, motivo: 'x' }), mundo({ desfecho: 'pulado_mov_fechado' }).deps)).status, 409);
    const r = await corrigirPelaTela(req({ valor: 9, motivo: 'x' }), mundo({ desfecho: 'inalterado' }).deps);
    assert.deepEqual(r, { status: 200, body: { resultado: 'inalterado' } });
  });
  test('ancora ausente => 200 com aviso e mensagem_ajustada:false (sem mensagem1 no envio)', async () => {
    const w = mundo({ linhas: { 10: { empresa: 6, mensagem1: 'texto livre', valor: 1 } } });
    const r = await corrigirPelaTela(req({ valor: 5, motivo: 'x' }), w.deps);
    assert.equal(r.body.mensagem_ajustada, false); assert.ok(r.body.aviso);
    assert.equal('mensagem1' in w.chamadas.corrigir[0].movimentos[0], false);
  });
  test('mensagem ja enviada com valor antigo e informada', async () => {
    const r = await corrigirPelaTela(req({ valor: 5, motivo: 'x' }), mundo({ msgAntiga: true }).deps);
    assert.equal(r.body.mensagem_valor_antigo, true);
  });
  test('falha de RPC propaga (chamador responde 500), nunca sucesso', async () => {
    await assert.rejects(corrigirPelaTela(req({ valor: 5, motivo: 'x' }), mundo({ falha: true }).deps));
  });
  test('outra empresa => 404 e nada gravado (CHK019: filtro de empresa e a unica fronteira)', async () => {
    const w = mundo();
    const r = await corrigirPelaTela(req({ valor: 5, motivo: 'x' }, 7), w.deps);
    assert.equal(r.status, 404); assert.equal(w.banco[10].valor, 242.24);
    assert.equal(w.chamadas.corrigir.length, 0);
  });
  test('mass assignment: so valor/gorjeta/mensagem1 chegam ao banco; empresa so do parametro', async () => {
    const w = mundo();
    await corrigirPelaTela(req({
      valor: 5, motivo: 'x', numnota: 'N1', nota_ok: 'S', erro_validacao: '', mov_fechado: false,
      dt_inicial: '2020-01-01', id_empresa: 99, empresa_id: 99, mensagem1: 'INJETADO',
    }), w.deps);
    const a = w.chamadas.corrigir[0];
    assert.equal(a.idEmp, 6);
    assert.deepEqual(Object.keys(a.movimentos[0]).sort(), ['id', 'mensagem1', 'valor']);
    assert.notEqual(a.movimentos[0].mensagem1, 'INJETADO');
  });
});

describe('3.1 fiacao do server.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = src.indexOf("app.patch('/update-envio-massa/:id'");
  const rota = src.slice(i, src.indexOf("app.delete('/envio-massa/:id'"));
  test('a rota usa corrigirPelaTela e nunca repassa req.body', () => {
    assert.ok(rota.includes('corrigirPelaTela('));
    assert.ok(!/\.\.\.\s*req\.body/.test(rota));
    assert.ok(!/postgrestRequest\([^)]*req\.body\s*\)/.test(rota));
  });
  test('a rota passa idEmp de resolveEmpresaAlvo e as deps reais (comportamento: bloco abaixo)', () => {
    assert.ok(rota.includes('resolveEmpresaAlvo('));
    assert.ok(rota.includes('criarDepsCorrecao(postgrestRequest)'));
  });
  test('motivo e mensagem fora de console.*', () => {
    const logs = rota.split('\n').filter((l) => /console\./.test(l)).join('\n');
    assert.ok(!/motivo|mensagem1|req\.body/.test(logs));
  });
});

describe('3.1b deps reais (comportamento, postgrestRequest falso)', () => {
  const { criarDepsCorrecao } = lib;
  function falso(respostas = {}) {
    const chamadas = [];
    const fn = async (endpoint, method = 'GET', body = null) => {
      chamadas.push({ endpoint, method, body });
      const k = Object.keys(respostas).find((x) => endpoint.startsWith(x));
      return k ? respostas[k] : [];
    };
    return { fn, chamadas };
  }
  test('toda leitura de EnvioMassa filtra por id_empresa (unica fronteira de tenant)', async () => {
    const f = falso({ EnvioMassa: [{ mensagem1: 'm' }] });
    await criarDepsCorrecao(f.fn).lerMovimento('10', 6);
    assert.match(f.chamadas[0].endpoint, /^EnvioMassa\?id=eq\.10&id_empresa=eq\.6&/);
  });
  test('corrigir envia p_id_empresa do argumento, nunca de outro lugar', async () => {
    const f = falso();
    await criarDepsCorrecao(f.fn).corrigir({ idEmp: 6, movimentos: [{ id: 1, valor: 2 }], motivo: 'x', origem: 'tela', usuarioId: 3 });
    assert.deepEqual(f.chamadas[0], { endpoint: 'rpc/hub_envio_massa_corrigir_valor', method: 'POST',
      body: { p_id_empresa: 6, p_movimentos: [{ id: 1, valor: 2 }], p_motivo: 'x', p_origem: 'tela', p_usuario_id: 3 } });
  });
  test('sem trilha => origem null (planilha); com trilha => molde + periodo', async () => {
    assert.equal(await criarDepsCorrecao(falso().fn, falso().fn).lerOrigemHub('10', 6), null);
    const f = falso({
      ApuracaoRepasseMovimento: [{ apuracao_id: 7 }], ApuracaoRepasse: [{ periodo_inicio: '2026-09-21', periodo_fim: '2026-09-27' }],
      AdiantamentoConfiguracao: [{ mensagem1_modelo: 'oi {nome}' }],
    });
    assert.deepEqual(await criarDepsCorrecao(falso().fn, f.fn).lerOrigemHub('10', 6),
      { modelo: 'oi {nome}', periodoInicio: '2026-09-21', periodoFim: '2026-09-27' });
  });
});

describe('3.2b valor ambiguo/sujo recusado na tela', () => {
  test('"1.500", "1e5", "abc1def2" => 400 sem escrita; "1.500,00" e "1500" passam', async () => {
    const w = mundo();
    for (const v of ['1.500', '1e5', 'abc1def2']) assert.equal((await corrigirPelaTela(req({ valor: v, motivo: 'x' }), w.deps)).status, 400);
    assert.equal(w.chamadas.corrigir.length, 0);
    for (const v of ['1.500,00', '1500', 'R$ 12,34']) assert.equal((await corrigirPelaTela(req({ valor: v, motivo: 'x' }), w.deps)).status, 200);
  });
});
