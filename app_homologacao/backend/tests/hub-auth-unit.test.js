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
 *   - hub-sessao-inatividade (2026-09-06, bloco final, contra o MÓDULO REAL):
 *     carimbo do login no refresh token, janela deslizante de 6 h, teto de 24 h.
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

// ──────────────────────────────────────────────────────────────────────────────
// hub-sessao-inatividade (2026-09-06) — contra o módulo REAL (bcrypt/express
// estão instalados no host desde a suíte de 907; mesmo padrão de
// tests/hub-usuarios-unit.test.js), não cópia local.
// ──────────────────────────────────────────────────────────────────────────────

const real = require('../routes/hub-auth');

describe('sessão do hub — janelas (defaults sem env)', () => {
  test('access 15 min, refresh deslizante 6 h, vida máxima 24 h', () => {
    assert.equal(real.ACCESS_TOKEN_TTL_MS, 15 * 60 * 1000);
    assert.equal(real.REFRESH_TOKEN_TTL_MS, 6 * 60 * 60 * 1000);
    assert.equal(real.SESSAO_VIDA_MAX_MS, 24 * 60 * 60 * 1000);
  });
});

describe('gerarRefreshToken / familiaCriadaEmDoToken — carimbo do login no token', () => {
  const login = new Date('2026-09-06T10:00:00Z');

  test('formato <ms do login>.<64 hex> e o carimbo é recuperável', () => {
    const t = real.gerarRefreshToken(login);
    assert.match(t, /^\d+\.[0-9a-f]{64}$/);
    assert.equal(real.familiaCriadaEmDoToken(t, {}).getTime(), login.getTime());
  });

  test('a rotação preserva o carimbo (a família continua nascendo no login)', () => {
    const t1 = real.gerarRefreshToken(login);
    const t2 = real.gerarRefreshToken(real.familiaCriadaEmDoToken(t1, {}));
    assert.notEqual(t1, t2);
    assert.equal(real.familiaCriadaEmDoToken(t2, {}).getTime(), login.getTime());
  });

  test('token anterior à entrega (sem carimbo) usa o criado_em da linha', () => {
    const antigo = real.gerarTokenBruto();
    const d = real.familiaCriadaEmDoToken(antigo, { criado_em: '2026-09-05T20:00:00Z' });
    assert.equal(d.toISOString(), '2026-09-05T20:00:00.000Z');
  });
});

describe('classificarSessaoRefresh — inatividade de 6 h e teto de 24 h', () => {
  const H = 60 * 60 * 1000;
  const login = new Date('2026-09-06T10:00:00Z');
  const em = (horas) => new Date(login.getTime() + horas * H);
  const sessao = (ultimoRefreshH) => ({
    revogado_em: null,
    expira_em: em(ultimoRefreshH + 6).toISOString(),
    familia_criada_em: login,
  });

  test('renovação dentro da janela -> "valida"', () => {
    assert.equal(real.classificarSessaoRefresh(sessao(0), em(5)), 'valida');
  });

  test('6 h sem renovar -> "expirada" (inatividade)', () => {
    assert.equal(real.classificarSessaoRefresh(sessao(0), em(6.01)), 'expirada');
  });

  test('atividade contínua (renova a cada 5 h) é aceita até o teto e recusada depois', () => {
    for (const h of [5, 10, 15, 20]) {
      assert.equal(real.classificarSessaoRefresh(sessao(h - 5), em(h)), 'valida', `t=${h}h`);
    }
    // última renovação às 20 h deixou expira_em = 26 h, mas a família nasceu há 24 h
    assert.equal(real.classificarSessaoRefresh(sessao(20), em(24)), 'expirada');
  });

  test('um segundo antes do teto ainda é "valida"', () => {
    assert.equal(real.classificarSessaoRefresh(sessao(20), new Date(em(24).getTime() - 1000)), 'valida');
  });

  test('reuso continua tendo precedência (revoga a família)', () => {
    assert.equal(real.classificarSessaoRefresh({ ...sessao(0), revogado_em: em(1).toISOString() }, em(2)), 'reuso');
  });

  test('sem carimbo (linha antiga sem familia_criada_em) só vale a inatividade', () => {
    assert.equal(real.classificarSessaoRefresh({ revogado_em: null, expira_em: em(30).toISOString() }, em(25)), 'valida');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// hub-sessao-inatividade FIX (2026-09-06) — o refresh preserva a entidade ativa.
// Regressão: reemitir o access token no /refresh descartava a claim
// `entidade_ativa` (só o POST /me/entidade a gravava), então após uma
// renovação silenciosa o /me devolvia modulos:[] e /motoristas/:id caía em
// 400 ENTIDADE_NAO_SELECIONADA.
// ──────────────────────────────────────────────────────────────────────────────

const jwtLib = require('jsonwebtoken');
// Chave fixa para os blocos que assinam/verificam JWT (gerarAccessToken e
// entidadeAtivaDeAccessAntigo leem process.env.JWT_SECRET em tempo de CHAMADA;
// os testes rodam DEPOIS da coleta, então a chave precisa continuar setada).
// Os demais testes deste arquivo são crypto puro e não dependem dela.
process.env.JWT_SECRET = 'segredo-teste-unit';

describe('gerarAccessToken — entidade ativa na claim', () => {
  const dec = (t) => jwtLib.decode(t);
  test('sem entidade (login): claim entidade_ativa ausente', () => {
    assert.equal(dec(real.gerarAccessToken({ id: 7, email: 'a@b' })).entidade_ativa, undefined);
  });
  test('com entidade (refresh): claim presente e numérica', () => {
    assert.equal(dec(real.gerarAccessToken({ id: 7, email: 'a@b' }, 42)).entidade_ativa, 42);
    assert.equal(dec(real.gerarAccessToken({ id: 7, email: 'a@b' }, '42')).entidade_ativa, 42);
  });
  test('entidade 0/null/undefined NÃO vira claim (0 = "não selecionada")', () => {
    for (const e of [0, null, undefined]) assert.equal(dec(real.gerarAccessToken({ id: 7, email: 'a@b' }, e)).entidade_ativa, undefined);
  });
});

describe('entidadeAtivaDeAccessAntigo — recupera a claim do access token expirado', () => {
  const tokExp = jwtLib.sign({ sub: 7, email: 'a@b', entidade_ativa: 42 }, 'segredo-teste-unit', { algorithm: 'HS256', expiresIn: '-10s' });
  test('token EXPIRADO ainda entrega a entidade (ignoreExpiration; assinatura conferida)', () => {
    assert.equal(real.entidadeAtivaDeAccessAntigo(tokExp, 7), 42);
  });
  test('sub do token != usuário autenticado pelo refresh -> null (não adota claim alheia)', () => {
    assert.equal(real.entidadeAtivaDeAccessAntigo(tokExp, 9), null);
  });
  test('token assinado com OUTRA chave -> null', () => {
    const outro = jwtLib.sign({ sub: 7, entidade_ativa: 42 }, 'chave-errada', { algorithm: 'HS256' });
    assert.equal(real.entidadeAtivaDeAccessAntigo(outro, 7), null);
  });
  test('token sem entidade, ausente ou lixo -> null', () => {
    assert.equal(real.entidadeAtivaDeAccessAntigo(jwtLib.sign({ sub: 7 }, 'segredo-teste-unit'), 7), null);
    assert.equal(real.entidadeAtivaDeAccessAntigo(null, 7), null);
    assert.equal(real.entidadeAtivaDeAccessAntigo('nao.e.jwt', 7), null);
  });
  test('round-trip: refresh de token expirado preserva a entidade no token novo', () => {
    const recuperada = real.entidadeAtivaDeAccessAntigo(tokExp, 7);
    assert.equal(jwtLib.decode(real.gerarAccessToken({ id: 7, email: 'a@b' }, recuperada)).entidade_ativa, 42);
  });
});
