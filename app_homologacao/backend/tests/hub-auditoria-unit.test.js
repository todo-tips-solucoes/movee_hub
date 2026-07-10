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
 * case-insensitive (research.md, data-model.md §Auditoria). Também cobre
 * hub-auditoria-admin FASE 2.3 (CHK006/SC-006): checagem por PADRÃO no VALOR
 * (CPF/CNPJ/e-mail em texto livre, independente do nome da chave), camada
 * ADITIVA à checagem por NOME de chave.
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

// hub-auditoria-admin FASE 2.3 (CHK006/SC-006) — cópia local espelhando a
// camada de checagem por VALOR acrescentada em lib/hub-auditoria.js.
const REGEX_CPF = /\d{3}\.?\d{3}\.?\d{3}-?\d{2}/;
const REGEX_CNPJ = /\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/;
const REGEX_EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;

function valorContemPadraoSensivel(valor) {
  if (typeof valor !== 'string') return false;
  return REGEX_CPF.test(valor) || REGEX_CNPJ.test(valor) || REGEX_EMAIL.test(valor);
}

function scrubDetalhes(detalhes) {
  if (!detalhes || typeof detalhes !== 'object') return {};
  const out = {};
  for (const [chave, valor] of Object.entries(detalhes)) {
    const chaveLower = chave.toLowerCase();
    if (CHAVES_PROIBIDAS.some((proibida) => chaveLower.includes(proibida))) {
      continue;
    }
    if (valorContemPadraoSensivel(valor)) {
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

  test('preserva chaves legítimas cujo VALOR não casa nenhum padrão sensível', () => {
    const r = scrubDetalhes({ motivo: 'conta_bloqueada', tentativas_login: 5 });
    assert.deepEqual(r, { motivo: 'conta_bloqueada', tentativas_login: 5 });
  });

  test('chave que CONTÉM substring proibida no meio é removida (ex.: "novaSenhaHash")', () => {
    const r = scrubDetalhes({ novaSenhaHash: 'x', tudo_ok: true });
    assert.equal('novaSenhaHash' in r, false);
    assert.equal(r.tudo_ok, true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// hub-auditoria-admin FASE 2.3 (CHK006/SC-006) — checagem por PADRÃO no VALOR
// ──────────────────────────────────────────────────────────────────────────────

describe('scrubDetalhes — checagem por padrão sensível no VALOR (CHK006/SC-006)', () => {
  test('chave "email" com valor de e-mail é OMITIDA (diverge da leitura anterior — Decisão 2.3.2)', () => {
    const r = scrubDetalhes({ email: 'foo@bar.com', motivo: 'conta_bloqueada' });
    assert.equal('email' in r, false);
    assert.equal(r.motivo, 'conta_bloqueada');
  });

  test('chave de nome inócuo com e-mail embutido no valor é OMITIDA (o gap real do CHK006)', () => {
    const r = scrubDetalhes({ observacao: 'contato: joao.silva@example.com para dúvidas', ok: true });
    assert.equal('observacao' in r, false);
    assert.equal(r.ok, true);
  });

  test('CPF formatado (123.456.789-01) no valor é OMITIDO', () => {
    const r = scrubDetalhes({ linha_bruta: 'nome;123.456.789-01;ativo', ok: true });
    assert.equal('linha_bruta' in r, false);
    assert.equal(r.ok, true);
  });

  test('CPF sem formatação (12345678901) no valor é OMITIDO', () => {
    const r = scrubDetalhes({ detalhe_erro: 'documento 12345678901 invalido', ok: true });
    assert.equal('detalhe_erro' in r, false);
    assert.equal(r.ok, true);
  });

  test('CNPJ formatado (12.345.678/0001-95) no valor é OMITIDO', () => {
    const r = scrubDetalhes({ nota: 'CNPJ 12.345.678/0001-95 divergente', ok: true });
    assert.equal('nota' in r, false);
    assert.equal(r.ok, true);
  });

  test('CNPJ sem formatação (12345678000195) no valor é OMITIDO', () => {
    const r = scrubDetalhes({ nota: 'cnpj 12345678000195 sem pontuacao', ok: true });
    assert.equal('nota' in r, false);
    assert.equal(r.ok, true);
  });

  test('valor sem NENHUM padrão sensível é preservado integralmente', () => {
    const r = scrubDetalhes({
      acao_origem: 'usuario_editado',
      total_linhas: 42,
      ativo: true,
      lista_vazia: [],
    });
    assert.deepEqual(r, {
      acao_origem: 'usuario_editado',
      total_linhas: 42,
      ativo: true,
      lista_vazia: [],
    });
  });

  test('valor não-string (number/boolean/array) nunca é testado contra os regex — preservado', () => {
    const r = scrubDetalhes({ total: 123456789012, ativo: true, tags: ['a', 'b'] });
    assert.deepEqual(r, { total: 123456789012, ativo: true, tags: ['a', 'b'] });
  });

  test('valorContemPadraoSensivel: true para CPF/CNPJ/e-mail, false para texto neutro', () => {
    assert.equal(valorContemPadraoSensivel('123.456.789-01'), true);
    assert.equal(valorContemPadraoSensivel('12.345.678/0001-95'), true);
    assert.equal(valorContemPadraoSensivel('foo@bar.com'), true);
    assert.equal(valorContemPadraoSensivel('texto qualquer sem padrao'), false);
    assert.equal(valorContemPadraoSensivel(42), false);
    assert.equal(valorContemPadraoSensivel(null), false);
  });
});
