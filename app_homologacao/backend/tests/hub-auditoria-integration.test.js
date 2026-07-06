/**
 * Testes de integração — hub-fundacoes imutabilidade da Auditoria (FASE 6,
 * task 6.2.1). Rodam com: node --test tests/hub-auditoria-integration.test.js
 * (chamado por: npm run test:hub:integration — NÃO faz parte do `npm test`
 * padrão, porque exige Docker + `/var/lib/hub_secrets/.env.hub.test`)
 *
 * Design deliberado (mesmo racional de tests/hub-rls-integration.test.js,
 * Decisão registrada em execute-task, onda-010): a orquestração Docker real
 * (subir hub-test-<runid> efêmero, aplicar migrations, seed, limpar) vive em
 * `infra/hub/testes/hub-auditoria-integration.sh` — script NOVO desta onda
 * que fecha um gap real: tasks.md 1.4.4 ("Teste de integração: INSERT
 * permitido, UPDATE/DELETE rejeitados") estava marcada [x] desde a FASE 1
 * mas não existia nenhum arquivo de teste correspondente no repositório.
 *
 * Este wrapper padroniza a invocação via `node --test` sem duplicar a
 * orquestração Docker em JS.
 *
 * Ref: plan.md linha 115, tasks.md 6.2.1, data-model.md §Auditoria,
 * FR-023/FR-024/FR-025, migrations/0004_auditoria.sql.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const HUB_DIR = path.resolve(__dirname, '..', '..', '..', 'infra', 'hub');
const SCRIPT = path.join(HUB_DIR, 'testes', 'hub-auditoria-integration.sh');
const ENV_FILE = process.env.HUB_TEST_ENV || '/var/lib/hub_secrets/.env.hub.test';

function dockerDisponivel() {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('hub-auditoria-integration.sh — Auditoria imutável (INSERT ok, UPDATE/DELETE rejeitados)', (t) => {
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

  assert.match(out, /HUB-AUDITORIA-INTEGRATION: OK/, `saída do script não confirmou sucesso:\n${out}`);
});
