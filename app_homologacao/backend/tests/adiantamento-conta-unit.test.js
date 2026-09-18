/**
 * Testes unitários — lib/adiantamento-conta.js (tasks.md 2.2).
 * Rodam com: node --test tests/adiantamento-conta-unit.test.js
 *
 * CPFs/CNPJ usados são os exemplos didáticos padrão de qualquer tutorial de
 * validação de documento no Brasil (123.456.789-09, 987.654.321-00,
 * 11.222.333/0001-81) — dígito verificador matematicamente válido, sem
 * nenhum dado pessoal real.
 *
 * Ref: contracts/motorista-api.md §POST conta-bancaria/solicitacoes;
 * Spec §FR-015, §FR-016, §FR-055; security CHK018.
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  validarDocumento,
  validarBanco,
  normalizarAgencia,
  validarConta,
  validarDigitoConta,
  validarChavePix,
  validarEmailComprovante,
  documentoMascarado,
  contaMascarada,
  validarContaBancaria,
} = require('../lib/adiantamento-conta');

const CPF_VALIDO = '12345678909';
const CPF_VALIDO_MASCARADO = '987.654.321-00';
const CNPJ_VALIDO = '11222333000181';
const CNPJ_VALIDO_MASCARADO = '11.222.333/0001-81';

describe('validarDocumento() — DV de CPF/CNPJ (2.2.1)', () => {
  test('CPF válido sem máscara', () => {
    const r = validarDocumento(CPF_VALIDO);
    assert.equal(r.valido, true);
    assert.equal(r.tipo, 'PF');
    assert.equal(r.documento, CPF_VALIDO);
  });

  test('CPF válido com máscara', () => {
    const r = validarDocumento(CPF_VALIDO_MASCARADO);
    assert.equal(r.valido, true);
    assert.equal(r.tipo, 'PF');
    assert.equal(r.documento, '98765432100');
  });

  test('CNPJ válido com máscara', () => {
    const r = validarDocumento(CNPJ_VALIDO_MASCARADO);
    assert.equal(r.valido, true);
    assert.equal(r.tipo, 'PJ');
    assert.equal(r.documento, CNPJ_VALIDO);
  });

  test('CPF com DV errado é recusado (edge #16)', () => {
    const r = validarDocumento('12345678900');
    assert.equal(r.valido, false);
  });

  test('CNPJ com DV errado é recusado', () => {
    const r = validarDocumento('11222333000199');
    assert.equal(r.valido, false);
  });

  test('sequência de dígito repetido é recusada mesmo passando na fórmula de DV', () => {
    assert.equal(validarDocumento('11111111111').valido, false);
    assert.equal(validarDocumento('00000000000000').valido, false);
  });

  test('tamanho fora de 11/14 é recusado', () => {
    assert.equal(validarDocumento('123').valido, false);
    assert.equal(validarDocumento('').valido, false);
  });
});

describe('validarBanco() — lista COMPE (2.2.2)', () => {
  test('banco existente (001) é aceito', () => {
    assert.equal(validarBanco('001').valido, true);
  });

  test('banco fora da lista é recusado', () => {
    assert.equal(validarBanco('999').valido, false);
  });

  test('código sem 3 dígitos é recusado (nunca convertido para número)', () => {
    assert.equal(validarBanco('1').valido, false);
    assert.equal(validarBanco(1).valido, false);
  });
});

describe('normalizarAgencia() / validarConta() / validarDigitoConta() — zeros preservados (2.2.3, 2.2.8)', () => {
  test('agência de 1 dígito normaliza para 4 com zero à esquerda', () => {
    assert.equal(normalizarAgencia('1'), '0001');
  });

  test('agência já com 4 dígitos e zero à esquerda não perde o zero', () => {
    assert.equal(normalizarAgencia('0042'), '0042');
  });

  test('agência com mais de 4 dígitos é recusada', () => {
    assert.equal(normalizarAgencia('12345'), null);
  });

  test('agência com letra no lugar de dígito é recusada, nunca limpa em silêncio (2.6.3)', () => {
    // "12O4" tem um "O" (letra) no lugar do zero — a agência real é outra;
    // aceitar silenciosamente ("0124") gravaria a conta errada.
    assert.equal(normalizarAgencia('12O4'), null);
  });

  test('agência com pontuação é recusada (2.6.3)', () => {
    assert.equal(normalizarAgencia('12-4'), null);
  });

  test('conta com zeros à esquerda preservada byte-a-byte', () => {
    const r = validarConta('00004521');
    assert.equal(r.valido, true);
    assert.equal(r.conta, '00004521');
  });

  test('conta de 20 dígitos é aceita; 21 é recusada', () => {
    assert.equal(validarConta('1'.repeat(20)).valido, true);
    assert.equal(validarConta('1'.repeat(21)).valido, false);
  });

  test('dígito da conta "0" é preservado (não vira falsy)', () => {
    assert.equal(validarDigitoConta('0'), true);
  });

  test('dígito da conta com mais de 1 caractere é recusado', () => {
    assert.equal(validarDigitoConta('12'), false);
  });
});

describe('validarChavePix() por tipo (2.2.4)', () => {
  test('CPF válido como chave PIX', () => {
    assert.equal(validarChavePix('CPF', CPF_VALIDO), true);
  });

  test('CNPJ como chave PIX tipo CPF é recusado (tipo errado)', () => {
    assert.equal(validarChavePix('CPF', CNPJ_VALIDO), false);
  });

  test('e-mail válido', () => {
    assert.equal(validarChavePix('EMAIL', 'motorista@example.com'), true);
  });

  test('telefone com DDD (11 dígitos)', () => {
    assert.equal(validarChavePix('TELEFONE', '11987654321'), true);
  });

  test('chave aleatória precisa ser UUID v4', () => {
    assert.equal(validarChavePix('ALEATORIA', '550e8400-e29b-41d4-a716-446655440000'), true);
    assert.equal(validarChavePix('ALEATORIA', 'não-é-uuid'), false);
  });

  test('tipo desconhecido é recusado', () => {
    assert.equal(validarChavePix('BITCOIN', 'x'), false);
  });
});

describe('validarEmailComprovante() (2.2.4)', () => {
  test('e-mail válido até 254 caracteres', () => {
    assert.equal(validarEmailComprovante('a@b.com'), true);
  });

  test('e-mail acima de 254 caracteres é recusado', () => {
    const longo = `${'a'.repeat(250)}@b.com`;
    assert.equal(validarEmailComprovante(longo), false);
  });

  test('formato inválido é recusado', () => {
    assert.equal(validarEmailComprovante('não-é-email'), false);
  });
});

describe('máscaras de exibição — documentoMascarado / contaMascarada (2.2.5)', () => {
  test('CPF mascarado preserva pontuação e últimos 2 dígitos', () => {
    assert.equal(documentoMascarado(CPF_VALIDO), '***.***.***-09');
  });

  test('CNPJ mascarado preserva pontuação e últimos 2 dígitos', () => {
    assert.equal(documentoMascarado(CNPJ_VALIDO), '**.***.***/****-81');
  });

  test('conta mascarada mostra os últimos 4 dígitos + dígito', () => {
    assert.equal(contaMascarada('00004521', '7'), '••••4521-7');
  });

  test('conta curta (<=4) fica toda mascarada', () => {
    assert.equal(contaMascarada('42', '1'), '••-1');
  });
});

describe('validarContaBancaria() — payload completo, campo exato recusado (2.2.7)', () => {
  const payloadBase = () => ({
    titularNome: 'Fulano de Tal',
    titularDocumento: CPF_VALIDO,
    bancoCodigo: '260',
    agencia: '1',
    conta: '00004521',
    contaDigito: '7',
    tipoConta: 'CORRENTE',
  });

  test('payload válido sem PIX/e-mail', () => {
    const r = validarContaBancaria(payloadBase());
    assert.equal(r.valido, true);
    assert.equal(r.dados.agencia, '0001');
    assert.equal(r.dados.conta, '00004521');
    assert.equal(r.dados.bancoNome, 'NU PAGAMENTOS - IP');
  });

  test('documento inválido -> motivo=titularDocumento', () => {
    const r = validarContaBancaria({ ...payloadBase(), titularDocumento: '11111111111' });
    assert.equal(r.valido, false);
    assert.equal(r.motivo, 'titularDocumento');
  });

  test('banco fora da lista -> motivo=bancoCodigo', () => {
    const r = validarContaBancaria({ ...payloadBase(), bancoCodigo: '999' });
    assert.equal(r.valido, false);
    assert.equal(r.motivo, 'bancoCodigo');
  });

  test('agência inválida -> motivo=agencia', () => {
    const r = validarContaBancaria({ ...payloadBase(), agencia: 'abcde' });
    assert.equal(r.valido, false);
    assert.equal(r.motivo, 'agencia');
  });

  test('agência com letra misturada a dígitos -> motivo=agencia (2.6.3, edge #21)', () => {
    const r = validarContaBancaria({ ...payloadBase(), agencia: '12O4' });
    assert.equal(r.valido, false);
    assert.equal(r.motivo, 'agencia');
  });

  test('tipo de conta fora da lista -> motivo=tipoConta', () => {
    const r = validarContaBancaria({ ...payloadBase(), tipoConta: 'INVESTIMENTO' });
    assert.equal(r.valido, false);
    assert.equal(r.motivo, 'tipoConta');
  });

  test('chave PIX informada sem tipo válido -> motivo=chavePixTipo', () => {
    const r = validarContaBancaria({ ...payloadBase(), chavePixTipo: 'BITCOIN', chavePix: 'x' });
    assert.equal(r.valido, false);
    assert.equal(r.motivo, 'chavePixTipo');
  });

  test('chave PIX inválida para o tipo -> motivo=chavePix', () => {
    const r = validarContaBancaria({ ...payloadBase(), chavePixTipo: 'EMAIL', chavePix: 'não-é-email' });
    assert.equal(r.valido, false);
    assert.equal(r.motivo, 'chavePix');
  });

  test('e-mail de comprovante inválido -> motivo=emailComprovante', () => {
    const r = validarContaBancaria({ ...payloadBase(), emailComprovante: 'não-é-email' });
    assert.equal(r.valido, false);
    assert.equal(r.motivo, 'emailComprovante');
  });

  test('chave PIX CPF mascarada é gravada só com dígitos (2.6.3)', () => {
    const r = validarContaBancaria({ ...payloadBase(), chavePixTipo: 'CPF', chavePix: CPF_VALIDO_MASCARADO });
    assert.equal(r.valido, true);
    assert.equal(r.dados.chavePix, '98765432100');
  });

  test('chave PIX CNPJ mascarada é gravada só com dígitos (2.6.3)', () => {
    const r = validarContaBancaria({ ...payloadBase(), chavePixTipo: 'CNPJ', chavePix: CNPJ_VALIDO_MASCARADO });
    assert.equal(r.valido, true);
    assert.equal(r.dados.chavePix, CNPJ_VALIDO);
  });

  test('chave PIX TELEFONE mascarada é gravada só com dígitos (2.6.3)', () => {
    const r = validarContaBancaria({ ...payloadBase(), chavePixTipo: 'TELEFONE', chavePix: '(11) 91234-5678' });
    assert.equal(r.valido, true);
    assert.equal(r.dados.chavePix, '11912345678');
  });

  test('chave PIX EMAIL é gravada como recebida (não é dígito)', () => {
    const r = validarContaBancaria({ ...payloadBase(), chavePixTipo: 'EMAIL', chavePix: 'fulano@example.com' });
    assert.equal(r.valido, true);
    assert.equal(r.dados.chavePix, 'fulano@example.com');
  });
});

describe('cross-referência FR-016 x FR-055 (2.2.6, security CHK018)', () => {
  test('a mesma agência normalizada (4 dígitos) é o valor exportado à Transfeera', () => {
    const r = validarContaBancaria({
      titularNome: 'Fulano de Tal',
      titularDocumento: CPF_VALIDO,
      bancoCodigo: '260',
      agencia: '7',
      conta: '123',
      contaDigito: '4',
      tipoConta: 'POUPANCA',
    });
    assert.equal(r.dados.agencia.length, 4); // FR-016 (validação) == FR-055 (exportação)
    assert.equal(r.dados.bancoCodigo.length, 3);
  });
});
