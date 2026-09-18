/**
 * Testes unitários — fixture do contrato Transfeera (tasks.md 0.1.5) e
 * `lib/adiantamento-transfeera-xlsx.js` (tasks.md 2.3).
 * Rodam com: node --test tests/adiantamento-transfeera-xlsx-unit.test.js
 *
 * CPF/CNPJ usados são exemplos didáticos padrão (dígito verificador válido,
 * sem nenhum dado pessoal real) — mesmos de `adiantamento-conta-unit.test.js`.
 *
 * Ref: contracts/transfeera-xlsx.md.
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const fixture = require('../lib/fixtures/transfeera-contrato.json');
const {
  montarPlanilhaTransfeera,
  validarPlanilhaTransfeera,
  renderizarDescricaoPix,
  formatarDataProducaoDDMMAA,
  nomeArquivoTransfeera,
} = require('../lib/adiantamento-transfeera-xlsx');

describe('fixture transfeera-contrato.json', () => {
  test('aba é Página1', () => {
    assert.equal(fixture.aba, 'Página1');
  });

  test('tem 12 cabeçalhos, na ordem do contrato', () => {
    assert.equal(fixture.cabecalhos.length, 12);
    assert.deepEqual(fixture.cabecalhos, [
      'Nome ou Razão Social',
      'CPF ou CNPJ',
      'Email (opcional)',
      'Banco',
      'Agência',
      'Conta',
      'Dígito da conta',
      'Tipo de Conta (Corrente ou Poupança)',
      'Valor',
      'ID integração (opcional)',
      'Data de agendamento (opcional)',
      'Descrição Pix (opcional)',
    ]);
  });

  test('mesclagem da linha 1 cobre A1:L1', () => {
    assert.equal(fixture.mesclagemLinha1, 'A1:L1');
  });

  test('não carrega nenhum dado de linha 3 (só estrutura)', () => {
    const chaves = Object.keys(fixture);
    assert.deepEqual(chaves.sort(), ['aba', 'cabecalhos', 'linha1Texto', 'mesclagemLinha1']);
  });
});

// --- 2.3: montarPlanilhaTransfeera() / validarPlanilhaTransfeera() ---------

const MODELO_PIX = 'Antecipação entregador mei {data_producao:DD.MM.AA}_{nome}';

function itemCpf() {
  return {
    col_nome: 'José da Conceição Ação', // acento/caractere especial, edge #28
    col_documento: '123.456.789-09',
    col_email: '',
    col_banco: '260',
    col_agencia: '0001',
    col_conta: '00004521',
    col_digito: '7',
    col_tipo_conta: 'Conta Corrente',
    valor: 129.4,
    col_id_integracao: 'ADV-000123',
    col_data_agendamento: '',
    col_descricao_pix: renderizarDescricaoPix(MODELO_PIX, { nome: 'José da Conceição Ação', dataProducaoISO: '2026-09-16' }),
  };
}

function itemCnpj() {
  return {
    col_nome: 'Transportes ABC Ltda',
    col_documento: '11.222.333/0001-81',
    col_email: 'financeiro@example.com',
    col_banco: '001',
    col_agencia: '0999',
    col_conta: '123',
    col_digito: '4',
    col_tipo_conta: 'Conta Poupança',
    valor: 50,
    col_id_integracao: 'ADV-000124',
    col_data_agendamento: '',
    col_descricao_pix: renderizarDescricaoPix(MODELO_PIX, { nome: 'Transportes ABC Ltda', dataProducaoISO: '2026-09-16' }),
  };
}

describe('montarPlanilhaTransfeera() + validarPlanilhaTransfeera() (2.3.1, 2.3.2, 2.3.5)', () => {
  test('planilha com CPF e CNPJ, os dois tipos de conta, passa na validação', () => {
    const itens = [itemCpf(), itemCnpj()];
    const buffer = montarPlanilhaTransfeera(itens, fixture);
    const r = validarPlanilhaTransfeera(buffer, fixture, {
      quantidade: 2,
      valorTotal: 12940 + 5000,
      idsIntegracao: ['ADV-000123', 'ADV-000124'],
    });
    assert.deepEqual(r, { ok: true, falhas: [] });
  });

  test('zeros à esquerda preservados byte-a-byte, sem conversão numérica (edge #21)', () => {
    const buffer = montarPlanilhaTransfeera([itemCpf()], fixture);
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const ws = wb.Sheets[fixture.aba];
    assert.equal(ws.D3.v, '260'); // banco
    assert.equal(ws.E3.v, '0001'); // agência
    assert.equal(ws.F3.v, '00004521'); // conta
    assert.equal(ws.G3.v, '7'); // dígito
    assert.equal(ws.D3.t, 's');
    assert.equal(ws.E3.t, 's');
    assert.equal(ws.F3.t, 's');
    assert.equal(ws.G3.t, 's');
  });

  test('opcionais vazios (email, data de agendamento) saem como string vazia', () => {
    const buffer = montarPlanilhaTransfeera([itemCpf()], fixture);
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const ws = wb.Sheets[fixture.aba];
    assert.equal(ws.C3.v, '');
    assert.equal(ws.K3.v, '');
  });

  test('acento e caractere especial preservados; descrição cortada em 140 (edge #28)', () => {
    const nomeLongo = 'José'.repeat(50); // gera descrição > 140 caracteres
    const item = { ...itemCpf(), col_nome: nomeLongo, col_descricao_pix: renderizarDescricaoPix(MODELO_PIX, { nome: nomeLongo, dataProducaoISO: '2026-09-16' }) };
    const buffer = montarPlanilhaTransfeera([item], fixture);
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const ws = wb.Sheets[fixture.aba];
    assert.equal(ws.A3.v, nomeLongo);
    assert.ok(ws.L3.v.length <= 140);
    assert.match(ws.L3.v, /^Antecipação entregador mei 16\.09\.26_José/);
  });

  test('tipos de célula: texto t=s nas colunas de texto, valor t=n na I', () => {
    const buffer = montarPlanilhaTransfeera([itemCpf()], fixture);
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const ws = wb.Sheets[fixture.aba];
    for (const col of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L']) {
      assert.equal(ws[`${col}3`].t, 's', `coluna ${col} deveria ser texto`);
    }
    assert.equal(ws.I3.t, 'n');
    assert.equal(ws.I3.v, 129.4);
  });

  test('quantidade divergente é recusada', () => {
    const buffer = montarPlanilhaTransfeera([itemCpf(), itemCnpj()], fixture);
    const r = validarPlanilhaTransfeera(buffer, fixture, { quantidade: 5, valorTotal: 17940, idsIntegracao: ['ADV-000123', 'ADV-000124'] });
    assert.equal(r.ok, false);
    assert.ok(r.falhas.includes('QUANTIDADE_DIVERGENTE'));
  });

  test('soma divergente (centavos) é recusada', () => {
    const buffer = montarPlanilhaTransfeera([itemCpf(), itemCnpj()], fixture);
    const r = validarPlanilhaTransfeera(buffer, fixture, { quantidade: 2, valorTotal: 1, idsIntegracao: ['ADV-000123', 'ADV-000124'] });
    assert.equal(r.ok, false);
    assert.ok(r.falhas.includes('SOMA_DIVERGENTE'));
  });

  test('ID de integração duplicado é recusado', () => {
    const dup = { ...itemCnpj(), col_id_integracao: 'ADV-000123' };
    const buffer = montarPlanilhaTransfeera([itemCpf(), dup], fixture);
    const r = validarPlanilhaTransfeera(buffer, fixture, { quantidade: 2, valorTotal: 17940, idsIntegracao: ['ADV-000123', 'ADV-000124'] });
    assert.equal(r.ok, false);
    assert.ok(r.falhas.includes('ID_DUPLICADO_OU_INESPERADO'));
  });

  test('registro com obrigatório vazio é recusado', () => {
    const invalido = { ...itemCpf(), col_banco: '' };
    const buffer = montarPlanilhaTransfeera([invalido], fixture);
    const r = validarPlanilhaTransfeera(buffer, fixture, { quantidade: 1, valorTotal: 12940, idsIntegracao: ['ADV-000123'] });
    assert.equal(r.ok, false);
    assert.ok(r.falhas.includes('OBRIGATORIO_VAZIO'));
  });
});

describe('renderizarDescricaoPix() — modelo restrito a nome/data_producao (2.3.3)', () => {
  test('renderiza os dois placeholders permitidos', () => {
    const r = renderizarDescricaoPix(MODELO_PIX, { nome: 'Fulano', dataProducaoISO: '2026-09-16' });
    assert.equal(r, 'Antecipação entregador mei 16.09.26_Fulano');
  });

  test('placeholder fora da lista permitida é recusado (S5)', () => {
    assert.throws(() => renderizarDescricaoPix('{banco_codigo} - {nome}', { nome: 'Fulano', dataProducaoISO: '2026-09-16' }));
  });

  test('resultado sempre cortado em 140 caracteres', () => {
    const nomeLongo = 'A'.repeat(200);
    const r = renderizarDescricaoPix('{nome}', { nome: nomeLongo, dataProducaoISO: '2026-09-16' });
    assert.equal(r.length, 140);
  });
});

describe('formatarDataProducaoDDMMAA()', () => {
  test('AAAA-MM-DD vira DD.MM.AA', () => {
    assert.equal(formatarDataProducaoDDMMAA('2026-09-16'), '16.09.26');
  });
});

describe('nomeArquivoTransfeera() — Q-N19 (2.3.4)', () => {
  test('formato com lote de 6 dígitos com zero à esquerda', () => {
    assert.equal(nomeArquivoTransfeera('2026-09-16', 123), 'transfeera_adiantamentos_2026-09-16_lote-000123.xlsx');
  });

  test('número de lote acima de 6 dígitos não é truncado', () => {
    assert.equal(nomeArquivoTransfeera('2026-09-16', 1234567), 'transfeera_adiantamentos_2026-09-16_lote-1234567.xlsx');
  });
});

describe('2.3.6 — comparação estrutural com modelo_transfeera.xlsx (só se o arquivo existir)', () => {
  // NUNCA lê/loga a linha 3 em diante do modelo real (dado pessoal real).
  const MODELO = path.join(__dirname, '..', '..', '..', 'docs', 'documentos_apoio', 'modelo_transfeera.xlsx');
  const existe = fs.existsSync(MODELO);

  test('estrutura do modelo real bate com a fixture', { skip: !existe && 'modelo_transfeera.xlsx não presente localmente (nunca vai pro git)' }, () => {
    const wb = XLSX.readFile(MODELO);
    const nomeAba = wb.SheetNames[0];
    const ws = wb.Sheets[nomeAba];
    const merges = ws['!merges'] || [];
    const mescladaA1L1 = merges.find((m) => m.s.r === 0 && m.s.c === 0 && m.e.r === 0);
    const cabecalhos = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'].map((col) => String(ws[`${col}2`].v));

    assert.equal(nomeAba, fixture.aba);
    assert.equal(String(ws.A1.v), fixture.linha1Texto);
    assert.ok(mescladaA1L1, 'mesclagem A1:L1 ausente no modelo real');
    assert.equal(`${XLSX.utils.encode_cell(mescladaA1L1.s)}:${XLSX.utils.encode_cell(mescladaA1L1.e)}`, fixture.mesclagemLinha1);
    assert.deepEqual(cabecalhos, fixture.cabecalhos);
  });
});
