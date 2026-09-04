/**
 * Testes de integração — hub-motorista-360 (FASE 8, tasks.md 8.1.1): vínculo
 * automático de credencial (Scenarios 1/2), máscara de campo RBAC (Scenarios
 * 4/7), fila de enriquecimento EntreGô 202/429 + falha preserva dado anterior
 * (Scenarios 5-parcial/6). Rodam com: node --test
 * tests/hub-motorista-360-integration.test.js
 *
 * Mesmo design de tests/hub-motoristas.test.js / hub-motoristas-credencial.test.js:
 * a orquestração real (login via 3 contas QA, seed/cleanup via psql direto)
 * vive em infra/hub/testes/hub-motorista-360-integration-homolog.sh — este
 * wrapper padroniza a invocação via `node --test` sem duplicar a orquestração
 * em JS. DIFERENTE dos scripts irmãos citados acima: este NÃO sobe uma stack
 * `hub-test-<runid>` efêmera — usa o ambiente `hub-homolog` PERSISTENTE que já
 * está no ar (pedido explícito da onda, FASE 8), então a variável de gate é
 * `HUB_HOMOLOG_ENV` (default `/var/lib/hub_secrets/.env.hub.homolog`), não
 * `HUB_TEST_ENV`.
 *
 * Scenario 3 (backfill) e Scenario 5 (409 SEM_IDENTIFICADOR_ENTREGO) NÃO são
 * cobertos por este script — ver cabeçalho de
 * hub-motorista-360-integration-homolog.sh para a justificativa de cada um
 * (o 2º é estruturalmente irreprodutível contra o schema real:
 * "Entregador".id_externo é `uuid NOT NULL`; coberto só pelo unit test
 * tests/hub-motoristas-entrego-enriquecimento-unit.test.js).
 *
 * Ref: docs/specs/hub-motorista-360/quickstart.md, tasks.md FASE 8.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const HUB_DIR = path.resolve(__dirname, '..', '..', '..', 'infra', 'hub');
const SCRIPT = path.join(HUB_DIR, 'testes', 'hub-motorista-360-integration-homolog.sh');
const ENV_FILE = process.env.HUB_HOMOLOG_ENV || '/var/lib/hub_secrets/.env.hub.homolog';

function dockerDisponivel() {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('hub-motorista-360-integration-homolog.sh — vínculo automático + RBAC de campo + fila EntreGô (202/429/falha preserva dado)', (t) => {
  if (!fs.existsSync(ENV_FILE)) {
    t.skip(`env file ausente (${ENV_FILE}) — este ambiente não tem o hub-homolog provisionado`);
    return;
  }
  if (!dockerDisponivel()) {
    t.skip('docker compose indisponível neste ambiente — pulando integração real');
    return;
  }

  const out = execFileSync('bash', [SCRIPT], {
    cwd: path.resolve(HUB_DIR, '..', '..'),
    encoding: 'utf8',
    timeout: 3 * 60 * 1000,
  });

  assert.match(out, /HUB-MOTORISTA-360-INTEGRATION-HOMOLOG: OK/, `saída do script não confirmou sucesso:\n${out}`);
});
