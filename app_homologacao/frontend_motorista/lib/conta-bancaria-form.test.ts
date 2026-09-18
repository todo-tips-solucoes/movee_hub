/**
 * Teste unitário — lib/conta-bancaria-form.ts (tasks.md 6.4.4).
 *
 * Casos de borda espelhados de backend/tests/adiantamento-conta-unit.test.js
 * (documento inválido, banco fora da lista, zeros à esquerda).
 *
 *   node --experimental-strip-types --test lib/conta-bancaria-form.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validarDocumento,
  validarBanco,
  normalizarAgencia,
  validarConta,
  validarDigitoConta,
  validarChavePix,
  validarEmailComprovante,
  validarFormularioContaBancaria,
  type BancoOpcao,
  type DadosFormularioContaBancaria,
} from './conta-bancaria-form.ts';

const BANCOS: BancoOpcao[] = [
  { codigo: '077', nome: 'Banco Inter S.A.' },
  { codigo: '260', nome: 'Nu Pagamentos' },
];

// ── documento (CPF/CNPJ) ──────────────────────────────────────────────────

test('validarDocumento: CPF válido com máscara', () => {
  const r = validarDocumento('123.456.789-09');
  assert.equal(r.valido, true);
  assert.equal(r.tipo, 'PF');
});

test('validarDocumento: CNPJ válido com máscara', () => {
  const r = validarDocumento('11.222.333/0001-81');
  assert.equal(r.valido, true);
  assert.equal(r.tipo, 'PJ');
});

test('validarDocumento: documento inválido (DV errado) é recusado', () => {
  assert.equal(validarDocumento('123.456.789-00').valido, false);
});

test('validarDocumento: sequência de dígito repetido é recusada mesmo passando no DV', () => {
  assert.equal(validarDocumento('111.111.111-11').valido, false);
  assert.equal(validarDocumento('11.111.111/1111-11').valido, false);
});

test('validarDocumento: tamanho fora de CPF/CNPJ é recusado', () => {
  const r = validarDocumento('123');
  assert.equal(r.valido, false);
  assert.equal(r.tipo, null);
});

// ── banco: lista injetada, nunca fixture local ────────────────────────────

test('validarBanco: código presente na lista injetada é válido', () => {
  assert.equal(validarBanco('077', BANCOS), true);
});

test('validarBanco: código fora da lista injetada é recusado', () => {
  assert.equal(validarBanco('999', BANCOS), false);
});

test('validarBanco: lista vazia recusa qualquer código (nunca cai num fixture próprio)', () => {
  assert.equal(validarBanco('077', []), false);
});

test('validarBanco: código fora do formato 3 dígitos é recusado mesmo se "presente"', () => {
  assert.equal(validarBanco('77', [{ codigo: '77', nome: 'x' }]), false);
});

// ── agência: zero à esquerda preservado ───────────────────────────────────

test('normalizarAgencia: preenche com zero à esquerda até 4 dígitos', () => {
  assert.equal(normalizarAgencia('1'), '0001');
  assert.equal(normalizarAgencia('0001'), '0001');
});

test('normalizarAgencia: caractere não-dígito é recusado (nunca limpo em silêncio)', () => {
  assert.equal(normalizarAgencia('12a'), null);
});

test('normalizarAgencia: mais de 4 dígitos é recusado', () => {
  assert.equal(normalizarAgencia('12345'), null);
});

// ── conta / dígito ─────────────────────────────────────────────────────────

test('validarConta: zeros à esquerda preservados como válidos', () => {
  assert.equal(validarConta('00098812'), true);
});

test('validarConta: caractere não-dígito é recusado', () => {
  assert.equal(validarConta('12a34'), false);
});

test('validarDigitoConta: aceita um único dígito', () => {
  assert.equal(validarDigitoConta('0'), true);
  assert.equal(validarDigitoConta('10'), false);
  assert.equal(validarDigitoConta('X'), false);
});

// ── PIX por tipo ───────────────────────────────────────────────────────────

test('validarChavePix: CPF/CNPJ seguem a mesma validação de documento', () => {
  assert.equal(validarChavePix('CPF', '123.456.789-09'), true);
  assert.equal(validarChavePix('CNPJ', '123.456.789-09'), false); // é CPF, não CNPJ
});

test('validarChavePix: e-mail e telefone', () => {
  assert.equal(validarChavePix('EMAIL', 'joana@exemplo.com'), true);
  assert.equal(validarChavePix('EMAIL', 'invalido'), false);
  assert.equal(validarChavePix('TELEFONE', '(11) 98888-7777'), true);
  assert.equal(validarChavePix('TELEFONE', '123'), false);
});

test('validarChavePix: chave aleatória exige UUID v4', () => {
  assert.equal(validarChavePix('ALEATORIA', '550e8400-e29b-41d4-a716-446655440000'), true);
  assert.equal(validarChavePix('ALEATORIA', 'não-é-uuid'), false);
});

test('validarEmailComprovante: formato e limite de 254 chars', () => {
  assert.equal(validarEmailComprovante('joana@exemplo.com'), true);
  assert.equal(validarEmailComprovante('invalido'), false);
  assert.equal(validarEmailComprovante('a'.repeat(250) + '@x.co'), false);
});

// ── validação agregada do formulário (ordem = mesma do backend) ──────────

function dadosValidos(): DadosFormularioContaBancaria {
  return {
    titularNome: 'Joana Ribeiro Serviços',
    titularDocumento: '11.222.333/0001-81',
    bancoCodigo: '077',
    agencia: '1',
    conta: '0098812',
    contaDigito: '0',
    tipoConta: 'CORRENTE',
  };
}

test('validarFormularioContaBancaria: payload completo e válido', () => {
  const r = validarFormularioContaBancaria(dadosValidos(), BANCOS);
  assert.equal(r.valido, true);
});

test('validarFormularioContaBancaria: banco fora da lista aponta bancoCodigo', () => {
  const r = validarFormularioContaBancaria({ ...dadosValidos(), bancoCodigo: '999' }, BANCOS);
  assert.deepEqual(r, { valido: false, motivo: 'bancoCodigo' });
});

test('validarFormularioContaBancaria: documento inválido aponta titularDocumento', () => {
  const r = validarFormularioContaBancaria({ ...dadosValidos(), titularDocumento: '000.000.000-00' }, BANCOS);
  assert.deepEqual(r, { valido: false, motivo: 'titularDocumento' });
});

test('validarFormularioContaBancaria: chave PIX opcional inválida aponta chavePix', () => {
  const r = validarFormularioContaBancaria(
    { ...dadosValidos(), chavePixTipo: 'EMAIL', chavePix: 'invalido' },
    BANCOS,
  );
  assert.deepEqual(r, { valido: false, motivo: 'chavePix' });
});

test('validarFormularioContaBancaria: chave PIX e e-mail de comprovante ausentes (ambos opcionais) não bloqueiam', () => {
  const r = validarFormularioContaBancaria(dadosValidos(), BANCOS);
  assert.equal(r.valido, true);
});
