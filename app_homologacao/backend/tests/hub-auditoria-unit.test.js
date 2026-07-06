/**
 * Testes unitários — hub-fundacoes lib/hub-auditoria.js (task 4.3.4)
 * Rodam com: node --test tests/hub-auditoria-unit.test.js
 *
 * Mesma convenção de tests/hub-auth-unit.test.js/hub-rbac-unit.test.js: cópia
 * local da função pura `scrubDetalhes` (sem dependência de rede/fetch), já
 * que `lib/hub-auditoria.js` real depende transitivamente de
 * `lib/hub-postgrest.js` -> `lib/hub-postgrest-jwt.js` -> `jsonwebtoken`,
 * indisponível fora do container Dockerfile.hub.
 *
 * Cobre: FR-025 (Auditoria.detalhes NUNCA contém dado sensível em texto
 * aberto) — chaves proibidas (senha/password/pass/hash/token/secret/segredo)
 * são OMITIDAS por completo (nunca mascaradas), comparação por substring
 * case-insensitive (research.md, data-model.md §Auditoria).
 *
 * Integração real (eventos de sucesso/falha na trilha, imutabilidade) já
 * coberta por infra/hub/testes/hub-auth-integration.sh (login/logout/
 * recuperação/redefinição) e infra/hub/testes/hub-rbac-integration.sh
 * (troca_entidade_ativa) — task 4.3.4 "teste de integração".
 *
 * Ref: lib/hub-auditoria.js, data-model.md §Auditoria, research.md Decision 6.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// ──────────────────────────────────────────────────────────────────────────────
// Cópia local: scrubDetalhes (espelho exato de lib/hub-auditoria.js)
// ──────────────────────────────────────────────────────────────────────────────

const CHAVES_PROIBIDAS = ['senha', 'password', 'pass', 'hash', 'token', 'secret', 'segredo'];

function scrubDetalhes(detalhes) {
  if (!detalhes || typeof detalhes !== 'object') return {};
  const out = {};
  for (const [chave, valor] of Object.entries(detalhes)) {
    const chaveLower = chave.toLowerCase();
    if (CHAVES_PROIBIDAS.some((proibida) => chaveLower.includes(proibida))) {
      continue;
    }
    out[chave] = valor;
  }
  return out;
}

describe('scrubDetalhes (FR-025)', () => {
  test('remove chave "senha" por completo (nunca mascarada)', () => {
    const r = scrubDetalhes({ senha: 'segredo123', motivo: 'senha_incorreta' });
    assert.equal('senha' in r, false);
    assert.equal(r.motivo, 'senha_incorreta'); // valor não é chave proibida
  });

  test('remove variações: password, pass, hash, token, secret, segredo (case-insensitive)', () => {
    const r = scrubDetalhes({
      Password: 'x',
      user_pass: 'x',
      senha_hash: 'x',
      refreshToken: 'x',
      API_SECRET: 'x',
      meu_segredo: 'x',
      idEmpresa: 42,
    });
    assert.deepEqual(Object.keys(r), ['idEmpresa']);
  });

  test('objeto vazio/null/undefined -> {}', () => {
    assert.deepEqual(scrubDetalhes({}), {});
    assert.deepEqual(scrubDetalhes(null), {});
    assert.deepEqual(scrubDetalhes(undefined), {});
  });

  test('não-objeto (string/number) -> {} (defesa contra chamada incorreta)', () => {
    assert.deepEqual(scrubDetalhes('nao é objeto'), {});
    assert.deepEqual(scrubDetalhes(42), {});
  });

  test('preserva chaves legítimas (motivo, tentativas_login, email)', () => {
    const r = scrubDetalhes({ motivo: 'conta_bloqueada', tentativas_login: 5, email: 'foo@bar.com' });
    assert.deepEqual(r, { motivo: 'conta_bloqueada', tentativas_login: 5, email: 'foo@bar.com' });
  });

  test('chave que CONTÉM substring proibida no meio é removida (ex.: "novaSenhaHash")', () => {
    const r = scrubDetalhes({ novaSenhaHash: 'x', tudo_ok: true });
    assert.equal('novaSenhaHash' in r, false);
    assert.equal(r.tudo_ok, true);
  });
});
