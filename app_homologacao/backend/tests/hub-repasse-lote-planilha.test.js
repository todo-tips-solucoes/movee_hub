/**
 * Integração — migration 0109: o lote de repasse enxerga movimentos vindos de
 * importação de planilha (EnvioMassa), não só os gerados pelo hub. Prova por HTTP
 * no PostgREST do ambiente hub_homolog (dados efêmeros 9109xxx, apagados num trap).
 * Chamado por npm run test:hub:integration — NÃO faz parte do `npm test` padrão:
 * exige o ambiente hub_homolog no ar. Orquestração em
 * infra/hub/testes/hub-repasse-lote-planilha.sh.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const HUB_DIR = path.resolve(__dirname, '..', '..', '..', 'infra', 'hub');
const SCRIPT = path.join(HUB_DIR, 'testes', 'hub-repasse-lote-planilha.sh');
const ENV_FILE = process.env.HUB_HOMOLOG_ENV || '/var/lib/hub_secrets/.env.hub.homolog';

function homologNoAr() {
  try {
    const out = execFileSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' });
    return out.split('\n').includes('hub_homolog_db');
  } catch {
    return false;
  }
}

test('hub-repasse-lote-planilha.sh — prévia do lote com movimento de planilha (hub-só, planilha-só, ambos, trilha órfã, dois tenants, sem vínculo)', (t) => {
  if (!fs.existsSync(ENV_FILE)) {
    t.skip(`env file ausente (${ENV_FILE}) — este ambiente não tem o hub_homolog provisionado`);
    return;
  }
  if (!homologNoAr()) {
    t.skip('container hub_homolog_db fora do ar — pulando integração real');
    return;
  }

  const out = execFileSync('bash', [SCRIPT], {
    cwd: path.resolve(HUB_DIR, '..', '..'),
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
  });

  assert.match(out, /resultado: OK/, `saída do script não confirmou sucesso:\n${out}`);
  assert.doesNotMatch(out, /^FAIL/m, `há caso FAIL:\n${out}`);
  assert.equal((out.match(/^PASS/gm) || []).length, 7, `esperava 7 PASS:\n${out}`);
});
