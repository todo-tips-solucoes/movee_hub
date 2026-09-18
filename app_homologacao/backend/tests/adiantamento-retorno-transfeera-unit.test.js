/**
 * Testes unitários — `lib/adiantamento-retorno-transfeera.js` (tasks.md
 * FASE 9, 9.1.6). CSV inteiramente SINTÉTICO (documentos/nomes fictícios) —
 * nenhuma linha do arquivo real do operador é copiada aqui (regra dura da
 * onda). Os 7 códigos de erro reais e suas mensagens vêm literalmente de
 * tasks.md §FASE 9 (texto público do parceiro Transfeera, não um dado da
 * empresa/pessoa real).
 *
 * Rodam com: node --test tests/adiantamento-retorno-transfeera-unit.test.js
 *
 * Ref: tasks.md §FASE 9 (contrato REAL observado no arquivo do operador,
 * dec-129); data-model.md AdiantamentoLoteItem.
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  RetornoTransfeeraParseError,
  CABECALHO_ESPERADO,
  lerCsv,
  extrairIdSolicitacao,
  casarComItensDoLote,
} = require('../lib/adiantamento-retorno-transfeera');

// --- fixture CSV sintética --------------------------------------------------

const COLUNA_PADRAO = {
  'ID da transferência': 'tr_sintetica_0000',
  'ID de integração': '',
  Status: 'Finalizada',
  Valor: '10.00',
  'Pago em': '17/09/2026 10:00:00',
  'Criado em': '16/09/2026 09:00:00',
  'Método de pagamento': 'pix',
  'Código Bancário': '001',
  'Nome do recebedor': 'Fulano de Tal Sintetico',
  'CPF/CNPJ do recebedor': '00000000000',
  'Tipo de chave Pix do recebedor': 'cpf',
  'Chave Pix': '00000000000',
  'Número da conta': '000012345',
  'Número da agência': '0001',
  'Tipo de conta': 'conta_corrente',
  'Código do banco': '001',
  'Nome do banco': 'Banco Sintetico',
  'ID do lote': 'lote_sintetico',
  'Nome do lote': 'lote sintetico',
  'Recibo bancário': '',
  'Recibo Transfeera': 'rec_sintetico',
  'Código de erro': '',
  'Motivo da falha': '',
};

function csvEscape(valor) {
  const str = String(valor);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function linhaCsv(overrides = {}) {
  const linha = { ...COLUNA_PADRAO, ...overrides };
  return CABECALHO_ESPERADO.map((col) => csvEscape(linha[col]));
}

function montarCsv(linhas) {
  const cabecalho = CABECALHO_ESPERADO.map(csvEscape).join(',');
  const corpo = linhas.map((l) => l.join(',')).join('\n');
  return `${cabecalho}\n${corpo}\n`;
}

// --- lerCsv ------------------------------------------------------------------

describe('lerCsv', () => {
  test('cabeçalho válido: normaliza as linhas', () => {
    const csv = montarCsv([
      linhaCsv({ 'ID de integração': 'ADV-001001', Status: 'Finalizada', Valor: '129.40' }),
    ]);
    const linhas = lerCsv(csv);
    assert.equal(linhas.length, 1);
    assert.equal(linhas[0].idIntegracao, 'ADV-001001');
    assert.equal(linhas[0].status, 'Finalizada');
    assert.equal(linhas[0].statusConhecido, true);
    assert.equal(linhas[0].valorCentavos, 12940);
  });

  test('preserva zeros à esquerda de código/agência/conta (raw:false, não converte para número)', () => {
    const csv = montarCsv([
      linhaCsv({
        'ID de integração': 'ADV-001001', 'Código do banco': '001', 'Número da agência': '0001',
      }),
    ]);
    // lerCsv não expõe essas colunas hoje (fora do contrato usado pelo
    // casamento), mas a leitura não pode lançar nem truncar o CSV.
    assert.doesNotThrow(() => lerCsv(csv));
  });

  test('CSV vazio -> RetornoTransfeeraParseError(ARQUIVO_VAZIO)', () => {
    assert.throws(() => lerCsv(''), (e) => e instanceof RetornoTransfeeraParseError && e.motivo === 'ARQUIVO_VAZIO');
  });

  test('cabeçalho fora do contrato -> RetornoTransfeeraParseError(CABECALHO_INVALIDO)', () => {
    const csv = 'a,b,c\n1,2,3\n';
    assert.throws(() => lerCsv(csv), (e) => e instanceof RetornoTransfeeraParseError && e.motivo === 'CABECALHO_INVALIDO');
  });
});

// --- extrairIdSolicitacao -----------------------------------------------------

describe('extrairIdSolicitacao', () => {
  test('ADV-000123 -> 123', () => {
    assert.equal(extrairIdSolicitacao('ADV-000123'), 123);
  });
  test('ADV-7000000 (>6 dígitos, sem lpad) -> 7000000', () => {
    assert.equal(extrairIdSolicitacao('ADV-7000000'), 7000000);
  });
  test('vazio -> null', () => {
    assert.equal(extrairIdSolicitacao(''), null);
  });
  test('texto livre -> null', () => {
    assert.equal(extrairIdSolicitacao('PAGAMENTO MANUAL JOAO DA SILVA'), null);
  });
  test('formato parecido mas inválido -> null', () => {
    assert.equal(extrairIdSolicitacao('ADV_001001'), null);
    assert.equal(extrairIdSolicitacao('adv-001001'), null);
  });
});

// --- casarComItensDoLote ------------------------------------------------------

const CODIGOS_REAIS = [
  ['DBA_20', 'Conta ou dígito verificador da conta inválido.'],
  ['DBA_30', 'Agência, conta ou dígito verificador da conta inválido.'],
  ['invalid_account_type_or_external_payment_not_allowed', 'Tipo de conta inválida e/ou que não permite receber transferências/pagamentos de terceiros.'],
  ['receiver_account_closed', 'Conta do recebedor não existe ou foi encerrada.'],
  ['receiver_institution_rejected_payment', 'Rejeitado pelo banco do recebedor.'],
  ['receiver_tax_id_divergent', 'CPF/CNPJ informado para pagamento diverge com o CPF/CNPJ do titular no Banco.'],
  ['transfer_failed_after_retries', 'Após algumas tentativas, não conseguimos enviar a transferência ao banco de destino.'],
];

describe('casarComItensDoLote — os 7 códigos de erro reais (motivo literal, sem tradução)', () => {
  for (const [codigo, mensagem] of CODIGOS_REAIS) {
    test(`Devolvida com ${codigo} -> motivo literal da coluna "Motivo da falha"`, () => {
      const itensLote = [{
        solicitacaoId: 2001, colIdIntegracao: 'ADV-002001', situacao: 'incluido', valorCentavos: 10000,
      }];
      const linhas = lerCsv(montarCsv([
        linhaCsv({
          'ID de integração': 'ADV-002001', Status: 'Devolvida', Valor: '100.00', 'Código de erro': codigo, 'Motivo da falha': mensagem,
        }),
      ]));
      const { aplicaveis, ignoradas, faltantes } = casarComItensDoLote(linhas, itensLote);
      assert.equal(ignoradas.length, 0);
      assert.equal(faltantes.length, 0);
      assert.deepEqual(aplicaveis, [{ solicitacaoId: 2001, status: 'Devolvida', motivo: mensagem }]);
    });
  }

  test('motivo cai para o Código de erro cru quando "Motivo da falha" vem vazia', () => {
    const itensLote = [{
      solicitacaoId: 2002, colIdIntegracao: 'ADV-002002', situacao: 'incluido', valorCentavos: 10000,
    }];
    const linhas = lerCsv(montarCsv([
      linhaCsv({
        'ID de integração': 'ADV-002002', Status: 'Devolvida', Valor: '100.00', 'Código de erro': 'DBA_20', 'Motivo da falha': '',
      }),
    ]));
    const { aplicaveis } = casarComItensDoLote(linhas, itensLote);
    assert.equal(aplicaveis[0].motivo, 'DBA_20');
  });
});

describe('casarComItensDoLote — casamento e motivos de ignorada', () => {
  const itensLote = [
    { // Finalizada casa
      solicitacaoId: 1001, colIdIntegracao: 'ADV-001001', situacao: 'incluido', valorCentavos: 12940,
    },
    { // já aplicado (reimportação)
      solicitacaoId: 1003, colIdIntegracao: 'ADV-001003', situacao: 'pago', valorCentavos: 3000,
    },
    { // status desconhecido
      solicitacaoId: 1005, colIdIntegracao: 'ADV-001005', situacao: 'incluido', valorCentavos: 8000,
    },
    { // valor divergente
      solicitacaoId: 1006, colIdIntegracao: 'ADV-001006', situacao: 'incluido', valorCentavos: 9999,
    },
    { // faltante — nenhuma linha do CSV casa com este item
      solicitacaoId: 1004, colIdIntegracao: 'ADV-001004', situacao: 'incluido', valorCentavos: 7000,
    },
  ];

  const csv = montarCsv([
    linhaCsv({ 'ID de integração': 'ADV-001001', Status: 'Finalizada', Valor: '129.40' }),
    linhaCsv({ 'ID de integração': 'ADV-001003', Status: 'Finalizada', Valor: '30.00' }), // já aplicado
    linhaCsv({ 'ID de integração': 'ADV-999999', Status: 'Finalizada', Valor: '10.00' }), // não pertence ao lote
    linhaCsv({ 'ID de integração': '', Status: 'Finalizada', Valor: '10.00' }), // vazio
    linhaCsv({ 'ID de integração': 'PAGAMENTO MANUAL JOAO DA SILVA', Status: 'Finalizada', Valor: '10.00' }), // texto livre
    linhaCsv({ 'ID de integração': 'ADV-001005', Status: 'Processando', Valor: '80.00' }), // status desconhecido
    linhaCsv({ 'ID de integração': 'ADV-001006', Status: 'Finalizada', Valor: '50.00' }), // valor divergente (item=99.99)
  ]);

  const linhas = lerCsv(csv);
  const { aplicaveis, ignoradas, faltantes } = casarComItensDoLote(linhas, itensLote);

  test('linha sem par -> ignorada com o motivo (vazia, texto livre, id desconhecido)', () => {
    assert.deepEqual(
      ignoradas.filter((i) => ['NAO_PERTENCE_AO_LOTE', 'ID_INTEGRACAO_INVALIDO'].includes(i.motivo)).map((i) => i.motivo).sort(),
      ['ID_INTEGRACAO_INVALIDO', 'ID_INTEGRACAO_INVALIDO', 'NAO_PERTENCE_AO_LOTE'],
    );
  });

  test('reimportação (item já fora de "incluido") -> ignorada JA_APLICADO, nunca reaplicada', () => {
    const ig = ignoradas.find((i) => i.idIntegracao === 'ADV-001003');
    assert.ok(ig);
    assert.equal(ig.motivo, 'JA_APLICADO');
    assert.ok(!aplicaveis.some((a) => a.solicitacaoId === 1003));
  });

  test('situação desconhecida -> ignorada, nunca adivinhada', () => {
    const ig = ignoradas.find((i) => i.idIntegracao === 'ADV-001005');
    assert.equal(ig.motivo, 'STATUS_DESCONHECIDO:Processando');
    assert.ok(!aplicaveis.some((a) => a.solicitacaoId === 1005));
  });

  test('valor divergente do lote -> ignorada, nunca casada por valor', () => {
    const ig = ignoradas.find((i) => i.idIntegracao === 'ADV-001006');
    assert.equal(ig.motivo, 'VALOR_DIVERGENTE');
    assert.ok(!aplicaveis.some((a) => a.solicitacaoId === 1006));
  });

  test('itens "incluido" sem status resolvido (sem linha, status desconhecido ou valor divergente) -> faltantes (nunca aplicados por omissão)', () => {
    // 1004: nenhuma linha no CSV. 1005/1006: têm linha, mas foram ignoradas
    // (status desconhecido / valor divergente) — continuam sem resolução,
    // então também bloqueiam a aplicação plena do lote (nunca "pago" por omissão).
    assert.deepEqual([...faltantes].sort((a, b) => a - b), [1004, 1005, 1006]);
  });

  test('Finalizada casada por id -> aplicável, sem motivo', () => {
    const ap = aplicaveis.find((a) => a.solicitacaoId === 1001);
    assert.ok(ap);
    assert.equal(ap.status, 'Finalizada');
    assert.equal(ap.motivo, null);
  });

  test('reimportar o mesmo arquivo depois de aplicado: tudo vira JA_APLICADO, nada some/duplica', () => {
    const itensJaAplicados = itensLote.map((it) => (
      it.solicitacaoId === 1001 ? { ...it, situacao: 'pago' } : it
    ));
    const segunda = casarComItensDoLote(lerCsv(csv), itensJaAplicados);
    assert.ok(!segunda.aplicaveis.some((a) => a.solicitacaoId === 1001));
    assert.ok(segunda.ignoradas.some((i) => i.idIntegracao === 'ADV-001001' && i.motivo === 'JA_APLICADO'));
  });
});

// --- linha duplicada (revisão PR #182) ----------------------------------------
// `casarComItensDoLote` comparava `item.situacao` contra um snapshot em
// memória que NÃO muda dentro do laço: duas linhas do mesmo `ADV-<id>`
// entravam ambas em `aplicaveis` (nenhuma virava JA_APLICADO). Como a RPC
// aplica as falhas antes de marcar "o que sobrou" como pago, a `Devolvida`
// vencia a `Finalizada` em qualquer ordem — adiantamento já pago ficava
// FALHOU em silêncio.
describe('casarComItensDoLote — duplicatas do mesmo ID de integração', () => {
  const itensLote = [
    { solicitacaoId: 2001, colIdIntegracao: 'ADV-002001', situacao: 'incluido', valorCentavos: 12940 },
  ];

  test('duplicata com status conflitante -> recusa o arquivo (LINHA_DUPLICADA), nunca escolhe uma das linhas', () => {
    const csv = montarCsv([
      linhaCsv({ 'ID de integração': 'ADV-002001', Status: 'Finalizada', Valor: '129.40' }),
      linhaCsv({
        'ID de integração': 'ADV-002001', Status: 'Devolvida', Valor: '129.40',
        'Código de erro': 'receiver_account_closed', 'Motivo da falha': 'Conta do recebedor não existe ou foi encerrada.',
      }),
    ]);
    assert.throws(
      () => casarComItensDoLote(lerCsv(csv), itensLote),
      (e) => e instanceof RetornoTransfeeraParseError && e.motivo === 'LINHA_DUPLICADA',
    );
  });

  test('duplicata com mesmo status mas motivo diferente também é conflito', () => {
    const csv = montarCsv([
      linhaCsv({
        'ID de integração': 'ADV-002001', Status: 'Devolvida', Valor: '129.40',
        'Código de erro': 'receiver_account_closed', 'Motivo da falha': 'Conta do recebedor não existe ou foi encerrada.',
      }),
      linhaCsv({
        'ID de integração': 'ADV-002001', Status: 'Devolvida', Valor: '129.40',
        'Código de erro': 'invalid_account', 'Motivo da falha': 'Conta inválida.',
      }),
    ]);
    assert.throws(
      () => casarComItensDoLote(lerCsv(csv), itensLote),
      (e) => e instanceof RetornoTransfeeraParseError && e.motivo === 'LINHA_DUPLICADA',
    );
  });

  test('duplicata idêntica (ruído do arquivo) -> deduplicada, 1 aplicável e nenhum faltante', () => {
    const linha = { 'ID de integração': 'ADV-002001', Status: 'Finalizada', Valor: '129.40' };
    const csv = montarCsv([linhaCsv(linha), linhaCsv(linha)]);
    const { aplicaveis, ignoradas, faltantes } = casarComItensDoLote(lerCsv(csv), itensLote);
    assert.equal(aplicaveis.length, 1);
    assert.equal(aplicaveis[0].solicitacaoId, 2001);
    assert.deepEqual(ignoradas, []);
    assert.deepEqual(faltantes, []);
  });

  test('várias linhas sem id no padrão ADV-<id> não são tratadas como duplicata', () => {
    const csv = montarCsv([
      linhaCsv({ 'ID de integração': '', Status: 'Finalizada', Valor: '10.00' }),
      linhaCsv({ 'ID de integração': '', Status: 'Devolvida', Valor: '20.00' }),
      linhaCsv({ 'ID de integração': 'ADV-002001', Status: 'Finalizada', Valor: '129.40' }),
    ]);
    const { aplicaveis, ignoradas } = casarComItensDoLote(lerCsv(csv), itensLote);
    assert.equal(aplicaveis.length, 1);
    assert.deepEqual(ignoradas.map((i) => i.motivo), ['ID_INTEGRACAO_INVALIDO', 'ID_INTEGRACAO_INVALIDO']);
  });
});
