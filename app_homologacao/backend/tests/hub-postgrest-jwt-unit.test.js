/**
 * Testes unitários — hub-fundacoes lib/hub-postgrest-jwt.js (FASE 5, task 5.1.3)
 * Rodam com: node --test tests/hub-postgrest-jwt-unit.test.js
 *
 * DEPARTE deliberadamente da convenção de "cópia local" usada em
 * tests/hub-auth-unit.test.js/hub-rbac-unit.test.js/hub-auditoria-unit.test.js
 * (que evitam `require` de módulos com dependências externas para rodar fora
 * do container Dockerfile.hub): o objetivo central deste arquivo — provar que
 * a pinagem de algoritmo (research.md Decision 12) realmente REJEITA um token
 * assinado com um algoritmo diferente de HS256 — só é verificável contra a
 * biblioteca `jsonwebtoken` real (uma cópia local reimplementaria a própria
 * lib, não o uso que o hub faz dela). `jsonwebtoken` já é dependência
 * declarada em package.json (usada pelo código legado desde antes desta
 * fundação) e sempre presente após `npm install`/build do Dockerfile.hub —
 * mesmo padrão de tests/motorista-integration.test.js.
 *
 * Cobre:
 *   - claims corretos por request: role sempre 'authenticated'; sub/
 *     empresa_ativa/escopo só aparecem quando informados (FASE 3 sem
 *     argumentos vs FASE 5 com claims completas)
 *   - alg-pinning na ASSINATURA: token sempre sai HS256 (header.alg)
 *   - alg-pinning na VERIFICAÇÃO: jwt.verify(token, secret, { algorithms:
 *     ['HS256'] }) aceita um token HS256 legítimo, mas REJEITA um token
 *     assinado com outro algoritmo (HS384) usando o MESMO segredo —
 *     confusão de algoritmo (research.md Decision 12, owasp-security)
 *   - PGRST_JWT_SECRET ausente -> lança (nega-por-padrão em vez de assinar
 *     com segredo vazio/undefined)
 *
 * Ref: research.md Decision 3/12, tasks.md 5.1.1/5.1.2/5.1.3.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const SECRET_ORIGINAL = process.env.PGRST_JWT_SECRET;

function comSecret(valor, fn) {
  process.env.PGRST_JWT_SECRET = valor;
  try {
    // Módulo não tem estado próprio (lê process.env a cada chamada) — sem
    // cache exigindo `delete require.cache` entre variações de secret.
    delete require.cache[require.resolve('../lib/hub-postgrest-jwt')];
    const { generateHubPostgrestJWT } = require('../lib/hub-postgrest-jwt');
    return fn(generateHubPostgrestJWT);
  } finally {
    process.env.PGRST_JWT_SECRET = SECRET_ORIGINAL;
    delete require.cache[require.resolve('../lib/hub-postgrest-jwt')];
  }
}

const TEST_SECRET = 'segredo-sintetico-teste-hub-postgrest-jwt-32chars!!';

describe('lib/hub-postgrest-jwt — claims por request (FASE 3 -> FASE 5)', () => {
  test('sem argumentos (FASE 3): payload só tem role=authenticated', () => {
    comSecret(TEST_SECRET, (generateHubPostgrestJWT) => {
      const token = generateHubPostgrestJWT();
      const payload = jwt.decode(token);
      assert.equal(payload.role, 'authenticated');
      assert.equal('sub' in payload, false);
      assert.equal('empresa_ativa' in payload, false);
      assert.equal('escopo' in payload, false);
    });
  });

  test('com claims completas (FASE 5): sub/empresa_ativa/escopo presentes e corretos', () => {
    comSecret(TEST_SECRET, (generateHubPostgrestJWT) => {
      const token = generateHubPostgrestJWT({ usuarioId: 42, empresaAtiva: 920001, escopo: [920001] });
      const payload = jwt.decode(token);
      assert.equal(payload.role, 'authenticated');
      assert.equal(payload.sub, '42'); // sempre String() — Decision 3
      assert.equal(payload.empresa_ativa, 920001);
      assert.deepEqual(payload.escopo, [920001]);
    });
  });

  test('claims parciais (só usuarioId): empresa_ativa/escopo ausentes, não null', () => {
    comSecret(TEST_SECRET, (generateHubPostgrestJWT) => {
      const token = generateHubPostgrestJWT({ usuarioId: 7 });
      const payload = jwt.decode(token);
      assert.equal(payload.sub, '7');
      assert.equal('empresa_ativa' in payload, false);
      assert.equal('escopo' in payload, false);
    });
  });

  test('PGRST_JWT_SECRET ausente -> lança (nega-por-padrão em vez de assinar sem segredo)', () => {
    comSecret('', (generateHubPostgrestJWT) => {
      assert.throws(() => generateHubPostgrestJWT({ usuarioId: 1 }), /PGRST_JWT_SECRET ausente/);
    });
  });
});

describe('lib/hub-postgrest-jwt — alg-pinning (research.md Decision 12, owasp-security)', () => {
  test('token gerado é sempre HS256 no header (assinatura)', () => {
    comSecret(TEST_SECRET, (generateHubPostgrestJWT) => {
      const token = generateHubPostgrestJWT({ usuarioId: 1 });
      const [headerB64] = token.split('.');
      const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
      assert.equal(header.alg, 'HS256');
    });
  });

  test('verify com algorithms:[HS256] ACEITA um token HS256 legítimo', () => {
    comSecret(TEST_SECRET, (generateHubPostgrestJWT) => {
      const token = generateHubPostgrestJWT({ usuarioId: 1, empresaAtiva: 1, escopo: [1] });
      const payload = jwt.verify(token, TEST_SECRET, { algorithms: ['HS256'] });
      assert.equal(payload.role, 'authenticated');
    });
  });

  test('verify com algorithms:[HS256] REJEITA um token assinado com HS384 (mesmo segredo) — confusão de algoritmo', () => {
    const payloadForjado = { role: 'authenticated', sub: '1', empresa_ativa: 1, escopo: [1] };
    const tokenHS384 = jwt.sign(payloadForjado, TEST_SECRET, { algorithm: 'HS384' });

    assert.throws(
      () => jwt.verify(tokenHS384, TEST_SECRET, { algorithms: ['HS256'] }),
      /invalid algorithm/
    );

    // Confirma que, SEM pinagem (comportamento inseguro que estamos evitando),
    // o mesmo token seria aceito — prova que a pinagem é o que faz a diferença,
    // não uma peculiaridade do token/segredo sintéticos deste teste.
    const payloadSemPinagem = jwt.verify(tokenHS384, TEST_SECRET, { algorithms: ['HS256', 'HS384'] });
    assert.equal(payloadSemPinagem.role, 'authenticated');
  });

  test('verify REJEITA token alg=none (ataque clássico de confusão de algoritmo)', () => {
    const payloadForjado = { role: 'authenticated', sub: '1', empresa_ativa: 999999, escopo: [999999] };
    const tokenNone = jwt.sign(payloadForjado, undefined, { algorithm: 'none' });

    // jsonwebtoken pode rejeitar já na própria verificação de assinatura
    // ('jwt signature is required') antes mesmo de checar `algorithms` — o
    // que importa para nós é que `algorithms:['HS256']` NUNCA deixa passar
    // um payload forjado com alg=none, qualquer que seja a mensagem exata.
    assert.throws(() => jwt.verify(tokenNone, TEST_SECRET, { algorithms: ['HS256'] }));
  });
});
