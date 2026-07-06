/**
 * Testes unitários — hub-fundacoes /api/v1/auth/* (FASE 3, task 3.1.6/3.2.3/3.3.6)
 * Rodam com: node --test tests/hub-auth-unit.test.js
 *
 * Mesma convenção de tests/motorista-unit.test.js: mantemos CÓPIAS LOCAIS das
 * funções puras extraídas de routes/hub-auth.js (em vez de `require` do router
 * Express, que depende de bcrypt/express/express-rate-limit instalados —
 * indisponíveis fora do container Dockerfile.hub). As cópias abaixo usam
 * somente `node:crypto` (builtin), então rodam em qualquer ambiente Node,
 * inclusive fora do hub-test.
 *
 * Cobre:
 *   - normalizarEmail / formatoEmailValido
 *   - hashToken (determinístico, sha256) / gerarTokenBruto (entropia, unicidade)
 *   - calcularBloqueioAposFalha (FR-017: 5 falhas -> bloqueado_ate = +15min)
 *   - contaEstaBloqueada (janela de bloqueio)
 *
 * O caminho dummy-hash (bcrypt.compare contra BCRYPT_DUMMY_HASH) e o fluxo
 * completo de bloqueio contra o banco são exercidos no teste de integração
 * (hub-test, ainda a implementar) — aqui cobrimos só a lógica pura.
 *
 * Ref: contracts/auth.md, research.md Decisions 8/9, tasks.md 3.1.6/3.3.6.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// ──────────────────────────────────────────────────────────────────────────────
// Cópias locais das funções puras (espelho de routes/hub-auth.js)
// ──────────────────────────────────────────────────────────────────────────────

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BLOQUEIO_FALHAS_LIMITE = 5;
const BLOQUEIO_JANELA_MS = 15 * 60 * 1000;

function normalizarEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function formatoEmailValido(email) {
  return EMAIL_REGEX.test(email);
}

function hashToken(tokenBruto) {
  return crypto.createHash('sha256').update(tokenBruto).digest('hex');
}

function gerarTokenBruto() {
  return crypto.randomBytes(32).toString('hex');
}

function calcularBloqueioAposFalha(tentativasAtuais, agora) {
  const tentativas = (tentativasAtuais || 0) + 1;
  if (tentativas >= BLOQUEIO_FALHAS_LIMITE) {
    return { tentativas_login: tentativas, bloqueado_ate: new Date(agora.getTime() + BLOQUEIO_JANELA_MS).toISOString() };
  }
  return { tentativas_login: tentativas, bloqueado_ate: null };
}

function contaEstaBloqueada(usuario, agora) {
  return Boolean(usuario.bloqueado_ate) && new Date(usuario.bloqueado_ate) > agora;
}

// ──────────────────────────────────────────────────────────────────────────────
// normalizarEmail / formatoEmailValido
// ──────────────────────────────────────────────────────────────────────────────

describe('normalizarEmail', () => {
  test('trima e faz lowercase', () => {
    assert.equal(normalizarEmail('  Foo@Bar.COM  '), 'foo@bar.com');
  });

  test('undefined/null vira string vazia', () => {
    assert.equal(normalizarEmail(undefined), '');
    assert.equal(normalizarEmail(null), '');
  });
});

describe('formatoEmailValido', () => {
  test('aceita formato válido', () => {
    assert.equal(formatoEmailValido('foo@bar.com'), true);
  });

  test('rejeita sem @ ou sem domínio', () => {
    assert.equal(formatoEmailValido('foobar.com'), false);
    assert.equal(formatoEmailValido('foo@bar'), false);
    assert.equal(formatoEmailValido(''), false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// hashToken / gerarTokenBruto (Decision 9 — hash-only, crypto.randomBytes(32))
// ──────────────────────────────────────────────────────────────────────────────

describe('hashToken', () => {
  test('é determinístico (mesmo input -> mesmo hash)', () => {
    const bruto = 'token-de-teste-fixo';
    assert.equal(hashToken(bruto), hashToken(bruto));
  });

  test('produz sha256 hex (64 chars)', () => {
    const h = hashToken('qualquer-coisa');
    assert.equal(h.length, 64);
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  test('inputs diferentes produzem hashes diferentes', () => {
    assert.notEqual(hashToken('a'), hashToken('b'));
  });
});

describe('gerarTokenBruto', () => {
  test('produz 256 bits de entropia (32 bytes -> 64 hex chars)', () => {
    const t = gerarTokenBruto();
    assert.equal(t.length, 64);
    assert.match(t, /^[0-9a-f]{64}$/);
  });

  test('é único a cada chamada (sem colisão em 1000 amostras)', () => {
    const vistos = new Set();
    for (let i = 0; i < 1000; i++) {
      vistos.add(gerarTokenBruto());
    }
    assert.equal(vistos.size, 1000);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// calcularBloqueioAposFalha / contaEstaBloqueada (FR-017)
// ──────────────────────────────────────────────────────────────────────────────

describe('calcularBloqueioAposFalha', () => {
  test('1ª a 4ª falha: incrementa sem bloquear', () => {
    const agora = new Date('2026-07-06T12:00:00Z');
    for (let tentativasAtuais = 0; tentativasAtuais < 4; tentativasAtuais++) {
      const r = calcularBloqueioAposFalha(tentativasAtuais, agora);
      assert.equal(r.tentativas_login, tentativasAtuais + 1);
      assert.equal(r.bloqueado_ate, null);
    }
  });

  test('5ª falha consecutiva: bloqueia por 15 minutos', () => {
    const agora = new Date('2026-07-06T12:00:00Z');
    const r = calcularBloqueioAposFalha(4, agora);
    assert.equal(r.tentativas_login, 5);
    assert.equal(r.bloqueado_ate, new Date(agora.getTime() + 15 * 60 * 1000).toISOString());
  });

  test('falhas além da 5ª continuam bloqueando (idempotente na direção certa)', () => {
    const agora = new Date('2026-07-06T12:00:00Z');
    const r = calcularBloqueioAposFalha(9, agora);
    assert.equal(r.tentativas_login, 10);
    assert.notEqual(r.bloqueado_ate, null);
  });
});

describe('contaEstaBloqueada', () => {
  test('sem bloqueado_ate -> não bloqueada', () => {
    assert.equal(contaEstaBloqueada({ bloqueado_ate: null }, new Date()), false);
  });

  test('bloqueado_ate no futuro -> bloqueada', () => {
    const agora = new Date('2026-07-06T12:00:00Z');
    const futuro = new Date(agora.getTime() + 60 * 1000).toISOString();
    assert.equal(contaEstaBloqueada({ bloqueado_ate: futuro }, agora), true);
  });

  test('bloqueado_ate no passado -> não bloqueada (janela expirou)', () => {
    const agora = new Date('2026-07-06T12:00:00Z');
    const passado = new Date(agora.getTime() - 60 * 1000).toISOString();
    assert.equal(contaEstaBloqueada({ bloqueado_ate: passado }, agora), false);
  });
});
