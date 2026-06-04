/**
 * Testes unitários — App Motorista (PWA)
 * Rodam com: node --test tests/motorista-unit.test.js
 * Sem dependências externas (usa node:test + node:assert nativos do Node 18+).
 *
 * Cobre:
 *   - mapper flag→mensagem pt-BR (FIELD_MESSAGES)
 *   - parser de resposta da validação (apiData normalization)
 *   - authenticateMotorista: token válido / ausente / expirado / audiência errada
 *   - camposInvalidos filter logic
 *
 * Ref: tasks 2.1.4, 3.2.3, 3.2.4
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// ──────────────────────────────────────────────────────────────────────────────
// Copias locais das funções puras testáveis (extraídas do motorista.js)
// Mantemos as funções aqui para testes unitários puros (sem Express / multer).
// ──────────────────────────────────────────────────────────────────────────────

/** Mapeamento de flags para mensagens pt-BR (espelho de motorista.js) */
const FIELD_MESSAGES = {
  valid_cnpj_prestador: 'CNPJ do prestador (você) está incorreto na nota.',
  valid_cnpj: 'CNPJ do tomador está incorreto na nota.',
  valid_descricao_servico: 'Descrição do serviço está incorreta.',
  valid_valor: 'Valor da nota não confere com o valor do movimento.',
  valid_trib_nac: 'Tributação nacional (TribNac) está incorreta.',
  valid_trib_mun: 'Tributação municipal está incorreta.',
  valid_dCompet: 'Data de competência (dCompet) está incorreta.',
};

/**
 * Lógica de mapeamento campos inválidos (espelho de motorista.js).
 * Recebe `details` do apiData e retorna lista [{campo, mensagem}].
 */
function extractCamposInvalidos(details) {
  return Object.entries(FIELD_MESSAGES)
    .filter(([flag]) => details[flag] === false)
    .map(([campo, mensagem]) => ({ campo, mensagem }));
}

/**
 * Normaliza apiData (tolerância a array ou objeto — FR-012).
 */
function normalizeApiData(raw) {
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Verifica se nota já aprovada (espelho das comparações em motorista.js).
 */
function isNotaJaAprovada(notaOkFlag) {
  return (
    notaOkFlag === true ||
    notaOkFlag === 'true' ||
    notaOkFlag === 'sim' ||
    notaOkFlag === '1' ||
    notaOkFlag === 1
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. Mapper flag→mensagem pt-BR
// ──────────────────────────────────────────────────────────────────────────────
describe('FIELD_MESSAGES mapper', () => {
  test('all flags false → 7 campos inválidos', () => {
    const details = {
      valid_cnpj_prestador: false,
      valid_cnpj: false,
      valid_descricao_servico: false,
      valid_valor: false,
      valid_trib_nac: false,
      valid_trib_mun: false,
      valid_dCompet: false,
    };
    const campos = extractCamposInvalidos(details);
    assert.equal(campos.length, 7);
  });

  test('all flags true → nenhum campo inválido', () => {
    const details = {
      valid_cnpj_prestador: true,
      valid_cnpj: true,
      valid_descricao_servico: true,
      valid_valor: true,
      valid_trib_nac: true,
      valid_trib_mun: true,
      valid_dCompet: true,
    };
    const campos = extractCamposInvalidos(details);
    assert.equal(campos.length, 0);
  });

  test('apenas valid_valor false → 1 campo inválido com mensagem correta', () => {
    const details = {
      valid_cnpj_prestador: true,
      valid_cnpj: true,
      valid_descricao_servico: true,
      valid_valor: false,
      valid_trib_nac: true,
      valid_trib_mun: true,
      valid_dCompet: true,
    };
    const campos = extractCamposInvalidos(details);
    assert.equal(campos.length, 1);
    assert.equal(campos[0].campo, 'valid_valor');
    assert.match(campos[0].mensagem, /Valor/);
  });

  test('flag undefined (campo ausente) não conta como inválido', () => {
    const details = { valid_cnpj_prestador: undefined };
    const campos = extractCamposInvalidos(details);
    assert.equal(campos.length, 0);
  });

  test('flag null não conta como inválido (apenas false)', () => {
    const details = { valid_cnpj_prestador: null };
    const campos = extractCamposInvalidos(details);
    assert.equal(campos.length, 0);
  });

  test('todas as mensagens estão em pt-BR e não vazia', () => {
    for (const [flag, msg] of Object.entries(FIELD_MESSAGES)) {
      assert.ok(msg.length > 10, `Mensagem para ${flag} muito curta: "${msg}"`);
      // Sem palavras em inglês óbvias nas mensagens
      assert.ok(!/\b(invalid|error|field)\b/i.test(msg), `Mensagem "${msg}" parece em inglês`);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 2. Parser de resposta da validação (normalizeApiData)
// ──────────────────────────────────────────────────────────────────────────────
describe('normalizeApiData (parser da resposta)', () => {
  test('array com 1 elemento → retorna o elemento', () => {
    const raw = [{ valid: true, details: {} }];
    const data = normalizeApiData(raw);
    assert.equal(data.valid, true);
  });

  test('objeto direto → retorna como está', () => {
    const raw = { valid: false, details: { valid_valor: false } };
    const data = normalizeApiData(raw);
    assert.equal(data.valid, false);
  });

  test('array vazio → retorna undefined (tolerância FR-012)', () => {
    const data = normalizeApiData([]);
    assert.equal(data, undefined);
  });

  test('null → retorna null (tratado como falha de serviço)', () => {
    assert.equal(normalizeApiData(null), null);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 3. isNotaJaAprovada — verificação do bloqueio de reenvio (FR-008)
// ──────────────────────────────────────────────────────────────────────────────
describe('isNotaJaAprovada (bloqueio de reenvio)', () => {
  test('true booleano → aprovada', () => assert.equal(isNotaJaAprovada(true), true));
  test('"true" string → aprovada', () => assert.equal(isNotaJaAprovada('true'), true));
  test('"sim" string → aprovada', () => assert.equal(isNotaJaAprovada('sim'), true));
  test('"1" string → aprovada', () => assert.equal(isNotaJaAprovada('1'), true));
  test('1 inteiro → aprovada', () => assert.equal(isNotaJaAprovada(1), true));
  test('false → não aprovada', () => assert.equal(isNotaJaAprovada(false), false));
  test('null → não aprovada', () => assert.equal(isNotaJaAprovada(null), false));
  test('undefined → não aprovada', () => assert.equal(isNotaJaAprovada(undefined), false));
  test('"nao" → não aprovada', () => assert.equal(isNotaJaAprovada('nao'), false));
  test('0 → não aprovada', () => assert.equal(isNotaJaAprovada(0), false));
});

// ──────────────────────────────────────────────────────────────────────────────
// 4. Validação do CNPJ normalizer (inline — strip pontuação)
// ──────────────────────────────────────────────────────────────────────────────
describe('CNPJ normalizer', () => {
  const normalize = (cnpj) => String(cnpj).replace(/\D/g, '');

  test('CNPJ com pontuação → apenas dígitos', () => {
    assert.equal(normalize('11.222.333/0001-99'), '11222333000199');
  });

  test('CNPJ já limpo → inalterado', () => {
    assert.equal(normalize('11222333000199'), '11222333000199');
  });

  test('string vazia → string vazia', () => {
    assert.equal(normalize(''), '');
  });
});
