/**
 * Integração — lote de pagamento do repasse (F5): migration 0108 + RPCs
 * hub_repasse_* direto no PostgREST, num projeto hub-test efêmero.
 * Roda com: node --test tests/hub-repasse-lote.test.js (chamado por
 * npm run test:hub:integration — NÃO faz parte do `npm test` padrão: exige Docker
 * + `/var/lib/hub_secrets/.env.hub.test`). Mesmo wrapper de tests/hub-avisos.test.js;
 * a orquestração vive em infra/hub/testes/hub-repasse-lote-integration.sh.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const HUB_DIR = path.resolve(__dirname, '..', '..', '..', 'infra', 'hub');
const SCRIPT = path.join(HUB_DIR, 'testes', 'hub-repasse-lote-integration.sh');
const ENV_FILE = process.env.HUB_TEST_ENV || '/var/lib/hub_secrets/.env.hub.test';

function dockerDisponivel() {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('hub-repasse-lote-integration.sh — elegibilidade, idempotência, ciclo feliz, cancelar, órfãos, tenant, GRANT por coluna', (t) => {
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

  assert.match(out, /HUB-REPASSE-LOTE-INTEGRATION: OK/, `saída do script não confirmou sucesso:\n${out}`);
});
