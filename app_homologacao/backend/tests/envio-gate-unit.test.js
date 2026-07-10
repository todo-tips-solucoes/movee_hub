// Testes unitários — lib/envio-gate.js (issue #62)
// Rodam com: node --test tests/envio-gate-unit.test.js (parte de npm test e
// npm run test:hub:unit). `env` é injetado — nada aqui toca process.env real.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gateEnvioExterno } = require('../lib/envio-gate');

const URL_PROD_N8N = 'https://api.chatmasterveloz.com/api/messages/sendOfficial';
const URL_PROD_FASTAPI = 'https://fastapihomologacao.todo-tips.com/validade_nfse';
const URL_MOCK = 'http://n8n-mock:8080/api/messages/sendOfficial';

test('produção (nenhuma var definida) → NUNCA bloqueia (comportamento histórico)', () => {
  assert.deepEqual(gateEnvioExterno(URL_PROD_N8N, {}), { bloqueado: false });
  assert.deepEqual(gateEnvioExterno(URL_PROD_FASTAPI, {}), { bloqueado: false });
});

test('ENVIO_DRY_RUN=true bloqueia qualquer destino, antes de olhar allowlist', () => {
  const r = gateEnvioExterno(URL_PROD_N8N, { ENVIO_DRY_RUN: 'true' });
  assert.equal(r.bloqueado, true);
  assert.equal(r.motivo, 'ENVIO_DRY_RUN=true');
  // precedência: mesmo com o host na allowlist, dry-run vence
  const r2 = gateEnvioExterno(URL_MOCK, { ENVIO_DRY_RUN: 'true', ENVIO_ALLOWLIST: 'n8n-mock' });
  assert.equal(r2.bloqueado, true);
  assert.equal(r2.motivo, 'ENVIO_DRY_RUN=true');
});

test('ENVIO_DRY_RUN é case-insensitive; qualquer valor ≠ true não ativa o dry-run', () => {
  assert.equal(gateEnvioExterno(URL_PROD_N8N, { ENVIO_DRY_RUN: 'TRUE' }).bloqueado, true);
  assert.equal(gateEnvioExterno(URL_PROD_N8N, { ENVIO_DRY_RUN: 'True' }).bloqueado, true);
  assert.equal(gateEnvioExterno(URL_PROD_N8N, { ENVIO_DRY_RUN: 'false' }).bloqueado, false);
  assert.equal(gateEnvioExterno(URL_PROD_N8N, { ENVIO_DRY_RUN: '1' }).bloqueado, false);
  assert.equal(gateEnvioExterno(URL_PROD_N8N, { ENVIO_DRY_RUN: '' }).bloqueado, false);
});

test('ENVIO_ALLOWLIST vazia (mas DEFINIDA) bloqueia tudo — fail-closed', () => {
  const r = gateEnvioExterno(URL_MOCK, { ENVIO_ALLOWLIST: '' });
  assert.equal(r.bloqueado, true);
  assert.match(r.motivo, /fora da ENVIO_ALLOWLIST/);
  assert.equal(gateEnvioExterno(URL_PROD_N8N, { ENVIO_ALLOWLIST: '' }).bloqueado, true);
});

test('ENVIO_ALLOWLIST permite só os hostnames listados (CSV, trim, case-insensitive)', () => {
  const env = { ENVIO_ALLOWLIST: ' N8N-Mock , fastapi-mock ' };
  assert.equal(gateEnvioExterno(URL_MOCK, env).bloqueado, false);
  assert.equal(gateEnvioExterno('http://fastapi-mock:8080/validade_nfse', env).bloqueado, false);
  const r = gateEnvioExterno(URL_PROD_N8N, env);
  assert.equal(r.bloqueado, true);
  assert.match(r.motivo, /api\.chatmasterveloz\.com/);
});

test('allowlist compara hostname EXATO — subdomínio/sufixo não passa', () => {
  const env = { ENVIO_ALLOWLIST: 'chatmasterveloz.com' };
  assert.equal(gateEnvioExterno(URL_PROD_N8N, env).bloqueado, true); // api.chatmasterveloz.com ≠ chatmasterveloz.com
});

test('URL inválida com allowlist definida → bloqueado (fail-closed)', () => {
  const r = gateEnvioExterno('não é uma url', { ENVIO_ALLOWLIST: 'n8n-mock' });
  assert.equal(r.bloqueado, true);
  assert.match(r.motivo, /url inválida/);
});
