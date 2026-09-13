/**
 * Testes unitários — lib/hub-push-endpoint.js (tasks.md FASE 2, 2.2.3).
 * Rodam com: node --test tests/hub-push-endpoint-unit.test.js
 *
 * Cobre `validarEndpointUrl`/`validarInscricaoPush` (endpoint https, sem
 * userinfo/porta, ≤2.000 chars; `p256dh` 65 bytes prefixo `0x04`; `auth` 16
 * bytes) e a allowlist anti-SSRF (`hostPermitido`/`carregarAllowlist`):
 * casamento exato/sufixo com fronteira de ponto, override via
 * `PUSH_HOSTS_PERMITIDOS` só com `ENVIO_ALLOWLIST` definida.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  carregarAllowlist,
  hostPermitido,
  validarEndpointUrl,
  validarInscricaoPush,
  ALLOWLIST_PADRAO,
} = require('../lib/hub-push-endpoint');

// P256DH: 65 bytes começando com 0x04 (ponto EC não-comprimido); AUTH: 16 bytes.
const P256DH_VALIDO = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 1)]).toString('base64url');
const AUTH_VALIDO = Buffer.alloc(16, 2).toString('base64url');

function corpoBase(overrides) {
  return Object.assign(
    {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
      keys: { p256dh: P256DH_VALIDO, auth: AUTH_VALIDO },
    },
    overrides,
  );
}

describe('hostPermitido / carregarAllowlist', () => {
  test('host exato na allowlist padrão: permitido', () => {
    assert.equal(hostPermitido('fcm.googleapis.com', ALLOWLIST_PADRAO), true);
  });

  test('subdomínio de entrada wildcard (*.push.apple.com): permitido', () => {
    assert.equal(hostPermitido('web.push.apple.com', ALLOWLIST_PADRAO), true);
  });

  test('host base do domínio wildcard (sem subdomínio): permitido', () => {
    assert.equal(hostPermitido('push.apple.com', ALLOWLIST_PADRAO), true);
  });

  test('host com sufixo textual mas SEM fronteira de ponto (evil-push.apple.com): recusado', () => {
    assert.equal(hostPermitido('evil-push.apple.com', ALLOWLIST_PADRAO), false);
  });

  test('host totalmente fora da allowlist: recusado', () => {
    assert.equal(hostPermitido('attacker.example.com', ALLOWLIST_PADRAO), false);
  });

  test('host vazio/ausente: recusado', () => {
    assert.equal(hostPermitido('', ALLOWLIST_PADRAO), false);
    assert.equal(hostPermitido(null, ALLOWLIST_PADRAO), false);
  });

  test('carregarAllowlist: sem env, retorna a allowlist padrão', () => {
    const allow = carregarAllowlist({});
    assert.deepEqual(allow, ALLOWLIST_PADRAO);
  });

  test('carregarAllowlist: PUSH_HOSTS_PERMITIDOS sem ENVIO_ALLOWLIST é ignorada (override não aplicado)', () => {
    const allow = carregarAllowlist({ PUSH_HOSTS_PERMITIDOS: 'push-mock.hub-test.local' });
    assert.deepEqual(allow, ALLOWLIST_PADRAO);
  });

  test('carregarAllowlist: PUSH_HOSTS_PERMITIDOS COM ENVIO_ALLOWLIST definida substitui a lista', () => {
    const allow = carregarAllowlist({
      ENVIO_ALLOWLIST: '',
      PUSH_HOSTS_PERMITIDOS: 'push-mock.hub-test.local, outro.host.local',
    });
    assert.deepEqual(allow, ['push-mock.hub-test.local', 'outro.host.local']);
  });
});

describe('validarEndpointUrl', () => {
  test('URL https válida: ok', () => {
    const r = validarEndpointUrl('https://fcm.googleapis.com/fcm/send/abc');
    assert.equal(r.ok, true);
  });

  test('protocolo http (não https): DADOS_INVALIDOS motivo endpoint', () => {
    const r = validarEndpointUrl('http://fcm.googleapis.com/fcm/send/abc');
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'DADOS_INVALIDOS');
    assert.equal(r.motivo, 'endpoint');
  });

  test('endpoint com porta explícita: DADOS_INVALIDOS motivo endpoint', () => {
    const r = validarEndpointUrl('https://fcm.googleapis.com:8443/fcm/send/abc');
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'endpoint');
  });

  test('endpoint com userinfo: DADOS_INVALIDOS motivo endpoint', () => {
    const r = validarEndpointUrl('https://user:pass@fcm.googleapis.com/fcm/send/abc');
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'endpoint');
  });

  test('endpoint acima de 2.000 caracteres: DADOS_INVALIDOS motivo endpoint', () => {
    const longo = `https://fcm.googleapis.com/${'a'.repeat(2000)}`;
    const r = validarEndpointUrl(longo);
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'endpoint');
  });

  test('endpoint não-parseável como URL: DADOS_INVALIDOS motivo endpoint', () => {
    const r = validarEndpointUrl('nao-e-uma-url');
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'endpoint');
  });

  test('endpoint ausente: DADOS_INVALIDOS motivo endpoint', () => {
    const r = validarEndpointUrl(undefined);
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'endpoint');
  });
});

describe('validarInscricaoPush', () => {
  test('inscrição completa e válida: ok', () => {
    const r = validarInscricaoPush(corpoBase());
    assert.equal(r.ok, true);
    assert.equal(r.endpoint, corpoBase().endpoint);
  });

  test('p256dh com tamanho errado (64 bytes): DADOS_INVALIDOS motivo p256dh', () => {
    const p256dhCurto = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(63, 1)]).toString('base64url');
    const r = validarInscricaoPush(corpoBase({ keys: { p256dh: p256dhCurto, auth: AUTH_VALIDO } }));
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'DADOS_INVALIDOS');
    assert.equal(r.motivo, 'p256dh');
  });

  test('p256dh com prefixo errado (sem 0x04): DADOS_INVALIDOS motivo p256dh', () => {
    const p256dhPrefixoErrado = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(64, 1)]).toString('base64url');
    const r = validarInscricaoPush(corpoBase({ keys: { p256dh: p256dhPrefixoErrado, auth: AUTH_VALIDO } }));
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'p256dh');
  });

  test('auth com tamanho errado (15 bytes): DADOS_INVALIDOS motivo auth', () => {
    const authCurto = Buffer.alloc(15, 2).toString('base64url');
    const r = validarInscricaoPush(corpoBase({ keys: { p256dh: P256DH_VALIDO, auth: authCurto } }));
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'DADOS_INVALIDOS');
    assert.equal(r.motivo, 'auth');
  });

  test('host fora da allowlist: ENDPOINT_NAO_PERMITIDO', () => {
    const r = validarInscricaoPush(corpoBase({ endpoint: 'https://attacker.example.com/x' }));
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'ENDPOINT_NAO_PERMITIDO');
  });

  test('override sem ENVIO_ALLOWLIST é ignorado: host do override recusado', () => {
    const r = validarInscricaoPush(
      corpoBase({ endpoint: 'https://push-mock.hub-test.local/x' }),
      { env: { PUSH_HOSTS_PERMITIDOS: 'push-mock.hub-test.local' } },
    );
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'ENDPOINT_NAO_PERMITIDO');
  });

  test('override COM ENVIO_ALLOWLIST definida: host do override aceito', () => {
    const r = validarInscricaoPush(
      corpoBase({ endpoint: 'https://push-mock.hub-test.local/x' }),
      { env: { ENVIO_ALLOWLIST: '', PUSH_HOSTS_PERMITIDOS: 'push-mock.hub-test.local' } },
    );
    assert.equal(r.ok, true);
  });

  test('allowlist explícita via opts.allowlist tem prioridade sobre env', () => {
    const r = validarInscricaoPush(
      corpoBase({ endpoint: 'https://custom.example.com/x' }),
      { allowlist: ['custom.example.com'], env: {} },
    );
    assert.equal(r.ok, true);
  });

  test('keys ausente: DADOS_INVALIDOS motivo p256dh', () => {
    const r = validarInscricaoPush({ endpoint: corpoBase().endpoint });
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'p256dh');
  });
});
