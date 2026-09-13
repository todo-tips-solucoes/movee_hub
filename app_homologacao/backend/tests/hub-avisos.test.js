/**
 * Testes de integração — hub-avisos: RLS, SKIP LOCKED, reinício, push-mock
 * real (404/410/429/retry), expurgo e auditoria (tasks.md 9.2).
 * Rodam com: node --test tests/hub-avisos.test.js (chamado por:
 * npm run test:hub:integration — NÃO faz parte do `npm test` padrão, porque
 * exige Docker + `/var/lib/hub_secrets/.env.hub.test`)
 *
 * Mesmo design de tests/hub-performance.test.js/hub-faturamento.test.js: a
 * orquestração Docker real (subir hub-test-<runid> efêmero, gerar cert/key
 * do push-mock, aplicar migrations, seed, disparar, limpar) vive em
 * infra/hub/testes/hub-avisos-integration.sh — este wrapper padroniza a
 * invocação via `node --test` sem duplicar a orquestração Docker em JS.
 *
 * Ref: docs/specs/envioMassa_homologacao/tasks.md FASE 9.2.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const HUB_DIR = path.resolve(__dirname, '..', '..', '..', 'infra', 'hub');
const SCRIPT = path.join(HUB_DIR, 'testes', 'hub-avisos-integration.sh');
const ENV_FILE = process.env.HUB_TEST_ENV || '/var/lib/hub_secrets/.env.hub.test';

function dockerDisponivel() {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('hub-avisos-integration.sh — RLS, SKIP LOCKED, reinício, push-mock real (404/410/429/retry), expurgo, auditoria', (t) => {
  if (!fs.existsSync(ENV_FILE)) {
    t.skip(`env file ausente (${ENV_FILE}) — este ambiente não tem Docker/hub-test provisionado`);
    return;
  }
  if (!dockerDisponivel()) {
    t.skip('docker compose indisponível neste ambiente — pulando integração real');
    return;
  }

  const out = execFileSync('bash', [SCRIPT], {
    cwd: path.resolve(HUB_DIR, '..', '..'),
    encoding: 'utf8',
    timeout: 8 * 60 * 1000,
  });

  assert.match(out, /HUB-AVISOS-INTEGRATION: OK/, `saída do script não confirmou sucesso:\n${out}`);
});
