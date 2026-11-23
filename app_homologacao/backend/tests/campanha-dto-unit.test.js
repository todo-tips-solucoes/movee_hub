'use strict';
/**
 * Testes unitários — lib/campanha-dto.js (CONTRATOS §4/§5/§7). node --test tests/campanha-dto-unit.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');

const dto = require('../lib/campanha-dto');
const lancamento = require('../lib/lancamento-externo');

const form = (over = {}) => ({
  nome: 'Rei do Jantar',
  descricao: 'desc',
  dataInicio: '2026-11-10',
  dataFim: '2026-11-30',
  pracas: ['sao paulo'],
  turnos: null,
  modais: [' moto '],
  minTurnos: 5,
  pesos: { aceitacao: 30, conclusao: 30, tempo: 20, pedidos: 20 },
  cortes: { aceitacao: 0.8, conclusao: 0.9, tempo: null, pedidos: null },
  premios: [{ posicaoDe: 1, posicaoAte: 1, tipo: 'objeto', descricao: 'Moto', valorCentavos: 1600000 }],
  avisar: true,
  ...over,
});
const erro = (corpo) => { const r = dto.validarFormulario(corpo); assert.equal(r.ok, false); return r; };

describe('validarFormulario — caminho feliz e canonização', () => {
  test('canoniza (upper+trim), mapeia para snake e ignora campos desconhecidos (idEmpresa forjado)', () => {
    const r = dto.validarFormulario(form({ idEmpresa: 999, id_empresa: 999, criadaPor: 1 }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.dados.pracas, ['SAO PAULO']);
    assert.deepEqual(r.dados.modais, ['MOTO']);
    assert.equal(r.dados.turnos, null);
    assert.equal(r.dados.pesos.aceitacao, 30);
    assert.equal(r.dados.cortes.aceitacao, 0.8);
    assert.equal(r.dados.cortes.tempo, null);
    assert.equal(r.dados.minTurnos, 5);
    assert.equal(r.dados.premios[0].posicaoDe, 1);
    assert.deepEqual(Object.keys(r.dados).sort(), ['avisar', 'cortes', 'dataFim', 'dataInicio', 'descricao', 'minTurnos', 'modais', 'nome', 'pesos', 'pracas', 'premios', 'turnos']);
  });
  test('deduplica itens canônicos da lista', () => {
    assert.deepEqual(dto.validarFormulario(form({ pracas: ['a', ' A ', 'b'] })).dados.pracas, ['A', 'B']);
  });
  test('avisar ausente = true; não-booleano = VALIDACAO', () => {
    const { avisar, ...resto } = form();
    assert.equal(dto.validarFormulario(resto).dados.avisar, true);
    assert.equal(erro(form({ avisar: 'sim' })).campo, 'avisar');
  });
});

describe('validarFormulario — bordas do §4', () => {
  test('nome 2 e 121 recusados; 3 e 120 aceitos', () => {
    assert.equal(erro(form({ nome: 'ab' })).campo, 'nome');
    assert.equal(erro(form({ nome: 'a'.repeat(121) })).campo, 'nome');
    assert.equal(dto.validarFormulario(form({ nome: 'abc' })).ok, true);
    assert.equal(dto.validarFormulario(form({ nome: 'a'.repeat(120) })).ok, true);
  });
  test('descricao > 1000 recusada', () => {
    assert.equal(erro(form({ descricao: 'x'.repeat(1001) })).campo, 'descricao');
  });
  test('datas: fim < início, data inexistente e duração > 92 dias', () => {
    assert.equal(erro(form({ dataFim: '2026-11-09' })).campo, 'dataFim');
    assert.equal(erro(form({ dataInicio: '2026-02-30' })).campo, 'dataInicio');
    assert.equal(erro(form({ dataInicio: '10/11/2026' })).campo, 'dataInicio');
    assert.equal(dto.validarFormulario(form({ dataInicio: '2026-01-01', dataFim: '2026-04-02' })).ok, true); // 92 dias
    assert.equal(erro(form({ dataInicio: '2026-01-01', dataFim: '2026-04-03' })).campo, 'dataFim'); // 93
    assert.equal(dto.validarFormulario(form({ dataFim: '2026-11-10' })).ok, true); // 1 dia
  });
  test('listas: vazia, > 50 itens, item vazio ou > 120 caracteres', () => {
    assert.equal(erro(form({ pracas: [] })).campo, 'pracas');
    assert.equal(erro(form({ turnos: Array.from({ length: 51 }, (_, i) => `T${i}`) })).campo, 'turnos');
    assert.equal(erro(form({ modais: ['  '] })).campo, 'modais');
    assert.equal(erro(form({ pracas: ['x'.repeat(121)] })).campo, 'pracas');
    assert.equal(dto.validarFormulario(form({ turnos: Array.from({ length: 50 }, (_, i) => `T${i}`) })).ok, true);
  });
  test('minTurnos 0, 201 e fracionário recusados', () => {
    for (const v of [0, 201, 1.5, '5']) assert.equal(erro(form({ minTurnos: v })).campo, 'minTurnos');
  });
  test('pesos: soma 99 e 101 -> PESOS_INVALIDOS; todos 0 -> PESOS_INVALIDOS; fora de 0..100 ou fracionário -> VALIDACAO', () => {
    assert.equal(erro(form({ pesos: { aceitacao: 30, conclusao: 30, tempo: 20, pedidos: 19 } })).token, 'PESOS_INVALIDOS');
    assert.equal(erro(form({ pesos: { aceitacao: 30, conclusao: 30, tempo: 20, pedidos: 21 } })).token, 'PESOS_INVALIDOS');
    assert.equal(erro(form({ pesos: { aceitacao: 0, conclusao: 0, tempo: 0, pedidos: 0 }, cortes: {} })).token, 'PESOS_INVALIDOS');
    assert.equal(erro(form({ pesos: { aceitacao: 101, conclusao: -1, tempo: 0, pedidos: 0 } })).token, 'VALIDACAO');
    assert.equal(erro(form({ pesos: { aceitacao: 30.5, conclusao: 29.5, tempo: 20, pedidos: 20 } })).token, 'VALIDACAO');
    assert.equal(dto.validarFormulario(form({ pesos: { aceitacao: 100, conclusao: 0, tempo: 0, pedidos: 0 }, cortes: { aceitacao: 0.5 } })).ok, true);
  });
  test('cortes: taxa fora de 0..1 ou > 4 casas recusada; 0 e 1 aceitos', () => {
    assert.equal(erro(form({ cortes: { aceitacao: 1.01 } })).campo, 'cortes.aceitacao');
    assert.equal(erro(form({ cortes: { aceitacao: -0.1 } })).campo, 'cortes.aceitacao');
    assert.equal(erro(form({ cortes: { aceitacao: 0.12345 } })).campo, 'cortes.aceitacao');
    assert.equal(dto.validarFormulario(form({ cortes: { aceitacao: 0, conclusao: 1 } })).ok, true);
  });
  test('corte com peso 0 -> CORTE_SEM_PESO (taxa e pedidos)', () => {
    const semTempo = { aceitacao: 40, conclusao: 30, tempo: 0, pedidos: 30 };
    const r = erro(form({ pesos: semTempo, cortes: { tempo: 0.5 } }));
    assert.deepEqual([r.token, r.campo], ['CORTE_SEM_PESO', 'cortes.tempo']);
    const semPed = { aceitacao: 40, conclusao: 30, tempo: 30, pedidos: 0 };
    assert.equal(erro(form({ pesos: semPed, cortes: { pedidos: 10 } })).token, 'CORTE_SEM_PESO');
  });
  test('corte_pedidos: 0, fracionário e > 100000 recusados', () => {
    for (const v of [0, 1.5, 100001]) assert.equal(erro(form({ cortes: { pedidos: v } })).campo, 'cortes.pedidos');
    assert.equal(dto.validarFormulario(form({ cortes: { pedidos: 100000 } })).ok, true);
  });
  test('prêmios: 0 e 21 faixas; posições fora de 1..500; ate < de; tipo; descrição', () => {
    assert.equal(erro(form({ premios: [] })).campo, 'premios');
    const faixas = Array.from({ length: 21 }, (_, i) => ({ posicaoDe: i + 1, posicaoAte: i + 1, tipo: 'objeto', descricao: 'x' }));
    assert.equal(erro(form({ premios: faixas })).campo, 'premios');
    assert.equal(dto.validarFormulario(form({ premios: faixas.slice(0, 20) })).ok, true);
    const um = (o) => form({ premios: [{ posicaoDe: 1, posicaoAte: 1, tipo: 'objeto', descricao: 'x', ...o }] });
    assert.equal(erro(um({ posicaoDe: 0 })).campo, 'premios[0].posicaoDe');
    assert.equal(erro(um({ posicaoDe: 501, posicaoAte: 501 })).campo, 'premios[0].posicaoDe');
    assert.equal(erro(um({ posicaoDe: 3, posicaoAte: 2 })).campo, 'premios[0].posicaoAte');
    assert.equal(erro(um({ tipo: 'cripto' })).campo, 'premios[0].tipo');
    assert.equal(erro(um({ descricao: ' ' })).campo, 'premios[0].descricao');
    assert.equal(erro(um({ descricao: 'x'.repeat(201) })).campo, 'premios[0].descricao');
  });
  test('faixas sobrepostas (inclusive fora de ordem) -> FAIXAS_SOBREPOSTAS; adjacentes passam', () => {
    const p = (de, ate) => ({ posicaoDe: de, posicaoAte: ate, tipo: 'objeto', descricao: 'x' });
    assert.equal(erro(form({ premios: [p(1, 3), p(3, 5)] })).token, 'FAIXAS_SOBREPOSTAS');
    assert.equal(erro(form({ premios: [p(5, 8), p(1, 6)] })).token, 'FAIXAS_SOBREPOSTAS');
    assert.equal(dto.validarFormulario(form({ premios: [p(4, 5), p(1, 3)] })).ok, true);
  });
  test('dinheiro: obrigatório, 1..TETO_CENTAVOS (importado do lançamento externo); objeto sem teto de dinheiro', () => {
    assert.equal(dto.TETO_CENTAVOS, lancamento.TETO_CENTAVOS);
    const d = (v) => form({ premios: [{ posicaoDe: 1, posicaoAte: 1, tipo: 'dinheiro', descricao: 'R$', valorCentavos: v }] });
    assert.equal(erro(d(lancamento.TETO_CENTAVOS + 1)).campo, 'premios[0].valorCentavos');
    assert.equal(erro(d(0)).campo, 'premios[0].valorCentavos');
    assert.equal(erro(d(undefined)).campo, 'premios[0].valorCentavos');
    assert.equal(erro(d(10.5)).campo, 'premios[0].valorCentavos');
    assert.equal(dto.validarFormulario(d(lancamento.TETO_CENTAVOS)).ok, true);
    const o = (v) => form({ premios: [{ posicaoDe: 1, posicaoAte: 1, tipo: 'objeto', descricao: 'Moto', valorCentavos: v }] });
    assert.equal(dto.validarFormulario(o(lancamento.TETO_CENTAVOS + 1)).ok, true);
    assert.equal(dto.validarFormulario(o(null)).ok, true);
  });
});

describe('detectarImagem (A9)', () => {
  const png = (extra = 0) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), Buffer.alloc(extra)]);
  test('JPEG, PNG e WebP por bytes iniciais', () => {
    assert.equal(dto.detectarImagem(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
    assert.equal(dto.detectarImagem(png()), 'image/png');
    assert.equal(dto.detectarImagem(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1')), 'image/webp');
  });
  test('RIFF que não é WEBP (WAV) e SVG recusados', () => {
    assert.equal(dto.detectarImagem(Buffer.from('RIFF\x10\x00\x00\x00WAVEfmt ', 'latin1')), null);
    assert.equal(dto.detectarImagem(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
    assert.equal(dto.detectarImagem(Buffer.from('<?xml version="1.0"?><svg/>')), null);
  });
  test('limite: 512000 aceita, 512001 recusa; vazio e não-Buffer recusados', () => {
    assert.equal(dto.detectarImagem(png(512000 - 12)), 'image/png');
    assert.equal(dto.detectarImagem(png(512001 - 12)), null);
    assert.equal(dto.detectarImagem(Buffer.alloc(0)), null);
    assert.equal(dto.detectarImagem({}), null);
    assert.equal(dto.detectarImagem(undefined), null);
  });
  test('bytes de PNG: o mime detectado é image/png, então um mime declarado diferente não casa', () => {
    assert.notEqual(dto.detectarImagem(png()), 'image/jpeg');
  });
});

describe('mapearErroRpc (§5)', () => {
  const esperado = {
    CAMPANHA_NAO_ENCONTRADA: 404, CAMPANHA_IMUTAVEL: 409, CAMPANHA_SITUACAO_INVALIDA: 409, TETO_CAMPANHAS_ATIVAS: 409,
    PEDIDOS_SEM_COBERTURA: 422, INICIO_NO_PASSADO: 422, FAIXAS_SOBREPOSTAS: 422, PESOS_INVALIDOS: 422, CORTE_SEM_PESO: 422,
    OPCAO_DESCONHECIDA: 422, FECHAMENTO_ANTECIPADO: 409, FOTO_INVALIDA: 422, CONFIRMACAO_AUSENTE: 422, SEM_VINCULO: 404, VALIDACAO: 422,
  };
  for (const [token, status] of Object.entries(esperado)) {
    test(`${token} -> ${status}`, () => {
      const e = Object.assign(new Error('x'), { body: JSON.stringify({ code: 'P0001', message: token }) });
      assert.deepEqual(dto.mapearErroRpc(e), { status, erro: token });
    });
  }
  test('corpo não-JSON com o token cai na busca por substring; erro de infra e sem corpo -> null', () => {
    assert.equal(dto.mapearErroRpc({ body: 'ERROR: SEM_VINCULO' }).status, 404);
    assert.equal(dto.mapearErroRpc({ body: '{"message":"connection refused"}' }), null);
    assert.equal(dto.mapearErroRpc(new Error('boom')), null);
    assert.equal(dto.mapearErroRpc(null), null);
  });
});

describe('mapeamento snake -> camel (§7)', () => {
  test('linhaRanking cobre todos os campos do contrato', () => {
    const r = dto.linhaRanking({
      posicao: 1, entregador_id: 88, nome: 'Marcos', modal: 'MOTO', situacao: 'classificado', turnos: 19,
      aceitacao: '0.962', conclusao: 0.991, tempo: 0.94, pedidos: 412, nota: 97.3, nota_hipotetica: null,
      posicao_hipotetica: null, motivo_corte: [], posicao_anterior: 3,
    });
    assert.deepEqual(r, {
      posicao: 1, entregadorId: 88, nome: 'Marcos', modal: 'MOTO', situacao: 'classificado', turnos: 19,
      aceitacao: 0.962, conclusao: 0.991, tempo: 0.94, pedidos: 412, nota: 97.3, notaHipotetica: null,
      posicaoHipotetica: null, motivoCorte: [], posicaoAnterior: 3,
    });
  });
  test('itemLista desembrulha {item} da RPC (já camelCase) e aceita snake solto', () => {
    const item = { id: 12, nome: 'N', dataInicio: '2026-11-10', pesos: { aceitacao: 30 }, contagem: { classificado: 1, abaixoCorte: 2, semMinimo: 3, semModal: 4 }, premiosPendentes: 0, dadosAte: null };
    assert.deepEqual(dto.itemLista({ item }), item);
    assert.deepEqual(dto.itemLista({ id: 1, data_inicio: 'x', premios_pendentes: 2 }), { id: 1, dataInicio: 'x', premiosPendentes: 2 });
  });
  test('premio.id opcional é repassado (preserva a foto ao editar); id inválido recusado', () => {
    const p = { posicaoDe: 1, posicaoAte: 1, tipo: 'objeto', descricao: 'x', id: 7 };
    assert.equal(dto.validarFormulario(form({ premios: [p] })).dados.premios[0].id, 7);
    assert.equal(erro(form({ premios: [{ ...p, id: 'a' }] })).campo, 'premios[0].id');
  });
  test('mapearErroRpc: VALIDACAO leva o campo do DETAIL', () => {
    const e = { body: JSON.stringify({ message: 'VALIDACAO', details: 'pesos.tempo' }) };
    assert.deepEqual(dto.mapearErroRpc(e), { status: 422, erro: 'VALIDACAO', campo: 'pesos.tempo' });
  });
  test('linhaVencedor: semCnpj, premio aninhado e nenhum CNPJ na resposta', () => {
    const r = dto.linhaVencedor({ posicao: 2, nome: 'Ana', cnpj: null, nota: 90, premio_tipo: 'dinheiro', premio_descricao: 'R$ 100', valor_centavos: 10000, entregue_em: null, entregue_por_nome: null, observacao: null, exportado_em: null });
    assert.equal(r.semCnpj, true);
    assert.deepEqual(r.premio, { tipo: 'dinheiro', descricao: 'R$ 100', valorCentavos: 10000 });
    assert.equal(JSON.stringify(dto.linhaVencedor({ posicao: 1, cnpj: '11222333000181' })).includes('11222333000181'), false);
  });
  test('camelizar converte chaves em profundidade e preserva valores', () => {
    assert.deepEqual(dto.camelizar({ a_b: { c_d: [{ e_f: 'x_y' }] }, top10: 1 }), { aB: { cD: [{ eF: 'x_y' }] }, top10: 1 });
  });
});

describe('planilha de prêmios em dinheiro', () => {
  const venc = [
    { cnpj: '11.222.333/0001-81', nome: 'Ana', valor_centavos: 10000, posicao: 1, data_pagamento: '2026-11-20', adiado: false },
    { cnpj: null, nome: 'Sem CNPJ', valor_centavos: 5000, posicao: 2, data_pagamento: '2026-11-22', adiado: false },
    { cnpj: '123', nome: 'CNPJ curto', valor_centavos: 5000, posicao: 3, data_pagamento: '2026-11-22', adiado: false },
    { cnpj: '44555666000199', nome: 'Beto', valor_centavos: 2550, posicao: 4, data_pagamento: '2026-11-22', adiado: false },
    { cnpj: '77888999000155', nome: 'Adiado', valor_centavos: 3000, posicao: 5, data_pagamento: '2026-11-22', adiado: true },
  ];
  test('data da linha = data_pagamento da RPC (não hoje); adiado e sem CNPJ não entram; cabeçalho do importador', () => {
    const aoa = dto.linhasPlanilhaPremios(venc, 12);
    assert.deepEqual(aoa[0], lancamento.CABECALHO_ESPERADO);
    assert.equal(aoa.length, 3);
    assert.deepEqual(aoa[1], ['11222333000181', '2026-11-20', 100, 'Ana', 'Prêmio campanha #12 — 1º']);
    assert.deepEqual(aoa[2], ['44555666000199', '2026-11-22', 25.5, 'Beto', 'Prêmio campanha #12 — 4º']);
    assert.equal(dto.contarAdiados(venc), 1);
  });
  test('o XLSX gerado é lido pelo importador do Lançamento externo (sem recusa), com a data original', () => {
    const buf = dto.planilhaPremiosBuffer(dto.linhasPlanilhaPremios(venc, 12));
    const lido = lancamento.lerLancamentos(buf, { hoje: '2026-11-22' });
    assert.equal(lido.recusadas.length, 0);
    assert.deepEqual(lido.validas.map((v) => [v.cnpj, v.data, v.valor]), [
      ['11222333000181', '2026-11-20', '100.00'], ['44555666000199', '2026-11-22', '25.50'],
    ]);
    const wb = XLSX.read(buf, { type: 'buffer' });
    assert.deepEqual(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 })[0], lancamento.CABECALHO_ESPERADO);
  });
  test('B6: id de prêmio repetido -> VALIDACAO campo premios', () => {
    const p = (de, id) => ({ posicaoDe: de, posicaoAte: de, tipo: 'objeto', descricao: 'x', id });
    const r = erro(form({ premios: [p(1, 7), p(2, 7)] }));
    assert.deepEqual([r.token, r.campo], ['VALIDACAO', 'premios']);
    assert.equal(dto.validarFormulario(form({ premios: [p(1, 7), p(2, 8)] })).ok, true);
  });
  test('TIPOS do lançamento externo inclui PREMIO_CAMPANHA', () => {
    assert.ok(lancamento.TIPOS.includes('PREMIO_CAMPANHA'));
  });
});
