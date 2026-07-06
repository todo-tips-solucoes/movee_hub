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

// ── Correções pós-review PR #55 — cópias locais das novas funções puras ──────

// (#6) entradaLoginValida — guard de TIPO antes de qualquer bcrypt.compare.
function entradaLoginValida(emailBruto, senhaBruta) {
  if (typeof emailBruto !== 'string' || typeof senhaBruta !== 'string') return false;
  if (senhaBruta.length === 0) return false;
  const email = normalizarEmail(emailBruto);
  return Boolean(email) && formatoEmailValido(email);
}

// (#4) classificarCredencial — desfecho pós-bcrypt.compare no /login.
function classificarCredencial(usuario, senhaValida) {
  if (!usuario.ativo) return 'inativa';
  if (!senhaValida) return 'senha_incorreta';
  return 'sucesso';
}

// (#5) classificarSessaoRefresh — reuso vs expiração natural vs válida.
function classificarSessaoRefresh(sessao, agora) {
  if (sessao.revogado_em) return 'reuso';
  if (new Date(sessao.expira_em) < agora) return 'expirada';
  return 'valida';
}

// (#3) patchRedefinicaoSenha — espelho do PATCH de /redefinir-senha (só os
// campos de estado de conta relevantes ao review: desbloqueio + reset).
function patchRedefinicaoSenha() {
  return { token_recuperacao_hash: null, token_recuperacao_expira: null, tentativas_login: 0, bloqueado_ate: null };
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

// ──────────────────────────────────────────────────────────────────────────────
// Correções pós-review PR #55
// ──────────────────────────────────────────────────────────────────────────────

describe('entradaLoginValida (#6 — senha/email não-string vira 401, nunca 500)', () => {
  test('senha numérica é rejeitada (não chega ao bcrypt.compare)', () => {
    assert.equal(entradaLoginValida('foo@bar.com', 12345), false);
  });

  test('email não-string é rejeitado', () => {
    assert.equal(entradaLoginValida({ obj: 1 }, 'SenhaOk#1'), false);
    assert.equal(entradaLoginValida(undefined, 'SenhaOk#1'), false);
  });

  test('senha string vazia é rejeitada', () => {
    assert.equal(entradaLoginValida('foo@bar.com', ''), false);
  });

  test('email formato inválido é rejeitado mesmo com senha string', () => {
    assert.equal(entradaLoginValida('foobar', 'SenhaOk#1'), false);
  });

  test('email + senha string válidos -> true', () => {
    assert.equal(entradaLoginValida('  Foo@Bar.com ', 'SenhaOk#1'), true);
  });
});

describe('classificarCredencial (#4 — conta inativa não acumula bloqueio)', () => {
  test('conta inativa (mesmo com senha correta) -> "inativa" (sem contabilizar falha)', () => {
    assert.equal(classificarCredencial({ ativo: false }, true), 'inativa');
  });

  test('conta inativa com senha errada -> "inativa" (também não incrementa)', () => {
    assert.equal(classificarCredencial({ ativo: false }, false), 'inativa');
  });

  test('conta ativa + senha errada -> "senha_incorreta" (contabiliza falha, FR-017)', () => {
    assert.equal(classificarCredencial({ ativo: true }, false), 'senha_incorreta');
  });

  test('conta ativa + senha correta -> "sucesso"', () => {
    assert.equal(classificarCredencial({ ativo: true }, true), 'sucesso');
  });
});

describe('classificarSessaoRefresh (#5 — expiração natural não revoga a família)', () => {
  const agora = new Date('2026-07-06T12:00:00Z');

  test('sessão revogada reapresentada -> "reuso" (revoga família toda)', () => {
    const s = { revogado_em: '2026-07-06T11:00:00Z', expira_em: '2026-07-13T12:00:00Z' };
    assert.equal(classificarSessaoRefresh(s, agora), 'reuso');
  });

  test('sessão ainda ativa mas expira_em no passado -> "expirada" (benigna, só este device)', () => {
    const s = { revogado_em: null, expira_em: '2026-07-06T11:59:00Z' };
    assert.equal(classificarSessaoRefresh(s, agora), 'expirada');
  });

  test('reuso tem precedência sobre expiração (revogada E expirada -> "reuso")', () => {
    const s = { revogado_em: '2026-07-05T12:00:00Z', expira_em: '2026-07-06T11:00:00Z' };
    assert.equal(classificarSessaoRefresh(s, agora), 'reuso');
  });

  test('sessão ativa e dentro da validade -> "valida"', () => {
    const s = { revogado_em: null, expira_em: '2026-07-13T12:00:00Z' };
    assert.equal(classificarSessaoRefresh(s, agora), 'valida');
  });
});

describe('patchRedefinicaoSenha (#3 — redefinir senha desbloqueia a conta)', () => {
  test('zera tentativas_login e bloqueado_ate (além de invalidar o token)', () => {
    const p = patchRedefinicaoSenha();
    assert.equal(p.tentativas_login, 0);
    assert.equal(p.bloqueado_ate, null);
    assert.equal(p.token_recuperacao_hash, null);
    assert.equal(p.token_recuperacao_expira, null);
  });
});
