/**
 * Testes de integração — hub-fundacoes RLS de reforço (FASE 6, task 6.2.1)
 * Rodam com: node --test tests/hub-rls-integration.test.js
 * (chamado por: npm run test:hub:integration — NÃO faz parte do `npm test`
 * padrão, porque exige Docker + `/var/lib/hub_secrets/.env.hub.test`)
 *
 * Design deliberado (Decisão registrada em execute-task, onda-010): a
 * implementação REAL deste cenário já existe e está provada em
 * `infra/hub/testes/hub-rls-integration.sh` (18/18 asserts, FASE 5) — um
 * script bash que orquestra um projeto `hub-test-<runid>` efêmero via Docker
 * Compose (db+postgrest+backend reais, tmpfs) e chama o PostgREST DIRETAMENTE
 * (bypass do Express) para provar a política de RLS por si só.
 *
 * Reimplementar essa orquestração em JavaScript duplicaria ~200 linhas de
 * lógica já testada (subir containers, aplicar migrations, seed via psql,
 * assinar JWTs sintéticos, e limpar com `down -v` mesmo em falha) sem
 * agregar cobertura nova — puro custo de manutenção (2 lugares para manter
 * sincronizados). Este arquivo existe para satisfazer o nome de arquivo
 * exigido por plan.md §Source Tree (`tests/hub-rls-integration.test.js`,
 * NOVO) e para que `node --test`/CI padronizem a invocação de TODA a suíte
 * de integração do hub por um único mecanismo (`node --test`), mas o corpo
 * do teste é um wrapper fino sobre o script já provado — a fonte da verdade
 * da implementação do cenário continua em um único lugar.
 *
 * Ref: plan.md linha 114, tasks.md 6.2.1, FR-026/027/028, quickstart Scenario 9.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const HUB_DIR = path.resolve(__dirname, '..', '..', '..', 'infra', 'hub');
const SCRIPT = path.join(HUB_DIR, 'testes', 'hub-rls-integration.sh');
const ENV_FILE = process.env.HUB_TEST_ENV || '/var/lib/hub_secrets/.env.hub.test';

function dockerDisponivel() {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('hub-rls-integration.sh — RLS de reforço nega-por-padrão (quickstart Scenario 9)', (t) => {
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

  assert.match(out, /HUB-RLS-INTEGRATION: OK/, `saída do script não confirmou sucesso:\n${out}`);
});
