#!/usr/bin/env node
/**
 * verificar-retorno-transfeera-real.js — tasks.md FASE 9, 9.1.8.
 *
 * Roda SÓ se o arquivo real do operador existir nesta máquina
 * (`docs/documentos_apoio/retorno-transfeera/retorno_transfeera.csv`, fora
 * do git — dado pessoal real). Ausente = skip silencioso, exit 0 — NUNCA
 * roda em CI, nunca falha por isso.
 *
 * Confere SOMENTE:
 *   1. o cabeçalho bate com `CABECALHO_ESPERADO` (o contrato descrito em
 *      tasks.md §FASE 9, extraído do próprio arquivo em 2026-09-18);
 *   2. o vocabulário da coluna `Status` não tem nenhum valor fora de
 *      `STATUS_CONHECIDOS` (Finalizada/Devolvida).
 *
 * NUNCA imprime nome, documento, conta, valor ou qualquer outra célula —
 * só contagens e o próprio conjunto de valores de `Status` (enum de
 * estado, não dado pessoal). Nenhuma linha do arquivo é copiada para
 * fixture/teste/log.
 *
 * Uso: node scripts/verificar-retorno-transfeera-real.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  lerCsv, STATUS_CONHECIDOS, RetornoTransfeeraParseError,
} = require('../lib/adiantamento-retorno-transfeera');

const CAMINHO = path.join(__dirname, '..', '..', '..', 'docs', 'documentos_apoio', 'retorno-transfeera', 'retorno_transfeera.csv');

function main() {
  if (!fs.existsSync(CAMINHO)) {
    console.log('9.1.8: arquivo real ausente nesta máquina — verificação pulada (nunca roda em CI, nunca falha por isso).');
    return 0;
  }

  const texto = fs.readFileSync(CAMINHO, 'utf-8');
  let linhas;
  try {
    linhas = lerCsv(texto);
  } catch (e) {
    if (e instanceof RetornoTransfeeraParseError) {
      console.error(`9.1.8: FALHOU — ${e.motivo} (cabeçalho do arquivo real não bate com o contrato de tasks.md §FASE 9)`);
      return 1;
    }
    throw e;
  }
  console.log(`9.1.8: cabeçalho OK (23 colunas, contrato de tasks.md §FASE 9). ${linhas.length} linhas de dados.`);

  const statusUnicos = new Set(linhas.map((l) => l.status));
  const desconhecidos = [...statusUnicos].filter((s) => !STATUS_CONHECIDOS.has(s));
  console.log(`9.1.8: Status distintos observados: ${statusUnicos.size} (${[...statusUnicos].join(', ')}).`);
  if (desconhecidos.length > 0) {
    console.error(`9.1.8: FALHOU — status fora do vocabulário conhecido (Finalizada/Devolvida): ${JSON.stringify(desconhecidos)}`);
    return 1;
  }
  console.log('9.1.8: vocabulário de Status confere com o contrato (Finalizada/Devolvida). OK.');
  return 0;
}

process.exit(main());
