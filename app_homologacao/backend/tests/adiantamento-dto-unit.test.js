/**
 * Testes unitários — lib/adiantamento-dto.js (tasks.md 2.5).
 * Rodam com: node --test tests/adiantamento-dto-unit.test.js
 *
 * Ref: Spec §FR-010, §FR-025; contracts/hub-api.md, contracts/motorista-api.md;
 * data-model.md. Roundtrip (2.5.3): os `*-api.ts` de `frontend_v2`/
 * `frontend_motorista` ainda não existem (FASE 6.1/7.1 não rodaram — tasks.md
 * confirma `lib/adiantamento-api.ts` e `lib/hub/adiantamentos-api.ts` como
 * tarefas futuras); o roundtrip aqui casa cada payload mapeado contra os
 * shapes literais documentados em contracts/*.md (fonte de verdade atual).
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  REGEX_DINHEIRO,
  dinheiro,
  formatarSequencial,
  formatarBancoCodigoNome,
  formatarContaResumo,
  pontuarDocumentoMascarado,
  mapConfiguracao,
  mapContaMascarada,
  mapContaCompleta,
  mapSolicitacaoResumo,
  mapSolicitacaoDetalhe,
  mapLote,
  mapLoteItem,
  mapLinhaPrevia,
} = require('../lib/adiantamento-dto');

describe('dinheiro() — string decimal de 2 casas (2.5.2, FR-010)', () => {
  test('number e string numérica formatam igual', () => {
    assert.equal(dinheiro(129.4), '129.40');
    assert.equal(dinheiro('129.40'), '129.40');
    assert.equal(dinheiro(0), '0.00');
    assert.equal(dinheiro(-150), '-150.00');
  });

  test('null/undefined preservam ausência (não viram "0.00")', () => {
    assert.equal(dinheiro(null), null);
    assert.equal(dinheiro(undefined), null);
  });

  test('caso que falha com float ingênuo (0.10 + 0.20 já resolvido em adiantamento-remanescente) permanece exato aqui', () => {
    assert.equal(dinheiro(0.1 + 0.2), '0.30');
    assert.equal(dinheiro(2.675), '2.68'); // meio para cima, FR-010
  });

  test('todo valor emitido casa com REGEX_DINHEIRO do contrato (^-?\\d+\\.\\d{2}$)', () => {
    for (const v of [0, 1, -1, 129.4, 2.675, '0.07', -0.5]) {
      assert.match(dinheiro(v), REGEX_DINHEIRO);
    }
  });
});

describe('formatarSequencial() — ADV-NNNNNN (sql-rpc.md hub_adiantamento_integration_id)', () => {
  test('lpad a 6 dígitos abaixo de 1.000.000', () => {
    assert.equal(formatarSequencial(123, 'ADV-'), 'ADV-000123');
    assert.equal(formatarSequencial(1, 'ADV-'), 'ADV-000001');
  });

  test('sem prefixo (numero do lote)', () => {
    assert.equal(formatarSequencial(121), '000121');
  });

  test('id >= 1.000.000 sai cru (lpad trunca, mesma regra do SQL)', () => {
    assert.equal(formatarSequencial(1000000, 'ADV-'), 'ADV-1000000');
  });
});

describe('formatarBancoCodigoNome() / formatarContaResumo() — formato sourced de motorista-api.md bankAccount', () => {
  test('"<código> – <nome>"', () => {
    assert.equal(formatarBancoCodigoNome('260', 'Nu Pagamentos'), '260 – Nu Pagamentos');
  });

  test('"Ag. 0001 · CC ••••4521-7"', () => {
    const resumo = formatarContaResumo({ agencia: '0001', tipoConta: 'CORRENTE', conta: '00012345', contaDigito: '7' });
    assert.equal(resumo, 'Ag. 0001 · CC ••••2345-7');
  });
});

describe('pontuarDocumentoMascarado() — 3.2/dec-074: só pontua o que o SQL já mascarou (2 visíveis)', () => {
  test('CPF (11 chars mascarados) -> ***.***.***-NN', () => {
    assert.equal(pontuarDocumentoMascarado('*********09'), '***.***.***-09');
  });

  test('CNPJ (14 chars mascarados) -> **.***.***/****-NN', () => {
    assert.equal(pontuarDocumentoMascarado('************90'), '**.***.***/****-90');
  });

  test('tamanho inesperado -> devolve como veio (nunca lança)', () => {
    assert.equal(pontuarDocumentoMascarado('***'), '***');
  });

  test('não-string -> null (nunca lança)', () => {
    assert.equal(pontuarDocumentoMascarado(null), null);
    assert.equal(pontuarDocumentoMascarado(undefined), null);
  });
});

describe('mapConfiguracao() — Configuracao (hub-api.md §Configuração, FR-025 completa)', () => {
  const ROW_COMPLETA = {
    versao: 3,
    vigente_desde: '2026-09-01T00:00:00Z',
    timezone: 'America/Sao_Paulo',
    dias_habilitados: [1, 2, 3, 4, 5, 6],
    horario_abertura: '09:00:00',
    horario_corte: '15:00:00',
    percentual: '60.00',
    taxa_fixa: '0.35',
    fonte_producao: 'financeiro_lancamento',
    categorias_producao: ['Entrega'],
    previsao_pagamento_texto: 'entre 17h e 18h de hoje',
    descricao_pix_modelo: 'Antecipação entregador mei {data_producao:DD.MM.AA}_{nome}',
    apuracao_dia_inicio: 4,
    apuracao_dias_ate_repasse: 0,
    apuracao_data_base: 'data_lancamento',
    categorias_extrato: ['Repasse'],
    desconto_adiantamentos: true,
    desconto_debitos: false,
    repasse_visivel_app: false,
  };

  test('roundtrip: campos camelCase batem 1:1 com contracts/hub-api.md §Configuração', () => {
    const dto = mapConfiguracao(ROW_COMPLETA);
    assert.deepEqual(Object.keys(dto).sort(), [
      'apuracaoDataBase',
      'apuracaoDiaInicio',
      'apuracaoDiasAteRepasse',
      'categoriasExtrato',
      'categoriasProducao',
      'completa',
      'descontoAdiantamentos',
      'descontoDebitos',
      'descricaoPixModelo',
      'diasHabilitados',
      'fonteProducao',
      'horarioAbertura',
      'horarioCorte',
      'percentual',
      'previsaoPagamentoTexto',
      'repasseVisivelApp',
      'taxaFixa',
      'timezone',
      'versao',
      'vigenteDesde',
    ]);
    assert.equal(dto.horarioAbertura, '09:00');
    assert.equal(dto.horarioCorte, '15:00');
    assert.equal(dto.percentual, 60); // number, não string — motorista-api.md `percentage: number`
    assert.equal(dto.taxaFixa, '0.35'); // string — motorista-api.md `fee: string`
    assert.match(dto.taxaFixa, REGEX_DINHEIRO);
    assert.equal(dto.completa, true);
  });

  test('fonte financeira sem categorias => incompleta', () => {
    const dto = mapConfiguracao({ ...ROW_COMPLETA, categorias_producao: [] });
    assert.equal(dto.completa, false);
  });

  test('fonte não-financeira (performance_taxas) não exige categorias', () => {
    const dto = mapConfiguracao({ ...ROW_COMPLETA, fonte_producao: 'performance_taxas', categorias_producao: null });
    assert.equal(dto.completa, true);
  });

  test('sem fonte_producao => incompleta (NOT_CONFIGURED)', () => {
    const dto = mapConfiguracao({ ...ROW_COMPLETA, fonte_producao: null });
    assert.equal(dto.completa, false);
  });

  test('apuração incompleta (falta apuracao_data_base) => incompleta', () => {
    const dto = mapConfiguracao({ ...ROW_COMPLETA, apuracao_data_base: null });
    assert.equal(dto.completa, false);
  });
});

describe('mapContaMascarada() / mapContaCompleta() — hub-api.md §Contas bancárias', () => {
  const ROW = {
    id: 42,
    status: 'APROVADA',
    origem: 'APP',
    banco_codigo: '260',
    banco_nome: 'Nu Pagamentos',
    agencia: '0001',
    conta: '00012345',
    conta_digito: '7',
    tipo_conta: 'CORRENTE',
    titular_nome: 'Fulano de Tal',
    titular_documento: '12345678941',
    chave_pix_tipo: 'CPF',
    chave_pix: '12345678941',
    email_comprovante: 'fulano@example.com',
    alertas: [],
    solicitada_em: '2026-09-10T12:00:00Z',
    revisada_em: null,
    entregador_id: 7,
    entregador_nome: 'Fulano de Tal',
  };

  test('ContaMascarada: documento e conta mascarados, campos exatos do contrato', () => {
    const dto = mapContaMascarada(ROW);
    assert.deepEqual(Object.keys(dto).sort(), [
      'agencia',
      'alertas',
      'banco',
      'contaMascarada',
      'documentoMascarado',
      'id',
      'motivoRejeicao',
      'origem',
      'revisadaEm',
      'solicitadaEm',
      'status',
      'tipoConta',
      'titularNome',
    ]);
    assert.equal(dto.contaMascarada, '••••2345-7');
    assert.equal(dto.documentoMascarado, '***.***.***-41');
    assert.equal(dto.banco, 'Nu Pagamentos');
  });

  test('ContaCompleta acrescenta titularDocumento, conta, contaDigito, chavePixTipo, chavePix, emailComprovante (sem máscara)', () => {
    const dto = mapContaCompleta(ROW);
    assert.equal(dto.titularDocumento, '12345678941');
    assert.equal(dto.conta, '00012345');
    assert.equal(dto.contaDigito, '7');
    assert.equal(dto.chavePixTipo, 'CPF');
    assert.equal(dto.chavePix, '12345678941');
    assert.equal(dto.emailComprovante, 'fulano@example.com');
    // ainda contém os campos mascarados da base (não substitui)
    assert.equal(dto.contaMascarada, '••••2345-7');
  });

  test('7.5.2/FR-018: ContaCompleta acrescenta entregadorVinculado {entregadorId, nome}', () => {
    const dto = mapContaCompleta(ROW);
    assert.deepEqual(dto.entregadorVinculado, { entregadorId: 7, nome: 'Fulano de Tal' });
  });
});

describe('mapSolicitacaoResumo() / mapSolicitacaoDetalhe() — hub-api.md §Solicitações', () => {
  const ROW_BASE = {
    id: 123,
    entregador_id: 7,
    entregador: { id: 7, nome: 'Joana Ribeiro' },
    data_solicitacao: '2026-09-17',
    data_producao: '2026-09-16',
    status: 'AGUARDANDO_CORTE',
    motivo_status: null,
    valor_liquido: 129.05,
    lote_id: null,
  };

  test('SolicitacaoResumo: integrationId cai para formatarSequencial quando ausente', () => {
    const dto = mapSolicitacaoResumo(ROW_BASE);
    assert.equal(dto.integrationId, 'ADV-000123');
    assert.equal(dto.motorista.entregadorId, 7);
    assert.equal(dto.motorista.nome, 'Joana Ribeiro');
    assert.equal(dto.valorLiquido, '129.05');
    assert.match(dto.valorLiquido, REGEX_DINHEIRO);
    assert.deepEqual(dto.pendencias, []);
  });

  test('SolicitacaoResumo: usa integration_id pré-computado quando presente', () => {
    const dto = mapSolicitacaoResumo({ ...ROW_BASE, integration_id: 'ADV-000123' });
    assert.equal(dto.integrationId, 'ADV-000123');
  });

  test('SolicitacaoDetalhe: calculo + contaMascarada + eventos + lotes', () => {
    const dto = mapSolicitacaoDetalhe({
      ...ROW_BASE,
      fonte_producao: 'financeiro_lancamento',
      categorias_producao: ['Entrega'],
      producao_valor: 215.67,
      producao_por_categoria: { Entrega: '215.67' },
      percentual: '60.00',
      valor_bruto: 129.4,
      taxa: 0.35,
      calculado_em: '2026-09-17T10:24:00Z',
      versao_configuracao: 3,
      conta_bancaria: {
        id: 42,
        status: 'APROVADA',
        origem: 'APP',
        banco_nome: 'Nu Pagamentos',
        agencia: '0001',
        conta: '00012345',
        conta_digito: '7',
        tipo_conta: 'CORRENTE',
        titular_nome: 'Joana Ribeiro',
        titular_documento: '12345678941',
        alertas: [],
        solicitada_em: '2026-09-01T00:00:00Z',
        revisada_em: null,
      },
      eventos: [{ status_de: null, status_para: 'AGUARDANDO_CORTE', ocorrido_em: '2026-09-17T10:24:00Z', ator_tipo: 'motorista', ator_usuario_id: null, motivo: null }],
      lotes: [],
    });
    assert.equal(dto.calculo.producao, '215.67');
    assert.equal(dto.calculo.bruto, '129.40');
    assert.equal(dto.calculo.taxa, '0.35');
    assert.equal(dto.calculo.liquido, '129.05');
    assert.equal(dto.calculo.percentual, 60);
    assert.equal(dto.calculo.versaoConfiguracao, 3);
    assert.equal(dto.contaMascarada.contaMascarada, '••••2345-7');
    assert.equal(dto.eventos.length, 1);
    assert.equal(dto.eventos[0].statusPara, 'AGUARDANDO_CORTE');
    assert.deepEqual(dto.lotes, []);
    for (const v of [dto.calculo.producao, dto.calculo.bruto, dto.calculo.taxa, dto.calculo.liquido, dto.valorLiquido]) {
      assert.match(v, REGEX_DINHEIRO);
    }
  });
});

describe('mapLote() / mapLoteItem() — hub-api.md §Pagamentos e lotes', () => {
  test('Lote: numero cai para formatarSequencial sem prefixo', () => {
    const dto = mapLote({
      id: 121,
      status: 'GERADO',
      criado_por: 9,
      criado_em: '2026-09-17T08:00:00Z',
      quantidade: 2,
      valor_total: 258.8,
      arquivo_nome: 'transfeera_adiantamentos_2026-09-17_lote-000121.xlsx',
      arquivo_sha256: 'a'.repeat(64),
      downloads: 0,
      primeiro_download_em: null,
      cancelado_em: null,
      cancelado_motivo: null,
      concluido_em: null,
    });
    assert.equal(dto.numero, '000121');
    assert.equal(dto.valorTotal, '258.80');
    assert.match(dto.valorTotal, REGEX_DINHEIRO);
    assert.equal(dto.criadoPor, 9); // sem embed de nome, passa o id cru
  });

  test('Lote: criadoPor vira {id, nome} quando a rota já embutiu o nome', () => {
    const dto = mapLote({ id: 121, criado_por: 9, criado_por_nome: 'Financeiro X', valor_total: 0, quantidade: 0 });
    assert.deepEqual(dto.criadoPor, { id: 9, nome: 'Financeiro X' });
  });

  // FASE 11 (converge onda-037, 11.7/11.14, migration 0074): col_documento
  // deixou de vir PRÉ-mascarado do SQL — hoje é o documento FORMATADO (exigido
  // pelo arquivo Transfeera, contracts/transfeera-xlsx.md coluna B). mapLoteItem
  // passou a aplicar a máscara de verdade nesta borda (documentoMascarado(),
  // lib/adiantamento-conta.js) — já não é passthrough.
  test('LoteItem: documento FORMATADO vindo do SQL é mascarado na leitura, conta idem', () => {
    const dto = mapLoteItem({
      id: 1,
      col_nome: 'Joana Ribeiro',
      col_documento: '123.456.789-41',
      col_banco: '260',
      col_agencia: '0001',
      col_conta: '00012345',
      col_digito: '7',
      col_tipo_conta: 'Conta Corrente',
      valor: 129.05,
      col_id_integracao: 'ADV-000123',
      col_descricao_pix: 'Antecipação entregador mei 16.09.26_Joana Ribeiro',
      situacao: 'incluido',
      situacao_motivo: null,
      situacao_em: null,
    });
    assert.equal(dto.documentoMascarado, '***.***.***-41');
    assert.equal(dto.contaMascarada, '••••2345-7');
    assert.equal(dto.valor, '129.05');
    assert.match(dto.valor, REGEX_DINHEIRO);
  });
});

describe('mapLinhaPrevia() — hub-api.md §Pagamentos e lotes (POST /lotes/previa)', () => {
  test('id, integrationId, motorista, valor, bancoAgenciaContaMascarados', () => {
    const dto = mapLinhaPrevia({
      id: 123,
      entregador: { nome: 'Joana Ribeiro' },
      valor_liquido: 129.05,
      agencia: '0001',
      tipo_conta: 'CORRENTE',
      conta: '00012345',
      conta_digito: '7',
    });
    assert.deepEqual(Object.keys(dto).sort(), ['bancoAgenciaContaMascarados', 'id', 'integrationId', 'motorista', 'valor']);
    assert.equal(dto.integrationId, 'ADV-000123');
    assert.equal(dto.motorista, 'Joana Ribeiro');
    assert.equal(dto.valor, '129.05');
    assert.match(dto.valor, REGEX_DINHEIRO);
    assert.equal(dto.bancoAgenciaContaMascarados, 'Ag. 0001 · CC ••••2345-7');
  });
});
