#!/usr/bin/env node
/**
 * extrair-contrato-transfeera.js — tasks.md 0.1.3
 *
 * Lê o modelo local `docs/documentos_apoio/modelo_transfeera.xlsx` (nunca vai
 * pro git — .gitignore) e grava a fixture sanitizada
 * `lib/fixtures/transfeera-contrato.json` com só a estrutura: nome da aba,
 * texto de A1, o range da mesclagem e os 12 cabeçalhos da linha 2.
 *
 * NUNCA lê nem grava a linha 3 em diante (dado pessoal real — CPF/CNPJ,
 * nome, dados bancários de um motorista de verdade).
 *
 * Uso: node scripts/extrair-contrato-transfeera.js
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const RAIZ = path.join(__dirname, '..');
const MODELO = path.join(RAIZ, '..', '..', 'docs', 'documentos_apoio', 'modelo_transfeera.xlsx');
const DESTINO = path.join(RAIZ, 'lib', 'fixtures', 'transfeera-contrato.json');
const COLUNAS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];

function main() {
  if (!fs.existsSync(MODELO)) {
    console.error(`Modelo não encontrado: ${MODELO}`);
    process.exit(1);
  }
  const wb = XLSX.readFile(MODELO);
  const nomeAba = wb.SheetNames[0];
  const ws = wb.Sheets[nomeAba];

  const merges = ws['!merges'] || [];
  const mescladaA1L1 = merges.find((m) => m.s.r === 0 && m.s.c === 0 && m.e.r === 0);
  if (!mescladaA1L1) {
    console.error('Mesclagem A1:L1 não encontrada no modelo — abortando (contrato mudou?)');
    process.exit(1);
  }

  const cabecalhos = COLUNAS.map((col) => {
    const cell = ws[`${col}2`];
    return cell ? String(cell.v) : null;
  });
  if (cabecalhos.some((h) => h === null)) {
    console.error('Cabeçalho ausente em alguma das 12 colunas (A2:L2) — abortando.');
    process.exit(1);
  }

  const fixture = {
    aba: nomeAba,
    linha1Texto: String(ws.A1.v),
    mesclagemLinha1: `${XLSX.utils.encode_cell(mescladaA1L1.s)}:${XLSX.utils.encode_cell(mescladaA1L1.e)}`,
    cabecalhos,
  };

  fs.mkdirSync(path.dirname(DESTINO), { recursive: true });
  fs.writeFileSync(DESTINO, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
  console.log(`Fixture gravada em ${path.relative(RAIZ, DESTINO)}`);
}

main();
