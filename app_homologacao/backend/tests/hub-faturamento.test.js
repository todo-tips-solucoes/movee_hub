/**
 * Testes de integração — GET /api/v1/faturamento (FASE 3, tasks.md 3.2.5).
 * Rodam com: node --test tests/hub-faturamento.test.js (chamado por:
 * npm run test:hub:integration — NÃO faz parte do `npm test` padrão, porque
 * exige Docker + `/var/lib/hub_secrets/.env.hub.test`)
 *
 * Mesmo design de tests/hub-motoristas.test.js/hub-importacoes-integration.
 * test.js: a orquestração Docker real (subir hub-test-<runid> efêmero,
 * aplicar migrations, seed, limpar) vive em
 * infra/hub/testes/hub-faturamento-integration.sh — este wrapper padroniza
 * a invocação via `node --test` sem duplicar a orquestração Docker em JS.
 *
 * Ref: docs/specs/hub-faturamento/contracts/faturamento-api.md, tasks.md
 * FASE 3.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const HUB_DIR = path.resolve(__dirname, '..', '..', '..', 'infra', 'hub');
const SCRIPT = path.join(HUB_DIR, 'testes', 'hub-faturamento-integration.sh');
const ENV_FILE = process.env.HUB_TEST_ENV || '/var/lib/hub_secrets/.env.hub.test';

function dockerDisponivel() {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('hub-faturamento-integration.sh — GET /faturamento (filtros + paginação + isolamento + permissões)', (t) => {
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
    timeout: 5 * 60 * 1000,
  });

  assert.match(out, /HUB-FATURAMENTO-INTEGRATION: OK/, `saída do script não confirmou sucesso:\n${out}`);
});
