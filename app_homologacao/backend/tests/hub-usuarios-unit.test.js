/**
 * Testes unitários — routes/hub-usuarios.js (hub-auditoria-admin S9,
 * tasks.md FASE 4.2). Rodam com: node --test tests/hub-usuarios-unit.test.js
 *
 * Cobre as funções PURAS exportadas (sem PostgREST real — isso é
 * responsabilidade de infra/hub/testes/hub-usuarios-integration.sh):
 *   - isStrongPassword: mesma regra do painel (>=6, 1 maiúscula, 1 dígito)
 *   - parsePaginacaoUsuarios: defaults/clamps (mesmo padrão de
 *     parsePaginacaoAuditoria)
 *   - resolverEntidadeAlvo: admin_entidade forçado à própria entidade
 *     (403 se divergir); admin_plataforma pode divergir livremente
 *
 * Ref: contracts/usuarios-api.md, tasks.md 4.2.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-unit';
process.env.PGRST_JWT_SECRET = process.env.PGRST_JWT_SECRET || 'segredo-teste-postgrest';
process.env.POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest-fake:3000';

const { isStrongPassword, parsePaginacaoUsuarios, resolverEntidadeAlvo, linkSenhaPendente } = require('../routes/hub-usuarios');

describe('isStrongPassword', () => {
  test('senha forte (>=6, maiúscula, dígito) -> true', () => {
    assert.equal(isStrongPassword('S3nh@Fr'), true);
    assert.equal(isStrongPassword('Abc123'), true);
  });

  test('curta demais (<6) -> false', () => {
    assert.equal(isStrongPassword('Ab1'), false);
  });

  test('sem maiúscula -> false', () => {
    assert.equal(isStrongPassword('abc123'), false);
  });

  test('sem dígito -> false', () => {
    assert.equal(isStrongPassword('Abcdef'), false);
  });

  test('não-string (number/undefined/null) -> false, nunca lança', () => {
    assert.equal(isStrongPassword(123456), false);
    assert.equal(isStrongPassword(undefined), false);
    assert.equal(isStrongPassword(null), false);
  });
});

describe('parsePaginacaoUsuarios', () => {
  test('sem params -> default page=1 pageSize=20', () => {
    assert.deepEqual(parsePaginacaoUsuarios({}), { page: 1, pageSize: 20 });
  });

  test('pageSize acima de 100 -> clamp em 100', () => {
    assert.equal(parsePaginacaoUsuarios({ pageSize: '500' }).pageSize, 100);
  });

  test('page<1 ou não-numérico -> default 1', () => {
    assert.equal(parsePaginacaoUsuarios({ page: '0' }).page, 1);
    assert.equal(parsePaginacaoUsuarios({ page: 'x' }).page, 1);
  });
});

describe('resolverEntidadeAlvo', () => {
  function mockRes() {
    let statusCode = null;
    let jsonBody = null;
    return {
      status(code) { statusCode = code; return this; },
      json(body) { jsonBody = body; return this; },
      getStatus: () => statusCode,
      getJson: () => jsonBody,
    };
  }

  test('entidadeIdParam null -> retorna a entidade ativa (não informado)', () => {
    const res = mockRes();
    const r = resolverEntidadeAlvo(res, { entidadeAtiva: 9001, isAdminPlataforma: false }, null);
    assert.equal(r, 9001);
    assert.equal(res.getStatus(), null);
  });

  test('admin_entidade com entidadeId IGUAL à ativa -> permitido', () => {
    const res = mockRes();
    const r = resolverEntidadeAlvo(res, { entidadeAtiva: 9001, isAdminPlataforma: false }, 9001);
    assert.equal(r, 9001);
  });

  test('admin_entidade com entidadeId DIVERGENTE -> 403 PERMISSAO_NEGADA, retorna undefined', () => {
    const res = mockRes();
    const r = resolverEntidadeAlvo(res, { entidadeAtiva: 9001, isAdminPlataforma: false }, 9002);
    assert.equal(r, undefined);
    assert.equal(res.getStatus(), 403);
    assert.deepEqual(res.getJson(), { erro: 'PERMISSAO_NEGADA' });
  });

  test('admin_plataforma com entidadeId DIVERGENTE -> permitido (visão global)', () => {
    const res = mockRes();
    const r = resolverEntidadeAlvo(res, { entidadeAtiva: 9001, isAdminPlataforma: true }, 9002);
    assert.equal(r, 9002);
    assert.equal(res.getStatus(), null);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// linkSenhaPendente (2026-09-29) — o selo "Senha pendente" da lista.
//
// O que ele NÃO pode fazer: acender para quem já criou a senha (o admin
// reenviaria link à toa e mataria um link válido) nem apagar para quem está
// esperando (a pessoa fica sem acesso e ninguém vê).
// ────────────────────────────────────────────────────────────────────────────

test('linkSenhaPendente: só acende com validade no futuro', () => {
  const agora = new Date('2026-09-29T12:00:00Z');
  assert.equal(linkSenhaPendente('2026-09-29T12:00:01Z', agora), true, 'um segundo à frente ainda vale');
  assert.equal(linkSenhaPendente('2026-10-06T12:00:00Z', agora), true);
  assert.equal(linkSenhaPendente('2026-09-29T11:59:59Z', agora), false, 'expirado não é pendente');
  assert.equal(linkSenhaPendente(agora.toISOString(), agora), false, 'exatamente agora já venceu');
});

test('linkSenhaPendente: ausência e lixo no banco não viram "pendente"', () => {
  const agora = new Date('2026-09-29T12:00:00Z');
  for (const vazio of [null, undefined, '']) {
    assert.equal(linkSenhaPendente(vazio, agora), false);
  }
  assert.equal(linkSenhaPendente('não é data', agora), false);
});
