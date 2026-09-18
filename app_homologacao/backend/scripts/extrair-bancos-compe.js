#!/usr/bin/env node
/**
 * extrair-bancos-compe.js — tasks.md 0.2.1
 *
 * Lê `docs/documentos_apoio/ParticipantesSTR-2026-09-17.csv` (lista pública do
 * BCB, já em disco — nunca baixa nada) e grava
 * `lib/fixtures/bancos-compe.json` com os participantes que têm código COMPE
 * de 3 dígitos (data-model.md "Dados estáticos": "código de 3 dígitos, nome,
 * ISPB"). Usada por `GET /motorista/bancos` para o motorista selecionar o
 * banco da conta — só faz sentido listar quem tem um código de 3 dígitos
 * utilizável (Constitution VI: sem fonte, sem dado).
 *
 * Filtro: `Número_Código` casa com `^\d{3}$`. NÃO é o mesmo que
 * `Participa_da_Compe === "Sim"` — dessas 474 linhas, 71 têm "Sim" mas há
 * bancos digitais com código de 3 dígitos real e usado no dia a dia (ex.:
 * NU PAGAMENTOS/260, participa "Não") que ficariam de fora se o filtro fosse
 * por aquela coluna. As 11 linhas excluídas são infraestrutura do STR sem
 * código de banco (Selic, Bacen, STN, câmaras da CIP/B3/CERC, código "n/a"
 * ou "0") — não são bancos selecionáveis.
 *
 * Uso: node scripts/extrair-bancos-compe.js
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const CSV_PATH = path.join(RAIZ, '..', '..', 'docs', 'documentos_apoio', 'ParticipantesSTR-2026-09-17.csv');
const DESTINO = path.join(RAIZ, 'lib', 'fixtures', 'bancos-compe.json');
const DATA_EXTRACAO = '2026-09-17';
const CODIGO_VALIDO = /^\d{3}$/;

/** Parser CSV mínimo (RFC 4180): aspas duplas escapam vírgula/aspas dentro
 * de um campo (o arquivo do BCB usa isso em `Nome_Extenso`, ex.: "XP
 * INVESTIMENTOS CORRETORA DE CÂMBIO,TÍTULOS ..."). Sem dependência nova. */
function parseLinhaCsv(linha) {
  const campos = [];
  let atual = '';
  let dentroDeAspas = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (dentroDeAspas) {
      if (c === '"') {
        if (linha[i + 1] === '"') {
          atual += '"';
          i++;
        } else {
          dentroDeAspas = false;
        }
      } else {
        atual += c;
      }
    } else if (c === '"') {
      dentroDeAspas = true;
    } else if (c === ',') {
      campos.push(atual);
      atual = '';
    } else {
      atual += c;
    }
  }
  campos.push(atual);
  return campos;
}

function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`CSV não encontrado: ${CSV_PATH}`);
    process.exit(1);
  }
  const conteudo = fs.readFileSync(CSV_PATH, 'utf8').replace(/^﻿/, '');
  const linhas = conteudo.split(/\r?\n/).filter((l) => l.length > 0);
  const cabecalho = parseLinhaCsv(linhas[0]);
  const idxCodigo = cabecalho.indexOf('Número_Código');
  const idxNome = cabecalho.indexOf('Nome_Reduzido');
  const idxIspb = cabecalho.indexOf('ISPB');
  if (idxCodigo < 0 || idxNome < 0 || idxIspb < 0) {
    console.error('Colunas esperadas não encontradas no cabeçalho do CSV — abortando.');
    process.exit(1);
  }

  const dataLinhas = linhas.slice(1);
  const todos = dataLinhas.map((l) => parseLinhaCsv(l));
  const bancos = todos
    .filter((campos) => CODIGO_VALIDO.test(campos[idxCodigo]))
    .map((campos) => ({
      codigo: campos[idxCodigo],
      nome: campos[idxNome],
      ispb: campos[idxIspb],
    }));

  const excluidos = todos.length - bancos.length;
  const fixture = {
    fonte: 'docs/documentos_apoio/ParticipantesSTR-2026-09-17.csv (BCB — Participantes do STR)',
    dataExtracao: DATA_EXTRACAO,
    totalLinhasCsv: todos.length,
    excluidosSemCodigo3Digitos: excluidos,
    bancos,
  };

  fs.mkdirSync(path.dirname(DESTINO), { recursive: true });
  fs.writeFileSync(DESTINO, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
  console.log(`Fixture gravada em ${path.relative(RAIZ, DESTINO)}: ${bancos.length} bancos (${excluidos} excluídos de ${todos.length} linhas)`);
}

main();
