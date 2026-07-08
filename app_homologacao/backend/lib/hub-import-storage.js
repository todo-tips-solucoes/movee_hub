/**
 * hub-import-storage.js — helpers puros de path/sanitização do armazenamento
 * do arquivo original de importação (tasks.md FASE 3, 3.3; FASE 4, 4.1).
 *
 * Extraído de `routes/hub-importacoes.js` (FASE 4) para ser reusado por
 * `lib/hub-import-processor.js` sem criar dependência circular
 * rota↔processor (a rota dispara o processor após criar o registro; o
 * processor precisa do MESMO path determinístico para ler o arquivo de
 * volta do disco). `routes/hub-importacoes.js` reexporta estes mesmos nomes
 * (mantém os imports dos testes unitários da FASE 3 inalterados).
 *
 * Ref: research.md Decision 8 (armazenamento por id, fora de git/log).
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

// Volume privado (compose.hub.*.yml monta um named volume no ambiente real;
// em dev/test sem volume dedicado, cai no filesystem efêmero do container —
// aceitável, pois hub-test-* é descartado ao fim de cada corrida). NUNCA
// dentro de um path servido estaticamente / alcançável por git ou log.
const UPLOADS_DIR = process.env.HUB_UPLOADS_DIR
  || path.join(__dirname, '..', 'uploads', 'importacoes');

/** Extensão em minúsculas (com ponto), ou '' se ausente. */
function extensaoDe(nomeArquivo) {
  return path.extname(nomeArquivo || '').toLowerCase();
}

/** Sanitiza o nome original para armazenamento/exibição — mantém só o
 * basename e caracteres seguros (letras/números/._-), demais viram `_`.
 * Nunca usado como parte de um path de escrita (o path real usa o `id`
 * numérico do registro — ver `caminhoArmazenamento`). */
function sanitizarNomeArquivo(nomeOriginal) {
  const base = path.basename(String(nomeOriginal || 'arquivo'));
  const seguro = base.replace(/[^A-Za-z0-9._-]/g, '_');
  return seguro.slice(0, 255) || 'arquivo';
}

function caminhoArmazenamento(importacaoId, extensao) {
  return path.join(UPLOADS_DIR, String(importacaoId), `original${extensao}`);
}

/**
 * F10 (pós-review PR #57, LGPD) — grava o arquivo ORIGINAL (pode conter
 * CNPJ/UUID/nome — PII) com permissões restritas: diretório `0700` (só o
 * dono do processo lista/entra) e arquivo `0600` (só o dono lê/escreve).
 * Sem isso, o volume ficava com o `umask` padrão do container (tipicamente
 * `022` -> diretório `0755`/arquivo `0644`, legível por qualquer processo
 * no mesmo host/container que tenha acesso ao volume).
 *
 * TODO (D5, futuro — fora do escopo desta correção): retenção/expurgo do
 * arquivo original após um prazo — hoje ele fica indefinidamente no volume.
 *
 * @param {number} importacaoId
 * @param {string} extensao - ex.: '.csv' ou '.zip'
 * @param {Buffer} buffer
 * @returns {Promise<string>} o caminho onde foi gravado
 */
async function armazenarOriginal(importacaoId, extensao, buffer) {
  const destino = caminhoArmazenamento(importacaoId, extensao);
  await fs.mkdir(path.dirname(destino), { recursive: true, mode: 0o700 });
  await fs.writeFile(destino, buffer, { mode: 0o600 });
  return destino;
}

module.exports = {
  UPLOADS_DIR,
  extensaoDe,
  sanitizarNomeArquivo,
  caminhoArmazenamento,
  armazenarOriginal,
};
