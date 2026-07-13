/**
 * Testes unitários — lib/hub-motoristas-dto.js (tasks.md FASE 3, 3.1.5).
 * Rodam com: node --test tests/hub-motoristas-dto.test.js
 *
 * Cobre as funções PURAS (sem PostgREST/DB real): paginação, normalização
 * de acento/caixa, filtro de nome/área, agrupamento de áreas por
 * entregador, mapeamento de item de lista e de detalhe, e TODOS os casos
 * de máscara de CNPJ (contracts/motoristas-api.md §Mascaramento de CNPJ).
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  parsePaginacao,
  normalizarNome,
  nomeCasa,
  areaCasa,
  agruparAreasPorEntregador,
  mapMotoristaListItem,
  mapMotoristaDetalhe,
  validarPatchMotorista,
  validarCriacaoMotorista,
  mascararCnpj,
  validarVinculoBody,
  validarCriacaoCredencialBody,
  validarPatchCredencialBody,
  validarDefinirSenhaCredencialBody,
  parsePaginacaoAtividades,
  mapFaturamentoAtividade,
  mapPerformanceAtividade,
  mapValidacaoNfAtividade,
  montarAtividades,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
} = require('../lib/hub-motoristas-dto');

describe('parsePaginacao', () => {
  test('default: page=1, pageSize default, from=0, to=pageSize-1', () => {
    const r = parsePaginacao({});
    assert.equal(r.page, 1);
    assert.equal(r.pageSize, PAGE_SIZE_DEFAULT);
    assert.equal(r.from, 0);
    assert.equal(r.to, PAGE_SIZE_DEFAULT - 1);
  });

  test('page=3, pageSize=10 -> from=20, to=29', () => {
    const r = parsePaginacao({ page: '3', pageSize: '10' });
    assert.equal(r.page, 3);
    assert.equal(r.pageSize, 10);
    assert.equal(r.from, 20);
    assert.equal(r.to, 29);
  });

  test('pageSize acima do máximo (100) é clampado', () => {
    const r = parsePaginacao({ pageSize: '99999' });
    assert.equal(r.pageSize, PAGE_SIZE_MAX);
  });

  test('page < 1 ou não numérico -> 1', () => {
    assert.equal(parsePaginacao({ page: '0' }).page, 1);
    assert.equal(parsePaginacao({ page: '-5' }).page, 1);
    assert.equal(parsePaginacao({ page: 'abc' }).page, 1);
  });

  test('pageSize não numérico -> default', () => {
    assert.equal(parsePaginacao({ pageSize: 'xyz' }).pageSize, PAGE_SIZE_DEFAULT);
  });
});

describe('normalizarNome — tolerância a acento/caixa', () => {
  test('remove acentos comuns (á, ã, ç, é, ô, í, ú)', () => {
    assert.equal(normalizarNome('José'), 'jose');
    assert.equal(normalizarNome('João Ção'), 'joao cao');
    assert.equal(normalizarNome('Área Única'), 'area unica');
    assert.equal(normalizarNome('Zoé Ibañez'), 'zoe ibanez');
  });

  test('lowercase', () => {
    assert.equal(normalizarNome('FULANO DA SILVA'), 'fulano da silva');
  });

  test('null/undefined -> string vazia', () => {
    assert.equal(normalizarNome(null), '');
    assert.equal(normalizarNome(undefined), '');
  });

  test('trim de espaços nas pontas', () => {
    assert.equal(normalizarNome('  Fulano  '), 'fulano');
  });
});

describe('nomeCasa — busca parcial tolerante a acento', () => {
  test('termo sem acento casa nome COM acento (prova de tolerância)', () => {
    assert.equal(nomeCasa('jose', 'José da Silva'), true);
    assert.equal(nomeCasa('joao', 'João Ção'), true);
  });

  test('termo COM acento casa nome sem acento', () => {
    assert.equal(nomeCasa('josé', 'jose da silva'), true);
  });

  test('caixa diferente casa', () => {
    assert.equal(nomeCasa('FULANO', 'fulano da silva'), true);
  });

  test('substring que não existe não casa', () => {
    assert.equal(nomeCasa('carlos', 'José da Silva'), false);
  });

  test('termo vazio/ausente casa tudo', () => {
    assert.equal(nomeCasa('', 'qualquer nome'), true);
    assert.equal(nomeCasa(undefined, 'qualquer nome'), true);
    assert.equal(nomeCasa(null, 'qualquer nome'), true);
  });
});

describe('areaCasa — qualquer área distinta corresponde', () => {
  const areas = [{ subpraca: 'Zona Sul' }, { subpraca: 'Centro' }];

  test('área presente na lista (normalizada) casa', () => {
    assert.equal(areaCasa('zona sul', areas), true);
    assert.equal(areaCasa('CENTRO', areas), true);
  });

  test('área ausente não casa', () => {
    assert.equal(areaCasa('Zona Norte', areas), false);
  });

  test('área vazia/ausente casa tudo', () => {
    assert.equal(areaCasa('', areas), true);
    assert.equal(areaCasa(undefined, areas), true);
  });

  test('lista de áreas vazia nunca casa (exceto termo vazio)', () => {
    assert.equal(areaCasa('Centro', []), false);
    assert.equal(areaCasa('', []), true);
  });
});

describe('agruparAreasPorEntregador', () => {
  test('agrupa por entregador_id e ordena por dataMaisRecente DESC', () => {
    const linhas = [
      { entregador_id: 1, subpraca: 'Centro', data_mais_recente: '2026-05-14' },
      { entregador_id: 1, subpraca: 'Zona Sul', data_mais_recente: '2026-07-01' },
      { entregador_id: 2, subpraca: 'Norte', data_mais_recente: '2026-01-01' },
    ];
    const mapa = agruparAreasPorEntregador(linhas);
    assert.deepEqual(mapa.get(1), [
      { subpraca: 'Zona Sul', dataMaisRecente: '2026-07-01' },
      { subpraca: 'Centro', dataMaisRecente: '2026-05-14' },
    ]);
    assert.deepEqual(mapa.get(2), [{ subpraca: 'Norte', dataMaisRecente: '2026-01-01' }]);
  });

  test('entrada vazia/nula -> mapa vazio', () => {
    assert.equal(agruparAreasPorEntregador([]).size, 0);
    assert.equal(agruparAreasPorEntregador(null).size, 0);
  });
});

describe('mapMotoristaListItem', () => {
  test('mapeia comVinculo=true quando motorista_id presente', () => {
    const item = mapMotoristaListItem(
      { id: 1, nome: 'Fulano', ativo: true, motorista_id: 7, id_externo: '11111111-1111-1111-1111-111111111111' },
      [{ subpraca: 'Zona Sul', dataMaisRecente: '2026-07-01' }]
    );
    assert.deepEqual(item, {
      id: 1,
      nome: 'Fulano',
      idExterno: '11111111-1111-1111-1111-111111111111',
      ativo: true,
      comVinculo: true,
      areas: ['Zona Sul'],
    });
  });

  test('mapeia comVinculo=false quando motorista_id null', () => {
    const item = mapMotoristaListItem(
      { id: 2, nome: 'Ciclano', ativo: false, motorista_id: null, id_externo: '22222222-2222-2222-2222-222222222222' },
      []
    );
    assert.deepEqual(item, {
      id: 2,
      nome: 'Ciclano',
      idExterno: '22222222-2222-2222-2222-222222222222',
      ativo: false,
      comVinculo: false,
      areas: [],
    });
  });

  test('areas default para [] quando não informado', () => {
    const item = mapMotoristaListItem({ id: 3, nome: 'X', ativo: true, motorista_id: null, id_externo: '33333333-3333-3333-3333-333333333333' });
    assert.deepEqual(item.areas, []);
  });

  // FASE 4 (task 4.1.1/4.1.4): idExterno (uuid) exposto no item de listagem (FR-016)
  test('idExterno (uuid) exposto no formato esperado', () => {
    const item = mapMotoristaListItem({
      id: 4, nome: 'Beltrano', ativo: true, motorista_id: null, id_externo: '44444444-4444-4444-4444-444444444444',
    });
    assert.equal(item.idExterno, '44444444-4444-4444-4444-444444444444');
  });
});

describe('mapMotoristaDetalhe', () => {
  test('vinculo presente -> objeto com cnpjPrestadorMascarado', () => {
    const row = {
      id: 1,
      nome: 'Fulano da Silva',
      ativo: true,
      nome_editado_manualmente: false,
      id_externo: '55555555-5555-5555-5555-555555555555',
      ContaMotorista: { id: 7, nome: 'Fulano da Silva', cnpj_prestador: '12345678000195', ativo: true },
    };
    const areas = [{ subpraca: 'Zona Sul', dataMaisRecente: '2026-07-01' }];
    const resumo = { totalFaturamento: 42, totalPerformance: 30, dataMaisRecente: '2026-07-01' };
    const detalhe = mapMotoristaDetalhe(row, areas, resumo);
    assert.deepEqual(detalhe, {
      id: 1,
      nome: 'Fulano da Silva',
      idExterno: '55555555-5555-5555-5555-555555555555',
      ativo: true,
      nomeEditadoManualmente: false,
      areas: [{ subpraca: 'Zona Sul', dataMaisRecente: '2026-07-01' }],
      resumo: { totalFaturamento: 42, totalPerformance: 30, dataMaisRecente: '2026-07-01' },
      vinculo: {
        contaMotoristaId: 7,
        nome: 'Fulano da Silva',
        cnpjPrestadorMascarado: '12.***.***/0001-**',
        ativo: true,
      },
      // FASE 6 (task 6.4) — atividades ausente no chamador cai no default
      // (motorista sem atividades consultadas, task 6.4.4).
      atividades: { items: [], total: 0, offset: 0, limit: 0 },
    });
  });

  test('FASE 6 (task 6.4) — atividades explícito é repassado tal-e-qual (pass-through)', () => {
    const row = { id: 1, nome: 'Fulano', ativo: true, nome_editado_manualmente: false, ContaMotorista: null };
    const resumo = { totalFaturamento: 0, totalPerformance: 0, dataMaisRecente: null };
    const atividades = {
      items: [{ tipo: 'faturamento', data: '2026-07-01', descricao: 'entrega', valor: 10 }],
      total: 1,
      offset: 0,
      limit: 20,
    };
    const detalhe = mapMotoristaDetalhe(row, [], resumo, atividades);
    assert.deepEqual(detalhe.atividades, atividades);
  });

  test('vinculo presente com credencial DESATIVADA (FASE 5, task 5.5) -> vinculo.ativo=false', () => {
    const row = {
      id: 1,
      nome: 'Fulano da Silva',
      ativo: true,
      nome_editado_manualmente: false,
      id_externo: '55555555-5555-5555-5555-555555555555',
      ContaMotorista: { id: 7, nome: 'Fulano da Silva', cnpj_prestador: '12345678000195', ativo: false },
    };
    const detalhe = mapMotoristaDetalhe(row, [], { totalFaturamento: 0, totalPerformance: 0, dataMaisRecente: null });
    assert.equal(detalhe.vinculo.ativo, false);
  });

  test('vinculo ausente -> null, sem erro', () => {
    const row = { id: 2, nome: 'Ciclano', ativo: true, nome_editado_manualmente: true, ContaMotorista: null };
    const detalhe = mapMotoristaDetalhe(row, [], { totalFaturamento: 0, totalPerformance: 0, dataMaisRecente: null });
    assert.equal(detalhe.vinculo, null);
    assert.equal(detalhe.nomeEditadoManualmente, true);
  });

  test('sem histórico de importação -> resumo zerado, areas vazio, sem erro', () => {
    const row = { id: 3, nome: 'Sem Historico', ativo: true, nome_editado_manualmente: false, ContaMotorista: null };
    const detalhe = mapMotoristaDetalhe(row, [], { totalFaturamento: 0, totalPerformance: 0, dataMaisRecente: null });
    assert.deepEqual(detalhe.resumo, { totalFaturamento: 0, totalPerformance: 0, dataMaisRecente: null });
    assert.deepEqual(detalhe.areas, []);
  });

  test('resumo undefined -> defaults zerados (nunca lança)', () => {
    const row = { id: 4, nome: 'X', ativo: true, nome_editado_manualmente: false, ContaMotorista: null };
    const detalhe = mapMotoristaDetalhe(row, [], undefined);
    assert.deepEqual(detalhe.resumo, { totalFaturamento: 0, totalPerformance: 0, dataMaisRecente: null });
  });
});

describe('mascararCnpj — LGPD, formato NN.***.***/NNNN-**', () => {
  test('14 dígitos puros', () => {
    assert.equal(mascararCnpj('12345678000195'), '12.***.***/0001-**');
  });

  test('CNPJ com pontuação (normaliza para dígitos antes de fatiar)', () => {
    assert.equal(mascararCnpj('12.345.678/0001-95'), '12.***.***/0001-**');
  });

  test('outro CNPJ formatado — confere prefixo/bloco distintos', () => {
    assert.equal(mascararCnpj('98.765.432/0003-21'), '98.***.***/0003-**');
  });

  test('entrada inválida/curta não quebra — retorna null', () => {
    assert.equal(mascararCnpj('123'), null);
    assert.equal(mascararCnpj(''), null);
    assert.equal(mascararCnpj('12345678'), null);
  });

  test('entrada null/undefined -> null, nunca lança', () => {
    assert.equal(mascararCnpj(null), null);
    assert.equal(mascararCnpj(undefined), null);
  });

  test('entrada com dígitos além de 14 (inválida) -> null', () => {
    assert.equal(mascararCnpj('123456780001955555'), null);
  });
});

describe('validarPatchMotorista — allowlist estrita FASE 4 (task 4.1), contracts/motoristas-api.md §PATCH', () => {
  test('só nome -> patch com nome + nome_editado_manualmente=true', () => {
    const r = validarPatchMotorista({ nome: 'Novo Nome' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.patch, { nome: 'Novo Nome', nome_editado_manualmente: true });
    assert.deepEqual(r.camposAlterados, ['nome']);
  });

  test('nome com espaços nas pontas -> trim aplicado', () => {
    const r = validarPatchMotorista({ nome: '  Fulano de Tal  ' });
    assert.equal(r.ok, true);
    assert.equal(r.patch.nome, 'Fulano de Tal');
  });

  test('só ativo -> patch com ativo, SEM nome_editado_manualmente', () => {
    const r = validarPatchMotorista({ ativo: false });
    assert.equal(r.ok, true);
    assert.deepEqual(r.patch, { ativo: false });
    assert.deepEqual(r.camposAlterados, ['ativo']);
  });

  test('nome + ativo juntos -> ambos no patch, 1 único UPDATE (FR-004)', () => {
    const r = validarPatchMotorista({ nome: 'X', ativo: true });
    assert.equal(r.ok, true);
    assert.deepEqual(r.patch, { nome: 'X', nome_editado_manualmente: true, ativo: true });
    assert.deepEqual(r.camposAlterados, ['nome', 'ativo']);
  });

  test('nome vazio -> erro INVALIDO (422)', () => {
    const r = validarPatchMotorista({ nome: '' });
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'INVALIDO');
  });

  test('nome só espaços -> erro INVALIDO (422)', () => {
    const r = validarPatchMotorista({ nome: '   ' });
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'INVALIDO');
  });

  test('nome não-string (ex.: número) -> erro INVALIDO', () => {
    const r = validarPatchMotorista({ nome: 123 });
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'INVALIDO');
  });

  test('ativo não-booleano -> erro INVALIDO', () => {
    const r = validarPatchMotorista({ ativo: 'true' });
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'INVALIDO');
  });

  test('corpo vazio (nenhum campo) -> erro VAZIO', () => {
    const r = validarPatchMotorista({});
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'VAZIO');
  });

  test('corpo null/undefined -> erro VAZIO, nunca lança', () => {
    assert.equal(validarPatchMotorista(null).erro, 'VAZIO');
    assert.equal(validarPatchMotorista(undefined).erro, 'VAZIO');
  });

  test('mass-assignment/BOPLA — campos extras são IGNORADOS, nunca vazam para o patch (Decision 12)', () => {
    const r = validarPatchMotorista({
      nome: 'Fulano',
      motoristaId: 999,
      id: 1,
      idEmpresa: 42,
      nomeEditadoManualmente: false,
      __proto__: { hacked: true },
    });
    assert.equal(r.ok, true);
    const chaves = Object.keys(r.patch).sort();
    assert.deepEqual(chaves, ['nome', 'nome_editado_manualmente']);
    assert.equal(r.patch.hacked, undefined);
    assert.equal(r.patch.motoristaId, undefined);
    assert.equal(r.patch.idEmpresa, undefined);
  });
});

describe('validarVinculoBody — allowlist estrita FASE 6 (task 6.1), contracts/motoristas-api.md §POST vinculo', () => {
  test('contaMotoristaId numérico -> ok, origem default "nao_informado"', () => {
    const r = validarVinculoBody({ contaMotoristaId: 42 });
    assert.equal(r.ok, true);
    assert.equal(r.contaMotoristaId, 42);
    assert.equal(r.origem, 'nao_informado');
  });

  test('contaMotoristaId como string numérica -> ok', () => {
    const r = validarVinculoBody({ contaMotoristaId: '42' });
    assert.equal(r.ok, true);
    assert.equal(r.contaMotoristaId, 42);
  });

  test('origem="sugestao" -> preservada', () => {
    const r = validarVinculoBody({ contaMotoristaId: 7, origem: 'sugestao' });
    assert.equal(r.ok, true);
    assert.equal(r.origem, 'sugestao');
  });

  test('origem="busca_manual" -> preservada', () => {
    const r = validarVinculoBody({ contaMotoristaId: 7, origem: 'busca_manual' });
    assert.equal(r.ok, true);
    assert.equal(r.origem, 'busca_manual');
  });

  test('origem com valor fora do enum -> "nao_informado", nunca rejeita a requisição', () => {
    const r = validarVinculoBody({ contaMotoristaId: 7, origem: 'valor-invalido-qualquer' });
    assert.equal(r.ok, true);
    assert.equal(r.origem, 'nao_informado');
  });

  test('contaMotoristaId ausente -> erro INVALIDO (422)', () => {
    const r = validarVinculoBody({});
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'INVALIDO');
  });

  test('contaMotoristaId não-numérico (string) -> erro INVALIDO', () => {
    const r = validarVinculoBody({ contaMotoristaId: 'abc' });
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'INVALIDO');
  });

  test('contaMotoristaId negativo/float -> erro INVALIDO', () => {
    assert.equal(validarVinculoBody({ contaMotoristaId: -1 }).ok, false);
    assert.equal(validarVinculoBody({ contaMotoristaId: 1.5 }).ok, false);
  });

  test('corpo null/undefined -> erro INVALIDO, nunca lança', () => {
    assert.equal(validarVinculoBody(null).ok, false);
    assert.equal(validarVinculoBody(undefined).ok, false);
  });

  test('mass-assignment/BOPLA — campos extras (ex.: idEmpresa, id) nunca aparecem no retorno', () => {
    const r = validarVinculoBody({ contaMotoristaId: 7, idEmpresa: 999, id: 1 });
    assert.equal(r.ok, true);
    const chaves = Object.keys(r).sort();
    assert.deepEqual(chaves, ['contaMotoristaId', 'ok', 'origem']);
  });
});

describe('validarCriacaoMotorista — allowlist estrita FASE 4 (task 4.2.2/4.2.3), contracts/api-motorista-canonico.md §POST /motoristas', () => {
  const UUID_VALIDO = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  test('nome + idExterno válidos -> ok, idExterno normalizado para minúsculas', () => {
    const r = validarCriacaoMotorista({ nome: '  Fulano da Silva  ', idExterno: 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890' });
    assert.equal(r.ok, true);
    assert.equal(r.nome, 'Fulano da Silva');
    assert.equal(r.idExterno, UUID_VALIDO);
  });

  test('nome ausente -> erro nome_invalido', () => {
    const r = validarCriacaoMotorista({ idExterno: UUID_VALIDO });
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'nome_invalido');
  });

  test('nome vazio/só espaços -> erro nome_invalido', () => {
    assert.equal(validarCriacaoMotorista({ nome: '', idExterno: UUID_VALIDO }).erro, 'nome_invalido');
    assert.equal(validarCriacaoMotorista({ nome: '   ', idExterno: UUID_VALIDO }).erro, 'nome_invalido');
  });

  test('idExterno ausente -> erro uuid_invalido (sempre obrigatório, FR-012/D-C6)', () => {
    const r = validarCriacaoMotorista({ nome: 'Fulano' });
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'uuid_invalido');
  });

  test('idExterno em formato inválido -> erro uuid_invalido', () => {
    assert.equal(validarCriacaoMotorista({ nome: 'Fulano', idExterno: 'nao-e-um-uuid' }).erro, 'uuid_invalido');
    assert.equal(validarCriacaoMotorista({ nome: 'Fulano', idExterno: '12345' }).erro, 'uuid_invalido');
  });

  test('corpo null/undefined -> erro nome_invalido, nunca lança', () => {
    assert.equal(validarCriacaoMotorista(null).ok, false);
    assert.equal(validarCriacaoMotorista(undefined).ok, false);
  });

  test('mass-assignment/BOPLA (mandato S2) — ativo/motoristaId/id/idEmpresa do corpo nunca aparecem no retorno', () => {
    const r = validarCriacaoMotorista({
      nome: 'Fulano',
      idExterno: UUID_VALIDO,
      ativo: false,
      motoristaId: 999,
      id: 1,
      idEmpresa: 42,
      __proto__: { hacked: true },
    });
    assert.equal(r.ok, true);
    const chaves = Object.keys(r).sort();
    assert.deepEqual(chaves, ['idExterno', 'nome', 'ok']);
    assert.equal(r.ativo, undefined);
    assert.equal(r.motoristaId, undefined);
    assert.equal(r.idEmpresa, undefined);
    assert.equal(r.hacked, undefined);
  });
});

describe('validarCriacaoCredencialBody — allowlist estrita FASE 5 (task 5.1.2), contracts §POST /credencial', () => {
  test('cnpjPrestador formatado -> normalizado para só-dígitos', () => {
    const r = validarCriacaoCredencialBody({ cnpjPrestador: '12.345.678/0001-95' });
    assert.equal(r.ok, true);
    assert.equal(r.cnpjPrestador, '12345678000195');
  });

  test('senhaInicial ausente -> ok, sem a chave senhaInicial no retorno (senha será gerada pelo caller)', () => {
    const r = validarCriacaoCredencialBody({ cnpjPrestador: '12345678000195' });
    assert.equal(r.ok, true);
    assert.equal(Object.prototype.hasOwnProperty.call(r, 'senhaInicial'), false);
  });

  test('senhaInicial válida (>=8 chars) -> ecoada', () => {
    const r = validarCriacaoCredencialBody({ cnpjPrestador: '12345678000195', senhaInicial: 'SenhaForte1' });
    assert.equal(r.ok, true);
    assert.equal(r.senhaInicial, 'SenhaForte1');
  });

  test('senhaInicial curta (<8 chars) -> erro senha_invalida', () => {
    const r = validarCriacaoCredencialBody({ cnpjPrestador: '12345678000195', senhaInicial: '123' });
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'senha_invalida');
  });

  test('cnpjPrestador ausente/vazio -> erro cnpj_invalido', () => {
    assert.equal(validarCriacaoCredencialBody({}).erro, 'cnpj_invalido');
    assert.equal(validarCriacaoCredencialBody({ cnpjPrestador: '' }).erro, 'cnpj_invalido');
    assert.equal(validarCriacaoCredencialBody({ cnpjPrestador: '...' }).erro, 'cnpj_invalido');
  });

  test('corpo null/undefined -> erro cnpj_invalido, nunca lança', () => {
    assert.equal(validarCriacaoCredencialBody(null).ok, false);
    assert.equal(validarCriacaoCredencialBody(undefined).ok, false);
  });

  test('mass-assignment/BOPLA (mandato S2) — `ativo` do corpo é IGNORADO, nunca aparece no retorno', () => {
    const r = validarCriacaoCredencialBody({ cnpjPrestador: '12345678000195', ativo: false, motoristaId: 999 });
    assert.equal(r.ok, true);
    const chaves = Object.keys(r).sort();
    assert.deepEqual(chaves, ['cnpjPrestador', 'ok']);
    assert.equal(r.ativo, undefined);
    assert.equal(r.motoristaId, undefined);
  });
});

describe('validarPatchCredencialBody — allowlist estrita FASE 5 (task 5.3.1), contracts §PATCH /credencial', () => {
  test('ativo boolean -> ok', () => {
    assert.deepEqual(validarPatchCredencialBody({ ativo: true }), { ok: true, ativo: true });
    assert.deepEqual(validarPatchCredencialBody({ ativo: false }), { ok: true, ativo: false });
  });

  test('ativo ausente/não-booleano -> erro INVALIDO', () => {
    assert.equal(validarPatchCredencialBody({}).erro, 'INVALIDO');
    assert.equal(validarPatchCredencialBody({ ativo: 'true' }).erro, 'INVALIDO');
    assert.equal(validarPatchCredencialBody({ ativo: 1 }).erro, 'INVALIDO');
  });

  test('corpo null/undefined -> erro INVALIDO, nunca lança', () => {
    assert.equal(validarPatchCredencialBody(null).ok, false);
    assert.equal(validarPatchCredencialBody(undefined).ok, false);
  });

  test('mass-assignment/BOPLA — campos extras nunca aparecem no retorno', () => {
    const r = validarPatchCredencialBody({ ativo: true, senha: 'hackeada', id: 1 });
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r).sort(), ['ativo', 'ok']);
  });
});

describe('validarDefinirSenhaCredencialBody — allowlist estrita FASE 5 (gap-fill CHK011, reset-senha/definir)', () => {
  test('token + novaSenha válidos -> ok', () => {
    const r = validarDefinirSenhaCredencialBody({ token: 'abc123', novaSenha: 'NovaSenhaForte1' });
    assert.equal(r.ok, true);
    assert.equal(r.token, 'abc123');
    assert.equal(r.novaSenha, 'NovaSenhaForte1');
  });

  test('token ausente/vazio -> erro token_ausente', () => {
    assert.equal(validarDefinirSenhaCredencialBody({ novaSenha: 'NovaSenhaForte1' }).erro, 'token_ausente');
    assert.equal(validarDefinirSenhaCredencialBody({ token: '   ', novaSenha: 'NovaSenhaForte1' }).erro, 'token_ausente');
  });

  test('novaSenha curta (<8 chars) -> erro senha_invalida', () => {
    const r = validarDefinirSenhaCredencialBody({ token: 'abc123', novaSenha: '123' });
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'senha_invalida');
  });

  test('corpo null/undefined -> erro, nunca lança', () => {
    assert.equal(validarDefinirSenhaCredencialBody(null).ok, false);
    assert.equal(validarDefinirSenhaCredencialBody(undefined).ok, false);
  });

  test('mass-assignment/BOPLA — campos extras nunca aparecem no retorno', () => {
    const r = validarDefinirSenhaCredencialBody({ token: 'abc123', novaSenha: 'NovaSenhaForte1', ativo: true });
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r).sort(), ['novaSenha', 'ok', 'token']);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// FASE 6 (task 6.4) — histórico de atividades (dec-046/dec-048)
// ────────────────────────────────────────────────────────────────────────────

describe('parsePaginacaoAtividades — offset/limit (dec-046, Gap CHK018/CHK038)', () => {
  test('sem query -> default offset=0, limit=20', () => {
    assert.deepEqual(parsePaginacaoAtividades({}), { offset: 0, limit: 20 });
  });

  test('offset/limit válidos são respeitados', () => {
    assert.deepEqual(parsePaginacaoAtividades({ offset: '40', limit: '10' }), { offset: 40, limit: 10 });
  });

  test('limit acima do máximo (100) é clampado', () => {
    assert.deepEqual(parsePaginacaoAtividades({ offset: '0', limit: '999' }), { offset: 0, limit: 100 });
  });

  test('offset negativo/inválido -> 0 (nunca erro)', () => {
    assert.deepEqual(parsePaginacaoAtividades({ offset: '-5', limit: '20' }), { offset: 0, limit: 20 });
    assert.deepEqual(parsePaginacaoAtividades({ offset: 'abc', limit: '20' }), { offset: 0, limit: 20 });
  });

  test('limit ausente/inválido -> default 20 (nunca 0/negativo)', () => {
    assert.deepEqual(parsePaginacaoAtividades({ offset: '0', limit: '0' }), { offset: 0, limit: 20 });
    assert.deepEqual(parsePaginacaoAtividades({ offset: '0', limit: 'xyz' }), { offset: 0, limit: 20 });
  });
});

describe('map*Atividade — normalização por fonte', () => {
  test('mapFaturamentoAtividade', () => {
    assert.deepEqual(
      mapFaturamentoAtividade({ data_referencia: '2026-07-01', descricao: 'Entrega X', valor: '42.50' }),
      { tipo: 'faturamento', data: '2026-07-01', descricao: 'Entrega X', valor: 42.5 }
    );
  });

  test('mapPerformanceAtividade — descricao cai para subpraca quando periodo ausente', () => {
    assert.deepEqual(
      mapPerformanceAtividade({ data_periodo: '2026-07-02', periodo: null, subpraca: 'Zona Sul' }),
      { tipo: 'performance', data: '2026-07-02', descricao: 'Zona Sul', valor: null }
    );
  });

  test('mapValidacaoNfAtividade — data_emissao tem prioridade sobre criado_em', () => {
    assert.deepEqual(
      mapValidacaoNfAtividade({ data_emissao: '2026-07-03', criado_em: '2026-06-01T00:00:00Z', numnota: '123', valor: 99 }),
      { tipo: 'validacao_nf', data: '2026-07-03', descricao: '123', valor: 99 }
    );
  });

  test('mapValidacaoNfAtividade — sem data_emissao cai para criado_em', () => {
    const r = mapValidacaoNfAtividade({ data_emissao: null, criado_em: '2026-06-01T00:00:00Z', numnota: null, valor: null });
    assert.equal(r.data, '2026-06-01T00:00:00Z');
    assert.equal(r.descricao, null);
    assert.equal(r.valor, null);
  });
});

describe('montarAtividades — merge desc + paginação (task 6.4.2/6.4.3)', () => {
  test('une as 3 fontes e ordena desc por data', () => {
    const fatur = [{ data_referencia: '2026-07-01', descricao: 'F1', valor: 10 }];
    const perf = [{ data_periodo: '2026-07-03', periodo: 'Manhã', subpraca: null }];
    const valid = [{ data_emissao: '2026-07-02', criado_em: null, numnota: 'N1', valor: 5 }];
    const r = montarAtividades(fatur, perf, valid, 3, 0, 20);
    assert.equal(r.total, 3);
    assert.equal(r.offset, 0);
    assert.equal(r.limit, 20);
    assert.deepEqual(r.items.map((i) => i.tipo), ['performance', 'validacao_nf', 'faturamento']);
    assert.deepEqual(r.items.map((i) => i.data), ['2026-07-03', '2026-07-02', '2026-07-01']);
  });

  test('pagina corretamente (offset+limit) sobre o conjunto unificado', () => {
    const fatur = [
      { data_referencia: '2026-07-05', descricao: 'F1', valor: 1 },
      { data_referencia: '2026-07-01', descricao: 'F2', valor: 2 },
    ];
    const perf = [
      { data_periodo: '2026-07-04', periodo: 'P1', subpraca: null },
      { data_periodo: '2026-07-02', periodo: 'P2', subpraca: null },
    ];
    const r1 = montarAtividades(fatur, perf, [], 4, 0, 2);
    assert.deepEqual(r1.items.map((i) => i.data), ['2026-07-05', '2026-07-04']);
    const r2 = montarAtividades(fatur, perf, [], 4, 2, 2);
    assert.deepEqual(r2.items.map((i) => i.data), ['2026-07-02', '2026-07-01']);
  });

  test('motorista sem atividades -> items:[] sem erro (task 6.4.4)', () => {
    const r = montarAtividades([], [], [], 0, 0, 20);
    assert.deepEqual(r, { items: [], total: 0, offset: 0, limit: 20 });
  });

  test('fontes ausentes/undefined não lançam (defesa em profundidade)', () => {
    assert.doesNotThrow(() => montarAtividades(undefined, undefined, undefined, undefined, 0, 20));
  });
});
