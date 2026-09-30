/**
 * Prova o leitor de retorno contra o ARQUIVO REAL do parceiro, não contra uma
 * fixture que nós mesmos escrevemos (Constitution VI — o contrato de um
 * terceiro só se confere no material dele).
 *
 * O arquivo NÃO é versionado: tem nome, CPF/CNPJ e conta bancária de milhares
 * de pessoas. Fica em `docs/documentos_apoio/retorno-transfeera/`, fora do
 * git, e este teste se declara `skip` quando ele não está presente — mesmo
 * padrão dos testes que exigem Docker ou `/var/lib/hub_secrets`.
 *
 * O que ele protege: o cabeçalho de 23 colunas e os rótulos de status
 * (`Finalizada`/`Devolvida`) vieram do arquivo de 2026-09-18. Se a Transfeera
 * mudar qualquer um deles, `lerCsv` passa a lançar `CABECALHO_INVALIDO` em
 * produção e a conciliação para — este teste é onde isso aparece primeiro.
 * Nenhum dado pessoal é impresso, nem em falha: só contagens.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { lerCsv, casarComItensDoLote, CABECALHO_ESPERADO } = require('../lib/adiantamento-retorno-transfeera');

// `RETORNO_TRANSFEERA_CSV` aponta o arquivo onde ele estiver — necessário em
// worktree (o arquivo é untracked, não vem no `git worktree add`) e útil para
// conferir um export novo sem copiá-lo para dentro do repo.
const ARQUIVO = process.env.RETORNO_TRANSFEERA_CSV || path.resolve(
  __dirname, '..', '..', '..',
  'docs', 'documentos_apoio', 'retorno-transfeera', 'retorno_transfeera.csv'
);

test('retorno real da Transfeera: o leitor aceita o arquivo do parceiro', (t) => {
  if (!fs.existsSync(ARQUIVO)) {
    t.skip(`arquivo real ausente (${path.basename(ARQUIVO)}) — não é versionado, contém PII`);
    return;
  }
  const texto = fs.readFileSync(ARQUIVO, 'utf-8');

  // 1. Cabeçalho: é a conferência que trava tudo lá na frente.
  const primeiraLinha = texto.slice(0, texto.indexOf('\n')).replace(/^﻿/, '').trim();
  assert.equal(
    primeiraLinha, CABECALHO_ESPERADO.join(','),
    'o cabeçalho do arquivo real divergiu do contrato — a Transfeera mudou o layout'
  );

  // 2. Lê inteiro sem lançar.
  const linhas = lerCsv(texto);
  assert.ok(linhas.length > 0, 'arquivo real sem linhas de dados');

  // 3. Todo status do arquivo real é conhecido — nenhum "adivinhado".
  const desconhecidos = linhas.filter((l) => !l.statusConhecido);
  assert.equal(
    desconhecidos.length, 0,
    `${desconhecidos.length} linha(s) com status fora de Finalizada/Devolvida`
  );

  // 4. Toda linha devolvida traz motivo literal (é o que vai para o histórico
  //    do adiantamento); nenhuma finalizada precisa dele.
  const devolvidas = linhas.filter((l) => l.status === 'Devolvida');
  assert.ok(devolvidas.length > 0, 'arquivo real sem nenhuma devolução — perde o caso que mais importa');
  for (const d of devolvidas) {
    assert.ok(
      (d.motivoFalha || d.codigoErro).length > 0,
      'linha Devolvida sem motivo nem código de erro'
    );
  }

  // 5. Acento sobrevive à decodificação (o motivo vai para a tela do operador).
  assert.ok(
    devolvidas.some((d) => /[áàâãéêíóôõúç]/i.test(d.motivoFalha)),
    'nenhum motivo com acento — suspeita de decodificação errada (latin-1 lido como utf-8)'
  );
});

test('retorno real: linha de outro processo NUNCA casa com item de lote', (t) => {
  if (!fs.existsSync(ARQUIVO)) {
    t.skip('arquivo real ausente — não é versionado, contém PII');
    return;
  }
  const linhas = lerCsv(fs.readFileSync(ARQUIVO, 'utf-8'));

  // O arquivo real é um export de PERÍODO: traz repasse semanal, promoções e
  // antecipações pagos por fora do hub, todos com texto livre no "ID de
  // integração". Nenhum deles pode ser casado com um item de lote — casar por
  // nome ou valor marcaria o adiantamento de outra pessoa como pago.
  const itensLote = [
    { solicitacaoId: 3, colIdIntegracao: 'ADV-000003', situacao: 'incluido', valorCentavos: 5258 },
  ];
  const { aplicaveis, ignoradas, faltantes } = casarComItensDoLote(linhas, itensLote);

  assert.equal(aplicaveis.length, 0, 'nenhuma linha deste arquivo pertence a um lote do hub');
  assert.deepEqual(faltantes, [3], 'o item do lote fica como faltante — a rota responde RETORNO_INCOMPLETO');
  assert.equal(ignoradas.length, linhas.length, 'toda linha foi ignorada, nenhuma aplicada em silêncio');
  assert.ok(
    ignoradas.every((i) => i.motivo === 'ID_INTEGRACAO_INVALIDO'),
    'motivo esperado para pagamento sem ADV-<id>'
  );
});
