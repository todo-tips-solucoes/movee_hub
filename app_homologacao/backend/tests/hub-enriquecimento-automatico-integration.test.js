/**
 * Testes de integração — hub-enriquecimento-automatico (FASE 5, tasks.md
 * 5.1-5.5): gatilho hub_entregador_enfileira_import() da migration 0060
 * (teto/Scenario 10, empresa não habilitada/Scenario 12, retroatividade/
 * Scenario 13, convivência com trg_entregador_protege_nome/Scenario 14, RLS
 * de "EnriquecimentoAutomatico"/Scenario 17) + código de rota que passou a
 * existir na FASE 3 (prioridade do pedido manual/Scenario 11, regressão do
 * evento UPDATE fora do pipeline de importação/Scenario 16). Rodam com:
 * node --test tests/hub-enriquecimento-automatico-integration.test.js
 *
 * Mesmo design de tests/hub-motorista-360-integration.test.js: a
 * orquestração real (JWT sintético via lib/hub-postgrest-jwt.js, seed/
 * cleanup via psql direto, login QA para as duas rotas que dependem do
 * código Express) vive em
 * infra/hub/testes/hub-enriquecimento-automatico-integration-homolog.sh —
 * este wrapper só padroniza a invocação via `node --test`. Usa o ambiente
 * `hub-homolog` PERSISTENTE (`HUB_HOMOLOG_ENV`, default
 * /var/lib/hub_secrets/.env.hub.homolog), não uma stack efêmera.
 *
 * Scenario 15 (reprodução das medições em container descartável) é
 * opcional e fica fora deste wrapper — ver cabeçalho do .sh.
 *
 * Ref: docs/specs/hub-enriquecimento-automatico/quickstart.md, tasks.md
 * FASE 5.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const HUB_DIR = path.resolve(__dirname, '..', '..', '..', 'infra', 'hub');
const SCRIPT = path.join(HUB_DIR, 'testes', 'hub-enriquecimento-automatico-integration-homolog.sh');
const ENV_FILE = process.env.HUB_HOMOLOG_ENV || '/var/lib/hub_secrets/.env.hub.homolog';

function dockerDisponivel() {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('hub-enriquecimento-automatico-integration-homolog.sh — teto/excedente + manual-primeiro + empresa não habilitada + retroatividade + convivência de gatilhos + RLS + regressão do evento UPDATE', (t) => {
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

  assert.match(out, /HUB-ENRIQUECIMENTO-AUTOMATICO-INTEGRATION-HOMOLOG: OK/, `saída do script não confirmou sucesso:\n${out}`);
});
