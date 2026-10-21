/**
 * Prova o leitor de retorno contra um arquivo NO FORMATO REAL da Transfeera
 * (XLSX de 21 colunas), não contra uma planilha que nós mesmos montamos
 * (Constitution VI — o contrato de um terceiro só se confere no material dele).
 *
 * `fixtures/retorno-transfeera-21col-exemplo.xlsx` é a amostra do operador
 * (2026-10-20) já ANONIMIZADA: cabeçalho, status, valores e IDs de integração
 * são os reais; nome, documento, e-mail, banco e conta são sintéticos. Está
 * versionada de propósito — o original (com PII) fica fora do repo.
 *
 * O que ele protege: se a Transfeera mudar o cabeçalho ou o rótulo de status,
 * `lerXlsx` passa a lançar `CABECALHO_INVALIDO` / marcar STATUS_DESCONHECIDO em
 * produção e a conciliação para — este teste é onde isso aparece primeiro.
 * Nenhum dado pessoal é impresso, nem em falha: só contagens.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { lerXlsx, casarComItensDoLote } = require('../lib/adiantamento-retorno-transfeera');

const FIXTURE = path.join(__dirname, 'fixtures', 'retorno-transfeera-21col-exemplo.xlsx');
const buffer = () => fs.readFileSync(FIXTURE);

// ADV-000015 .. ADV-000074 (58 linhas, todas FINALIZADO) — itens do lote
// espelham o que o exportador gerou para cada linha.
function itensDoLote(linhas, situacao = 'incluido') {
  return linhas.map((l) => ({
    solicitacaoId: Number(l.idIntegracao.slice(4)),
    colIdIntegracao: l.idIntegracao,
    situacao,
    valorCentavos: l.valorCentavos,
  }));
}

test('arquivo real: lê as 58 linhas, todas FINALIZADO, de ADV-000015 a ADV-000074', () => {
  const linhas = lerXlsx(buffer());
  assert.equal(linhas.length, 58);
  assert.equal(linhas[0].idIntegracao, 'ADV-000015');
  assert.equal(linhas[57].idIntegracao, 'ADV-000074');
  assert.equal(linhas[0].valorCentavos, 5457); // "54,57" é texto na célula
  assert.ok(linhas.every((l) => l.status === 'FINALIZADO' && l.statusConhecido));
  assert.ok(linhas.every((l) => Number.isFinite(l.valorCentavos)));
});

test('arquivo real: 58 de 58 aplicados e reenvio idempotente (US1-AS1/AS2)', () => {
  const linhas = lerXlsx(buffer());

  const primeira = casarComItensDoLote(linhas, itensDoLote(linhas));
  assert.equal(primeira.aplicaveis.length, 58);
  assert.deepEqual(primeira.ignoradas, []);
  assert.deepEqual(primeira.faltantes, []);
  assert.ok(primeira.aplicaveis.every((a) => a.status === 'FINALIZADO' && a.motivo === null));

  // Reenvio com o lote já pago: nada é reaplicado, nada some.
  const segunda = casarComItensDoLote(linhas, itensDoLote(linhas, 'pago'));
  assert.equal(segunda.aplicaveis.length, 0);
  assert.equal(segunda.ignoradas.length, 58);
  assert.ok(segunda.ignoradas.every((i) => i.motivo === 'JA_APLICADO'));
});

test('arquivo real: linha de outro lote NUNCA casa com item (sem casar por nome ou valor)', () => {
  const linhas = lerXlsx(buffer());
  const itens = [{ solicitacaoId: 3, colIdIntegracao: 'ADV-000003', situacao: 'incluido', valorCentavos: 5457 }];
  const { aplicaveis, ignoradas, faltantes } = casarComItensDoLote(linhas, itens);
  assert.equal(aplicaveis.length, 0);
  assert.deepEqual(faltantes, [3]);
  assert.equal(ignoradas.length, 58);
  assert.ok(ignoradas.every((i) => i.motivo === 'NAO_PERTENCE_AO_LOTE'));
});

test('fixture anonimizada: sem e-mails (pega regravação por engano)', () => {
  // Inspeção mínima, só contagem. Não prova a anonimização — quem prova é o
  // diff de células feito antes do commit.
  const XLSX = require('xlsx');
  const wb = XLSX.read(buffer(), { type: 'buffer' });
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true });
  const iEmail = aoa[0].indexOf('Email');
  const comEmail = aoa.slice(1).filter((l) => String(l[iEmail]).includes('@')).length;
  assert.equal(comEmail, 0, 'a fixture não deve conter e-mails');
});

// LACUNA CONHECIDA (evidência do parceiro, não de código): o material real da
// Transfeera não tem NENHUMA devolução — as 58 linhas são FINALIZADO. O ramo de
// falha (`Devolvida`, com e sem motivo, vários códigos) é coberto só por XLSX
// SINTÉTICO em `adiantamento-retorno-transfeera-unit.test.js`. Este teste existe
// para a lacuna ficar legível na suíte: se uma amostra real com devolução entrar
// na fixture, ele falha e manda trocar a afirmação por uma de verdade.
//
// Risco medido: a comparação de status é `Set.has` CASE-SENSITIVE e o XLSX usa
// MAIÚSCULA (`FINALIZADO`); uma devolução provavelmente virá como `DEVOLVIDO`,
// rótulo que ninguém mediu e que NÃO é reconhecido (não inventar no set). Cai em
// `STATUS_DESCONHECIDO:<valor>`, que o 409 RETORNO_INCOMPLETO agora entrega à
// tela ("Status que não sabemos interpretar (DEVOLVIDO)") — o operador envia a
// amostra e só então o rótulo entra no contrato.
test('LACUNA CONHECIDA: o material real do parceiro não tem nenhuma devolução — o ramo de falha é coberto só por XLSX sintético', () => {
  const linhas = lerXlsx(buffer());
  const devolucoes = linhas.filter((l) => l.status !== 'FINALIZADO');
  assert.equal(devolucoes.length, 0);
});
