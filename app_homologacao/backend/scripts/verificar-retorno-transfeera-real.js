#!/usr/bin/env node
/**
 * verificar-retorno-transfeera-real.js — tasks.md FASE 9, 9.1.8.
 *
 * Roda SÓ se o arquivo real do operador existir nesta máquina
 * (`docs/documentos_apoio/retorno-transfeera/retorno_transfeera.xlsx`, fora
 * do git — dado pessoal real; ou o caminho em `RETORNO_TRANSFEERA_XLSX`).
 * Ausente = skip silencioso, exit 0 — NUNCA roda em CI, nunca falha por isso.
 *
 * Confere SOMENTE:
 *   1. o cabeçalho bate com `CABECALHO_ESPERADO` (as 21 colunas do XLSX);
 *   2. o vocabulário da coluna `Status` não tem nenhum valor fora de
 *      `STATUS_CONHECIDOS` (FINALIZADO/Finalizada/Devolvida).
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
  lerXlsx, STATUS_CONHECIDOS, CABECALHO_ESPERADO, RetornoTransfeeraParseError,
} = require('../lib/adiantamento-retorno-transfeera');

const CAMINHO = process.env.RETORNO_TRANSFEERA_XLSX
  || path.join(__dirname, '..', '..', '..', 'docs', 'documentos_apoio', 'retorno-transfeera', 'retorno_transfeera.xlsx');

function main() {
  if (!fs.existsSync(CAMINHO)) {
    console.log('9.1.8: arquivo real ausente nesta máquina — verificação pulada (nunca roda em CI, nunca falha por isso).');
    return 0;
  }

  let linhas;
  try {
    linhas = lerXlsx(fs.readFileSync(CAMINHO));
  } catch (e) {
    if (e instanceof RetornoTransfeeraParseError) {
      console.error(`9.1.8: FALHOU — ${e.motivo} (arquivo real não bate com o contrato de 21 colunas)`);
      return 1;
    }
    throw e;
  }
  console.log(`9.1.8: cabeçalho OK (${CABECALHO_ESPERADO.length} colunas). ${linhas.length} linhas de dados.`);

  const statusUnicos = new Set(linhas.map((l) => l.status));
  const desconhecidos = [...statusUnicos].filter((s) => !STATUS_CONHECIDOS.has(s));
  console.log(`9.1.8: Status distintos observados: ${statusUnicos.size} (${[...statusUnicos].join(', ')}).`);
  if (desconhecidos.length > 0) {
    console.error(`9.1.8: FALHOU — status fora do vocabulário conhecido (FINALIZADO/Finalizada/Devolvida): ${JSON.stringify(desconhecidos)}`);
    return 1;
  }
  console.log('9.1.8: vocabulário de Status confere com o contrato (FINALIZADO/Finalizada/Devolvida). OK.');
  return 0;
}

process.exit(main());
