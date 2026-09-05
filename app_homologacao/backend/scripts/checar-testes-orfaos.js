#!/usr/bin/env node
/**
 * checar-testes-orfaos.js — falha se algum arquivo de teste existir em
 * `tests/` sem estar na suíte do `npm test`.
 *
 * POR QUE existe: o script `test` do package.json lista os arquivos UM A UM,
 * sem glob. Um teste novo passa quando rodado direto e fica silenciosamente
 * fora da suíte — foi o que aconteceu com 7 arquivos, descobertos só em
 * 2026-09-05, e com o teste de throttle do backfill, cuja ausência só apareceu
 * porque o total não mudou depois de adicionar 3 casos.
 *
 * A alternativa "usar glob" foi descartada: os testes que exigem ambiente
 * (`hub-homolog` no ar, rodados pelos drivers `infra/hub/testes/*.sh`) NÃO
 * podem entrar na suíte local. A lista explícita é deliberada; o que faltava
 * era alguém conferi-la.
 *
 * Uso: node scripts/checar-testes-orfaos.js     (exit 1 se houver órfão)
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const script = require(path.join(RAIZ, 'package.json')).scripts.test || '';
const listados = new Set(script.match(/tests\/[A-Za-z0-9._-]+\.test\.js/g) || []);
const existem = fs.readdirSync(path.join(RAIZ, 'tests'))
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => `tests/${f}`);

// Ficam de fora POR DESENHO: exigem ambiente (hub-homolog no ar) e rodam pelos
// drivers .sh. Manter esta lista curta e justificada — não é lixeira.
const EXIGEM_AMBIENTE = new Set([
  'tests/hub-admin.test.js',
  'tests/hub-auditoria-integration.test.js',
  'tests/hub-faturamento.test.js',
  'tests/hub-import-processor-integration.test.js',
  'tests/hub-importacoes-integration.test.js',
  'tests/hub-motorista-360-integration.test.js',
  'tests/hub-motoristas-credencial.test.js',
  'tests/hub-motoristas.test.js',
  'tests/hub-papeis.test.js',
  'tests/hub-performance.test.js',
  'tests/hub-rls-integration.test.js',
  'tests/hub-usuarios.test.js',
]);

const orfaos = existem.filter((f) => !listados.has(f) && !EXIGEM_AMBIENTE.has(f));
const fantasmas = [...listados].filter((f) => !existem.includes(f));

let erro = false;
if (orfaos.length) {
  erro = true;
  console.error(`\n${orfaos.length} teste(s) NAO rodam na suite (nem estao na lista de "exigem ambiente"):`);
  orfaos.forEach((f) => console.error(`   ${f}`));
  console.error('\n  -> se for unit, acrescente ao script "test" do package.json');
  console.error('  -> se exigir ambiente, acrescente a EXIGEM_AMBIENTE deste arquivo, com o motivo\n');
}
if (fantasmas.length) {
  erro = true;
  console.error(`\n${fantasmas.length} arquivo(s) listado(s) na suite mas INEXISTENTE(s):`);
  fantasmas.forEach((f) => console.error(`   ${f}`));
  console.error('');
}
if (erro) process.exit(1);
console.log(`ok: ${listados.size} na suite + ${EXIGEM_AMBIENTE.size} que exigem ambiente = ${existem.length} arquivos`);
