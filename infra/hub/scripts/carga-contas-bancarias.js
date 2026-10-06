#!/usr/bin/env node
/**
 * Gera o SQL da carga de contas bancárias a partir da planilha do operador.
 *
 * NÃO escreve no banco: produz um arquivo .sql em transação única, para ser
 * revisado antes de rodar. Carga de conta bancária é dinheiro — o caminho tem
 * de ser auditável, e um script que já aplica não deixa ninguém olhar antes.
 *
 *   node infra/hub/scripts/carga-contas-bancarias.js <planilha.xlsx> [--empresa 6]
 *
 * Decisões do operador (2026-10-06), todas refletidas aqui:
 *   - status APROVADA, origem CARGA_INICIAL (a origem que a tabela previa);
 *   - quem JÁ tem conta é SUBSTITUÍDO pela planilha;
 *   - poupança entra (a 0104 abriu a exceção só para esta origem);
 *   - quem não casa por `id_externo` fica de fora, com lista.
 *
 * As validações de formato são as MESMAS do resto do sistema
 * (`backend/lib/adiantamento-conta.js`) — DV de CPF/CNPJ, banco COMPE, agência
 * de 4 dígitos, conta e dígito. Uma fonte só da regra.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '../../..');
const backend = path.join(RAIZ, 'app_homologacao/backend');
const xlsx = require(path.join(backend, 'node_modules/xlsx'));
const {
  validarDocumento, validarBanco, normalizarAgencia, validarConta, validarDigitoConta,
} = require(path.join(backend, 'lib/adiantamento-conta.js'));

const TIPO_PLANILHA = { 'conta corrente': 'CORRENTE', 'conta poupança': 'POUPANCA', 'conta poupanca': 'POUPANCA' };

function soDigitos(v) { return String(v ?? '').replace(/\D/g, ''); }
function sqlStr(v) { return v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`; }

function main() {
  const arquivo = process.argv[2];
  const idxEmpresa = process.argv.indexOf('--empresa');
  const empresa = idxEmpresa > -1 ? Number(process.argv[idxEmpresa + 1]) : 6;
  if (!arquivo || !fs.existsSync(arquivo)) {
    console.error('uso: node infra/hub/scripts/carga-contas-bancarias.js <planilha.xlsx> [--empresa 6]');
    process.exit(2);
  }

  const wb = xlsx.readFile(arquivo);
  const linhas = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);

  const prontas = [];
  const ignoradas = [];
  const vistos = new Set();

  linhas.forEach((row, i) => {
    const numero = i + 2; // linha no Excel
    const recusa = (motivo) => ignoradas.push({ numero, nome: row.Nome, id: row.ID, motivo });

    const idExterno = String(row.ID ?? '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(idExterno)) return recusa('ID não é um uuid');
    // A planilha pode repetir o mesmo motorista; a última linha venceria em
    // silêncio. Melhor recusar a repetição e deixar visível.
    if (vistos.has(idExterno)) return recusa('ID repetido na planilha');
    vistos.add(idExterno);

    const doc = validarDocumento(row['CPF/CNPJ do titular da Conta']);
    if (!doc.valido) return recusa('documento do titular inválido (DV)');

    const banco = validarBanco(soDigitos(row.Banco).padStart(3, '0'));
    if (!banco.valido) return recusa(`banco ${soDigitos(row.Banco)} fora da lista COMPE`);

    const agencia = normalizarAgencia(soDigitos(row['Agência']));
    if (!agencia) return recusa('agência inválida');

    const conta = validarConta(soDigitos(row.Conta));
    if (!conta.valido) return recusa('conta inválida');

    const digito = String(row['Dígito'] ?? '').trim();
    if (!validarDigitoConta(digito)) return recusa('dígito da conta inválido');

    const tipo = TIPO_PLANILHA[String(row['Tipo Conta'] ?? '').trim().toLowerCase()];
    if (!tipo) return recusa(`tipo de conta não reconhecido: "${row['Tipo Conta']}"`);

    const titular = String(row['Nome titular'] ?? '').trim();
    if (!titular || titular.length > 120) return recusa('nome do titular vazio ou longo demais');

    prontas.push({
      idExterno, titular, documento: doc.documento, tipo_titular: doc.tipo,
      bancoCodigo: soDigitos(row.Banco).padStart(3, '0'), bancoNome: banco.nome,
      agencia, conta: conta.conta, digito, tipo,
    });
  });

  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const destino = process.env.HOME || '/root';
  const sqlPath = path.join(destino, `carga-contas-${stamp}.sql`);
  const csvPath = path.join(destino, `carga-contas-ignoradas-${stamp}.csv`);

  const sql = [];
  sql.push('-- Carga de contas bancárias (gerada por infra/hub/scripts/carga-contas-bancarias.js)');
  sql.push(`-- Planilha: ${path.basename(arquivo)} | empresa ${empresa} | ${prontas.length} candidatas`);
  sql.push('--');
  sql.push('-- Só entra quem casa por `id_externo` com Entregador ATIVO da empresa.');
  sql.push('-- Quem já tem conta APROVADA/PENDENTE é substituído/cancelado, como decidido.');
  sql.push('BEGIN;');
  sql.push('CREATE TEMP TABLE _carga (id_externo text, titular text, documento text, tipo_titular text,');
  sql.push('  banco_codigo text, banco_nome text, agencia text, conta text, digito text, tipo_conta text) ON COMMIT DROP;');
  sql.push('INSERT INTO _carga VALUES');
  sql.push(prontas.map((p) => `  (${[p.idExterno, p.titular, p.documento, p.tipo_titular, p.bancoCodigo, p.bancoNome, p.agencia, p.conta, p.digito, p.tipo].map(sqlStr).join(', ')})`).join(',\n') + ';');
  sql.push('');
  sql.push('-- 1. quem casa de fato (entregador ativo da empresa)');
  sql.push('CREATE TEMP TABLE _alvo ON COMMIT DROP AS');
  sql.push(`SELECT c.*, e.id AS entregador_id FROM _carga c`);
  sql.push(`  JOIN "Entregador" e ON e.id_externo::text = c.id_externo AND e.id_empresa = ${empresa} AND e.ativo;`);
  sql.push("\\echo '--- casaram com entregador ativo:'");
  sql.push('SELECT count(*) FROM _alvo;');
  sql.push('');
  sql.push('-- 2. aposenta o que existe hoje para esses entregadores');
  sql.push(`UPDATE "ContaBancariaMotorista" SET status = 'SUBSTITUIDA', revisada_em = now()`);
  sql.push(` WHERE status = 'APROVADA' AND entregador_id IN (SELECT entregador_id FROM _alvo);`);
  sql.push(`UPDATE "ContaBancariaMotorista" SET status = 'CANCELADA', revisada_em = now()`);
  sql.push(` WHERE status = 'PENDENTE' AND entregador_id IN (SELECT entregador_id FROM _alvo);`);
  sql.push('');
  sql.push('-- 3. insere as novas, já aprovadas');
  sql.push(`INSERT INTO "ContaBancariaMotorista" (`);
  sql.push('  id_empresa, entregador_id, origem, status, titular_nome, titular_documento, titular_tipo,');
  sql.push('  banco_codigo, banco_nome, agencia, conta, conta_digito, tipo_conta,');
  sql.push('  entregador_confirmado_id, revisada_em, alertas)');
  sql.push(`SELECT ${empresa}, a.entregador_id, 'CARGA_INICIAL', 'APROVADA', a.titular, a.documento, a.tipo_titular,`);
  sql.push("  a.banco_codigo, a.banco_nome, a.agencia, a.conta, a.digito, a.tipo_conta,");
  sql.push("  a.entregador_id, now(), '[]'::jsonb");
  sql.push('  FROM _alvo a;');
  sql.push('');
  sql.push("\\echo '--- contas por tipo e titular depois da carga:'");
  sql.push(`SELECT origem, status, tipo_conta, titular_tipo, count(*) FROM "ContaBancariaMotorista"`);
  sql.push(` WHERE id_empresa = ${empresa} GROUP BY 1,2,3,4 ORDER BY 5 DESC;`);
  sql.push('');
  sql.push('-- Troque por COMMIT depois de conferir os números acima.');
  sql.push('ROLLBACK;');
  fs.writeFileSync(sqlPath, sql.join('\n') + '\n');

  const csv = ['linha,nome,id,motivo', ...ignoradas.map((i) => `${i.numero},"${String(i.nome ?? '').replace(/"/g, '""')}",${i.id},"${i.motivo}"`)];
  fs.writeFileSync(csvPath, csv.join('\n') + '\n');

  const porMotivo = {};
  for (const i of ignoradas) porMotivo[i.motivo] = (porMotivo[i.motivo] || 0) + 1;

  console.log(`linhas na planilha : ${linhas.length}`);
  console.log(`prontas para carga : ${prontas.length}`);
  console.log(`  corrente         : ${prontas.filter((p) => p.tipo === 'CORRENTE').length}`);
  console.log(`  poupança         : ${prontas.filter((p) => p.tipo === 'POUPANCA').length}`);
  console.log(`  titular PJ       : ${prontas.filter((p) => p.tipo_titular === 'PJ').length}`);
  console.log(`  titular PF       : ${prontas.filter((p) => p.tipo_titular === 'PF').length}`);
  console.log(`ignoradas          : ${ignoradas.length}`);
  for (const [m, n] of Object.entries(porMotivo).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${m}`);
  console.log(`\nSQL     : ${sqlPath}   (nasce em ROLLBACK — troque por COMMIT para aplicar)`);
  console.log(`Ignoradas: ${csvPath}`);
}

main();
