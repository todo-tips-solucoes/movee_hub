#!/usr/bin/env node
/**
 * Gera o SQL que vincula entregadores a CNPJ a partir de uma lista (CSV/XLSX).
 *
 * Nasceu do retorno do setor financeiro (2026-10-07) às listas de quem estava
 * sem CNPJ: eles devolveram o documento de cada um, e as migrations 0093/0102
 * não servem aqui — elas DESCOBREM o CNPJ por nome, e neste caso ele já veio
 * dito por quem é dono da informação.
 *
 *   node infra/hub/scripts/vincular-cnpj-por-lista.js <arquivo> \
 *        --id-col id_entregador --cnpj-col cnpj [--empresa 6]
 *
 * NÃO escreve no banco: produz um .sql em transação que nasce em ROLLBACK.
 *
 * O que ele recusa, e por quê:
 *   - CNPJ com DV inválido — documento errado vira nota fiscal errada;
 *   - entregador que já tem vínculo — não se troca CNPJ por lista, isso é
 *     decisão caso a caso;
 *   - CNPJ já usado por OUTRO entregador — daria a conta de um ao outro, que é
 *     a mesma classe de erro que as guardas de homônimo da 0093 evitam.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '../../..');
const backend = path.join(RAIZ, 'app_homologacao/backend');
const xlsx = require(path.join(backend, 'node_modules/xlsx'));
const { validarDocumento } = require(path.join(backend, 'lib/adiantamento-conta.js'));

function arg(nome, padrao) {
  const i = process.argv.indexOf(nome);
  return i > -1 ? process.argv[i + 1] : padrao;
}
function sqlStr(v) { return v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`; }

function lerLinhas(arquivo) {
  if (/\.csv$/i.test(arquivo)) {
    const wb = xlsx.read(fs.readFileSync(arquivo, 'latin1'), { type: 'string', raw: true, FS: ';' });
    return xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  }
  const wb = xlsx.readFile(arquivo);
  return xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
}

function main() {
  const arquivo = process.argv[2];
  const idCol = arg('--id-col', 'id_entregador');
  const cnpjCol = arg('--cnpj-col', 'cnpj');
  const empresa = Number(arg('--empresa', 6));
  if (!arquivo || !fs.existsSync(arquivo)) {
    console.error('uso: node infra/hub/scripts/vincular-cnpj-por-lista.js <arquivo> [--id-col id_entregador] [--cnpj-col cnpj] [--empresa 6]');
    process.exit(2);
  }

  const linhas = lerLinhas(arquivo);
  const prontas = [];
  const ignoradas = [];
  const vistos = new Set();

  linhas.forEach((row, i) => {
    const numero = i + 2;
    const recusa = (motivo) => ignoradas.push({ numero, id: row[idCol], motivo });
    const id = String(row[idCol] ?? '').trim();
    const bruto = String(row[cnpjCol] ?? '').trim();

    if (!/^[0-9a-f-]{36}$/i.test(id)) return recusa('id do entregador não é uuid');
    if (!bruto || /^(em andamento|n[aã]o possui|-)$/i.test(bruto)) return recusa('sem CNPJ informado');
    const doc = validarDocumento(bruto);
    if (!doc.valido || doc.tipo !== 'PJ') return recusa('CNPJ inválido (DV) ou não é CNPJ');
    if (vistos.has(id)) return recusa('id repetido na lista');
    vistos.add(id);
    prontas.push({ id, cnpj: doc.documento, nome: String(row.nome ?? row.Nome ?? '').trim() });
  });

  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const destino = process.env.HOME || '/root';
  const sqlPath = path.join(destino, `vinculo-cnpj-${stamp}.sql`);
  const csvPath = path.join(destino, `vinculo-cnpj-ignorados-${stamp}.csv`);

  const sql = [];
  sql.push('-- Vínculo de CNPJ por lista (infra/hub/scripts/vincular-cnpj-por-lista.js)');
  sql.push(`-- Origem: ${path.basename(arquivo)} | empresa ${empresa} | ${prontas.length} candidatos`);
  sql.push('BEGIN;');
  sql.push('CREATE TEMP TABLE _lista (id_externo text, cnpj text, nome text) ON COMMIT DROP;');
  sql.push('INSERT INTO _lista VALUES');
  sql.push(prontas.map((p) => `  (${[p.id, p.cnpj, p.nome].map(sqlStr).join(', ')})`).join(',\n') + ';');
  sql.push('');
  sql.push('-- Classificação ANTES de escrever: cada recusa tem nome próprio.');
  sql.push('CREATE TEMP TABLE _plano ON COMMIT DROP AS');
  sql.push('SELECT l.*, e.id AS entregador_id, cm.id AS conta_id,');
  sql.push('  CASE');
  sql.push('    WHEN e.id IS NULL                 THEN \'ENTREGADOR_NAO_ENCONTRADO\'');
  sql.push('    WHEN e.motorista_id IS NOT NULL   THEN \'JA_TEM_VINCULO\'');
  sql.push('    WHEN e2.id IS NOT NULL            THEN \'CNPJ_DE_OUTRO_ENTREGADOR\'');
  sql.push('    WHEN cm.id IS NOT NULL            THEN \'VINCULAR_CONTA_EXISTENTE\'');
  sql.push('    ELSE \'CRIAR_CONTA_E_VINCULAR\'');
  sql.push('  END AS situacao');
  sql.push('  FROM _lista l');
  sql.push(`  LEFT JOIN "Entregador" e ON e.id_externo::text = l.id_externo AND e.id_empresa = ${empresa} AND e.ativo`);
  sql.push('  LEFT JOIN "ContaMotorista" cm ON cm.cnpj_prestador = l.cnpj');
  sql.push('  LEFT JOIN "Entregador" e2 ON e2.motorista_id = cm.id AND e2.id IS DISTINCT FROM e.id;');
  sql.push("\\echo '--- plano por situacao:'");
  sql.push('SELECT situacao, count(*) FROM _plano GROUP BY 1 ORDER BY 2 DESC;');
  sql.push('');
  sql.push('-- 1. cria a ContaMotorista que falta (telefone vem da EnvioMassa, como na 0093)');
  sql.push('INSERT INTO "ContaMotorista" (cnpj_prestador, nome, telefone)');
  sql.push('SELECT p.cnpj, p.nome,');
  sql.push('       (SELECT em.number FROM "EnvioMassa" em');
  sql.push("         WHERE em.cnpj_prestador = p.cnpj AND em.number ~ '^[0-9]{12,13}$'");
  sql.push('         ORDER BY em.created_at DESC LIMIT 1)');
  sql.push("  FROM _plano p WHERE p.situacao = 'CRIAR_CONTA_E_VINCULAR';");
  sql.push('');
  sql.push('-- 2. vincula (a conta recém-criada ou a que já existia)');
  sql.push('UPDATE "Entregador" e SET motorista_id = cm.id');
  sql.push('  FROM _plano p JOIN "ContaMotorista" cm ON cm.cnpj_prestador = p.cnpj');
  sql.push(" WHERE e.id = p.entregador_id AND e.motorista_id IS NULL");
  sql.push("   AND p.situacao IN ('CRIAR_CONTA_E_VINCULAR', 'VINCULAR_CONTA_EXISTENTE');");
  sql.push('');
  sql.push("\\echo '--- depois: entregadores da empresa sem CNPJ:'");
  sql.push(`SELECT count(*) FROM "Entregador" WHERE id_empresa = ${empresa} AND motorista_id IS NULL;`);
  sql.push('');
  sql.push('-- Troque por COMMIT depois de conferir.');
  sql.push('ROLLBACK;');
  fs.writeFileSync(sqlPath, sql.join('\n') + '\n');

  fs.writeFileSync(csvPath, ['linha,id,motivo', ...ignoradas.map((i) => `${i.numero},${i.id},"${i.motivo}"`)].join('\n') + '\n');

  const porMotivo = {};
  for (const i of ignoradas) porMotivo[i.motivo] = (porMotivo[i.motivo] || 0) + 1;
  console.log(`linhas            : ${linhas.length}`);
  console.log(`candidatos        : ${prontas.length}`);
  console.log(`ignorados         : ${ignoradas.length}`);
  for (const [m, n] of Object.entries(porMotivo).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${m}`);
  console.log(`\nSQL      : ${sqlPath}   (nasce em ROLLBACK)`);
  console.log(`Ignorados: ${csvPath}`);
}

main();
