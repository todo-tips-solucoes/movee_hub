/**
 * Testes de integração — credencial de acesso ao app do motorista (FASE 5,
 * WS-C, tasks.md 5.1.6/5.2.4/5.3.4). Rodam com: node --test
 * tests/hub-motoristas-credencial.test.js
 *
 * Mesmo design de tests/hub-motoristas.test.js (FASE 3): a orquestração
 * Docker real (subir hub-test-<runid> efêmero com db+postgrest+backend,
 * aplicar migrations 0000..0045, seed, limpar) vive em
 * infra/hub/testes/hub-motorista-canonico-credencial-integration.sh — este
 * wrapper padroniza a invocação via `node --test` sem duplicar a
 * orquestração Docker em JS. Rotas de credencial dependem de bcrypt real +
 * PostgREST real (não faz sentido mockar hubPostgrestRequest para cobrir
 * 403/409/allowlist/expiração/single-use de forma end-to-end — as funções
 * PURAS do módulo (allowlist dos 3 corpos) já têm cobertura node --test
 * sem I/O em tests/hub-motoristas-dto.test.js).
 *
 * Ref: docs/specs/hub-motorista-canonico/contracts/api-motorista-canonico.md
 * §WS-C Credencial, tasks.md FASE 5.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const HUB_DIR = path.resolve(__dirname, '..', '..', '..', 'infra', 'hub');
const SCRIPT = path.join(HUB_DIR, 'testes', 'hub-motorista-canonico-credencial-integration.sh');
const ENV_FILE = process.env.HUB_TEST_ENV || '/var/lib/hub_secrets/.env.hub.test';

function dockerDisponivel() {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('hub-motorista-canonico-credencial-integration.sh — POST/PATCH .../credencial + reset-senha + login via ContaMotorista', (t) => {
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

  assert.match(out, /HUB-MOTORISTA-CANONICO-CREDENCIAL-INTEGRATION: OK/, `saída do script não confirmou sucesso:\n${out}`);
});
