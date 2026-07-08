/**
 * Testes unitários — lib/hub-import-storage.js. Rodam com:
 * node --test tests/hub-import-storage-unit.test.js
 *
 * Cobre F10 (pós-review PR #57, LGPD): `armazenarOriginal` grava o arquivo
 * original (pode conter CNPJ/UUID/nome — PII) com permissões RESTRITAS —
 * diretório `0700` e arquivo `0600` — em vez do `umask` padrão do container
 * (que deixaria o volume legível por qualquer processo com acesso a ele).
 *
 * Usa um diretório temporário real (via HUB_UPLOADS_DIR) — mais fiel que
 * mockar `fs`, já que o que importa aqui é o MODO efetivo no filesystem.
 */

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let tmpDir;
let armazenarOriginal;
let caminhoArmazenamento;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-import-storage-test-'));
  process.env.HUB_UPLOADS_DIR = tmpDir;
  // eslint-disable-next-line global-require
  ({ armazenarOriginal, caminhoArmazenamento } = require('../lib/hub-import-storage'));
});

after(async () => {
  delete process.env.HUB_UPLOADS_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('armazenarOriginal (F10 — pós-review PR #57, LGPD)', () => {
  test('grava o arquivo no path determinístico (mesmo de caminhoArmazenamento)', async () => {
    const buf = Buffer.from('cnpj;nome\n11.111.111/0001-11;Fulano de Tal\n', 'utf8');
    const destino = await armazenarOriginal(777, '.csv', buf);
    assert.equal(destino, caminhoArmazenamento(777, '.csv'));
    const lido = await fs.readFile(destino);
    assert.equal(Buffer.compare(lido, buf), 0);
  });

  test('diretório da importação é criado com modo 0700 (só o dono acessa)', async () => {
    await armazenarOriginal(778, '.csv', Buffer.from('x'));
    const dirPath = path.dirname(caminhoArmazenamento(778, '.csv'));
    const stat = await fs.stat(dirPath);
    // eslint-disable-next-line no-bitwise
    const modoEfetivo = stat.mode & 0o777;
    assert.equal(modoEfetivo, 0o700, `esperava 0700, obtido ${modoEfetivo.toString(8)}`);
  });

  test('arquivo original é gravado com modo 0600 (só o dono lê/escreve)', async () => {
    await armazenarOriginal(779, '.zip', Buffer.from('conteudo-zip-fake'));
    const filePath = caminhoArmazenamento(779, '.zip');
    const stat = await fs.stat(filePath);
    // eslint-disable-next-line no-bitwise
    const modoEfetivo = stat.mode & 0o777;
    assert.equal(modoEfetivo, 0o600, `esperava 0600, obtido ${modoEfetivo.toString(8)}`);
  });
});
