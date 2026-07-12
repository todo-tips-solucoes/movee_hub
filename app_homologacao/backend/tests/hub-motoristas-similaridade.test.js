/**
 * Testes unitários — lib/hub-motoristas-similaridade.js (tasks.md FASE 5,
 * 5.1.5). Rodam com: node --test tests/hub-motoristas-similaridade.test.js
 *
 * Cobre as funções PURAS (sem PostgREST/DB real): mapeamento
 * snake_case -> camelCase de candidato/conta elegível (incl. `jaVinculadoA`
 * null-vs-objeto e máscara de CNPJ) e o corte de tamanho mínimo do termo de
 * busca manual (`termoBuscaValido`, dec-038 — a ÚNICA checagem de "corte"
 * que vive em JS neste módulo; corte top-10/limiar 0.3 de similaridade
 * vivem no RPC, migration 0023, cobertos pelos testes de integração 5.2.3).
 *
 * `buscarCandidatos`/`buscarContasElegiveis` (I/O via hubPostgrestRequest)
 * não são exercitadas aqui — cobertas pelos testes de integração
 * (infra/hub/testes/hub-motoristas-integration.sh, tasks.md 5.1.5/5.2.3)
 * contra um hub-test efêmero real, mesmo padrão do resto do módulo.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  TERMO_BUSCA_MIN_CHARS,
  TERMO_BUSCA_ENTREGADOR_MIN_CHARS,
  LIMITE_BUSCA_ENTREGADOR,
  termoBuscaValido,
  mapCandidato,
  mapContaElegivel,
  mapEntregadorBusca,
} = require('../lib/hub-motoristas-similaridade');

describe('termoBuscaValido (corte mínimo do termo de busca manual)', () => {
  test('TERMO_BUSCA_MIN_CHARS = 2 (contracts/motoristas-api.md §contas-elegiveis)', () => {
    assert.equal(TERMO_BUSCA_MIN_CHARS, 2);
  });

  test('null/undefined -> false', () => {
    assert.equal(termoBuscaValido(null), false);
    assert.equal(termoBuscaValido(undefined), false);
  });

  test('não-string -> false', () => {
    assert.equal(termoBuscaValido(42), false);
    assert.equal(termoBuscaValido({}), false);
  });

  test('string vazia -> false', () => {
    assert.equal(termoBuscaValido(''), false);
  });

  test('só espaços -> false (trim antes do corte)', () => {
    assert.equal(termoBuscaValido('   '), false);
  });

  test('1 caractere (abaixo do corte) -> false', () => {
    assert.equal(termoBuscaValido('a'), false);
  });

  test('1 caractere + espaços ao redor (trim ainda deixa abaixo do corte) -> false', () => {
    assert.equal(termoBuscaValido('  a  '), false);
  });

  test('exatamente 2 caracteres (no corte) -> true', () => {
    assert.equal(termoBuscaValido('jo'), true);
  });

  test('2 caracteres úteis + espaços ao redor -> true (trim conta só o conteúdo)', () => {
    assert.equal(termoBuscaValido('  jo  '), true);
  });

  test('acima do corte -> true', () => {
    assert.equal(termoBuscaValido('carlos pereira'), true);
  });
});

describe('termoBuscaValido(termo, TERMO_BUSCA_ENTREGADOR_MIN_CHARS) — corte de 3 caracteres (hub-motorista-canonico FASE 2/WS-B, contracts §WS-B)', () => {
  test('TERMO_BUSCA_ENTREGADOR_MIN_CHARS = 3 (contracts/api-motorista-canonico.md §WS-B)', () => {
    assert.equal(TERMO_BUSCA_ENTREGADOR_MIN_CHARS, 3);
  });

  test('LIMITE_BUSCA_ENTREGADOR = 20 (contracts §WS-B — "até 20 itens")', () => {
    assert.equal(LIMITE_BUSCA_ENTREGADOR, 20);
  });

  test('default (sem 2º arg) continua o corte de 2 caracteres — nenhum caller existente quebra', () => {
    assert.equal(termoBuscaValido('jo'), true);
    assert.equal(termoBuscaValido('j'), false);
  });

  test('2 caracteres com o corte de entregador (3) -> false (abaixo do corte)', () => {
    assert.equal(termoBuscaValido('jo', TERMO_BUSCA_ENTREGADOR_MIN_CHARS), false);
  });

  test('exatamente 3 caracteres (no corte de entregador) -> true', () => {
    assert.equal(termoBuscaValido('joa', TERMO_BUSCA_ENTREGADOR_MIN_CHARS), true);
  });

  test('3 caracteres úteis + espaços ao redor -> true (trim ainda conta só o conteúdo)', () => {
    assert.equal(termoBuscaValido('  joa  ', TERMO_BUSCA_ENTREGADOR_MIN_CHARS), true);
  });

  test('null/undefined/não-string -> false mesmo com minChars explícito', () => {
    assert.equal(termoBuscaValido(null, TERMO_BUSCA_ENTREGADOR_MIN_CHARS), false);
    assert.equal(termoBuscaValido(undefined, TERMO_BUSCA_ENTREGADOR_MIN_CHARS), false);
    assert.equal(termoBuscaValido(42, TERMO_BUSCA_ENTREGADOR_MIN_CHARS), false);
  });

  test('termo contendo caracteres de wildcard LIKE (%, _) ainda respeita só o corte de tamanho — a defesa contra injeção vive no RPC parametrizado, não aqui', () => {
    assert.equal(termoBuscaValido('%_a', TERMO_BUSCA_ENTREGADOR_MIN_CHARS), true);
  });
});

describe('mapEntregadorBusca (GET /faturamento|performance/entregadores)', () => {
  test('mapeia {id, nome} sem transformação adicional', () => {
    const row = { id: 42, nome: 'Carlos Pereira' };
    assert.deepEqual(mapEntregadorBusca(row), { id: 42, nome: 'Carlos Pereira' });
  });

  test('não vaza campos extras da linha do RPC (ex.: colunas auxiliares futuras)', () => {
    const row = { id: 7, nome: 'Ana', id_empresa: 9001, algum_campo_extra: 'x' };
    const mapeado = mapEntregadorBusca(row);
    assert.deepEqual(mapeado, { id: 7, nome: 'Ana' });
    assert.equal('id_empresa' in mapeado, false);
    assert.equal('algum_campo_extra' in mapeado, false);
  });
});

describe('mapCandidato (GET /motoristas/:id/sugestoes)', () => {
  test('mapeia todos os campos snake_case -> camelCase', () => {
    const row = {
      conta_motorista_id: 7,
      nome: 'Carlos Pereira',
      cnpj_prestador: '12345678000195',
      similaridade: 0.87,
      ja_vinculado_a: null,
      ja_vinculado_a_nome: null,
    };
    assert.deepEqual(mapCandidato(row), {
      contaMotoristaId: 7,
      nome: 'Carlos Pereira',
      cnpjPrestadorMascarado: '12.***.***/0001-**',
      similaridade: 0.87,
      jaVinculadoA: null,
    });
  });

  test('ja_vinculado_a presente -> jaVinculadoA = {entregadorId, nome}', () => {
    const row = {
      conta_motorista_id: 7,
      nome: 'Carlos Pereira',
      cnpj_prestador: '12345678000195',
      similaridade: 1,
      ja_vinculado_a: 42,
      ja_vinculado_a_nome: 'Outra Pessoa Entregadora',
    };
    assert.deepEqual(mapCandidato(row).jaVinculadoA, {
      entregadorId: 42,
      nome: 'Outra Pessoa Entregadora',
    });
  });

  test('cnpj_prestador inválido/curto -> cnpjPrestadorMascarado=null (nunca lança)', () => {
    const row = {
      conta_motorista_id: 1,
      nome: 'X',
      cnpj_prestador: '123',
      similaridade: 0.5,
      ja_vinculado_a: null,
      ja_vinculado_a_nome: null,
    };
    assert.equal(mapCandidato(row).cnpjPrestadorMascarado, null);
  });

  test('preserva a ordenação por similaridade decrescente já entregue pelo RPC (map não reordena)', () => {
    const rows = [
      { conta_motorista_id: 1, nome: 'A', cnpj_prestador: '11111111000100', similaridade: 0.9, ja_vinculado_a: null, ja_vinculado_a_nome: null },
      { conta_motorista_id: 2, nome: 'B', cnpj_prestador: '22222222000100', similaridade: 0.6, ja_vinculado_a: null, ja_vinculado_a_nome: null },
      { conta_motorista_id: 3, nome: 'C', cnpj_prestador: '33333333000100', similaridade: 0.31, ja_vinculado_a: null, ja_vinculado_a_nome: null },
    ];
    const mapeados = rows.map(mapCandidato);
    assert.deepEqual(mapeados.map((m) => m.contaMotoristaId), [1, 2, 3]);
    assert.deepEqual(mapeados.map((m) => m.similaridade), [0.9, 0.6, 0.31]);
  });
});

describe('mapContaElegivel (GET /motoristas/contas-elegiveis)', () => {
  test('mapeia todos os campos snake_case -> camelCase, sem campo similaridade', () => {
    const row = {
      conta_motorista_id: 9,
      nome: 'Fulano da Silva',
      cnpj_prestador: '98765432000110',
      ja_vinculado_a: null,
      ja_vinculado_a_nome: null,
      total: 3,
    };
    const mapeado = mapContaElegivel(row);
    assert.deepEqual(mapeado, {
      contaMotoristaId: 9,
      nome: 'Fulano da Silva',
      cnpjPrestadorMascarado: '98.***.***/0001-**',
      jaVinculadoA: null,
    });
    assert.equal('similaridade' in mapeado, false);
    // `total` (coluna auxiliar de paginação do RPC) nunca vaza para o item mapeado.
    assert.equal('total' in mapeado, false);
  });

  test('ja_vinculado_a presente -> jaVinculadoA = {entregadorId, nome}', () => {
    const row = {
      conta_motorista_id: 9,
      nome: 'Fulano da Silva',
      cnpj_prestador: '98765432000110',
      ja_vinculado_a: 5,
      ja_vinculado_a_nome: 'Beltrano',
      total: 1,
    };
    assert.deepEqual(mapContaElegivel(row).jaVinculadoA, { entregadorId: 5, nome: 'Beltrano' });
  });
});
