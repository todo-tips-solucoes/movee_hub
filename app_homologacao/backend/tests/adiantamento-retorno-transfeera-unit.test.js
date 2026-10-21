/**
 * Testes unitários — `lib/adiantamento-retorno-transfeera.js` (tasks.md
 * FASE 9, 9.1.6; retorno-transfeera-xlsx FASE 1). XLSX montado em memória e
 * inteiramente SINTÉTICO (documentos/nomes fictícios) — nenhuma linha do
 * arquivo real do operador é copiada aqui. O contrato do cabeçalho é lido da
 * fixture anonimizada `fixtures/retorno-transfeera-21col-exemplo.xlsx`. As
 * mensagens de erro vêm de tasks.md §FASE 9 (texto público do parceiro).
 *
 * Rodam com: node --test tests/adiantamento-retorno-transfeera-unit.test.js
 *
 * Ref: tasks.md §FASE 9 (contrato REAL observado no arquivo do operador,
 * dec-129); data-model.md AdiantamentoLoteItem.
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const XLSX = require('xlsx');

const {
  RetornoTransfeeraParseError,
  CABECALHO_ESPERADO,
  STATUS_CONHECIDOS,
  XLSX_MIME,
  lerXlsx,
  extrairIdSolicitacao,
  casarComItensDoLote,
} = require('../lib/adiantamento-retorno-transfeera');
const { paraCentavos } = require('../lib/adiantamento-remanescente');

// --- fixture XLSX sintética --------------------------------------------------
// Helpers só de teste: o servidor NUNCA escreve XLSX de retorno (quem gera o
// retorno é a Transfeera). Nenhuma linha do arquivo real do operador é copiada.

const FIXTURE = path.join(__dirname, 'fixtures', 'retorno-transfeera-21col-exemplo.xlsx');

const COLUNA_PADRAO = {
  Valor: '10,00',
  Favorecido: 'FULANO SINTETICO',
  'Comprovante Transfeera': 'COMPROV000000',
  'Comprovante Banco': '',
  Status: 'FINALIZADO',
  'ID integração': '',
  Motivo: '',
  'CPF ou CNPJ': '00000000000',
  Email: '',
  Banco: '001',
  Agência: '0001',
  Conta: '12345',
  'Dígito da conta': '0',
  'Tipo de Conta (Corrente ou Poupança)': 'Conta Corrente',
  'Nome do lote': 'lote sintetico',
  'Data transferido': '20/10/2026 10:00:00',
  'Banco de saída': '',
  'Data de agendamento': '',
  'Tentativas de pagamento': '1',
  'Tipo da chave PIX': '',
  'Chave PIX': '',
};

/** Linha sintética como array posicional (ordem do contrato). */
function linhaXlsx(overrides = {}) {
  const linha = { ...COLUNA_PADRAO, ...overrides };
  return CABECALHO_ESPERADO.map((col) => linha[col]);
}

/** Monta um XLSX em memória a partir de um array de arrays (primeira aba). */
function xlsxDeAoa(aoa, extrasAbas = {}) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Transferências');
  for (const [nome, dados] of Object.entries(extrasAbas)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dados), nome);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** `linhas`: arrays posicionais (use `linhaXlsx`). Cabeçalho = contrato. */
function montarXlsx(linhas) {
  return xlsxDeAoa([CABECALHO_ESPERADO, ...linhas]);
}

// --- ZIP sintético (só para os tetos/recusas de formato) -----------------------
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }

/** ZIP mínimo e bem-formado. `entradas`: [{nome, dados: Buffer}]; deflate real,
 * CRC zerado (o leitor só confere o diretório central antes do teto). */
function montarZip(entradas, { eocd = {}, descomprimidoDeclarado } = {}) {
  const locais = []; const centrais = []; let offset = 0;
  for (const [i, e] of entradas.entries()) {
    const nome = Buffer.from(e.nome);
    const comp = zlib.deflateRawSync(e.dados);
    const declarado = descomprimidoDeclarado !== undefined && i === 0 ? descomprimidoDeclarado : e.dados.length;
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0), u32(0), u32(comp.length), u32(declarado),
      u16(nome.length), u16(0), nome, comp,
    ]);
    centrais.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0), u32(0), u32(comp.length), u32(declarado),
      u16(nome.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nome,
    ]));
    locais.push(local);
    offset += local.length;
  }
  const dirCentral = Buffer.concat(centrais);
  const fim = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0),
    u16(eocd.entradas ?? entradas.length), u16(eocd.entradas ?? entradas.length),
    u32(eocd.tamanhoDir ?? dirCentral.length), u32(eocd.offsetDir ?? offset), u16(0),
  ]);
  return Buffer.concat([...locais, dirCentral, fim]);
}

const erroParse = (motivo) => (e) => e instanceof RetornoTransfeeraParseError && e.motivo === motivo;

// --- paraCentavos: caracterização (FR-008, plan D5) ---------------------------
// Tabela CONGELADA do comportamento anterior à mudança do milhar BR. Tem de
// passar antes E depois: prova que o ramo novo não altera nenhuma entrada que
// já tinha resposta.
describe('paraCentavos — caracterização do comportamento existente', () => {
  const CONGELADA = [
    ['10', 1000], ['0', 0], ['-5', -500], ['54,57', 5457], ['54.57', 5457],
    ['1.005', 101], ['8.165', 817], ['2.675', 268], ['1e3', 100000],
    [54.57, 5457], [0, 0], [100, 10000], [-0.5, -50], ['  54,57  ', 5457],
    ['-54,57', -5457], ['1.234', 123], ['12345,67', 1234567], ['.5', 50], ['', 0],
  ];
  for (const [entrada, esperado] of CONGELADA) {
    test(`paraCentavos(${JSON.stringify(entrada)}) === ${esperado}`, () => {
      assert.equal(paraCentavos(entrada), esperado);
    });
  }
});

describe('paraCentavos — milhar brasileiro (FR-008)', () => {
  test('1.234,56 / -1.234,56 / 12.345.678,9 viram centavos', () => {
    assert.equal(paraCentavos('1.234,56'), 123456);
    assert.equal(paraCentavos('-1.234,56'), -123456);
    assert.equal(paraCentavos('12.345.678,9'), 1234567890);
  });
  test('o que não é milhar BR bem formado continua NaN', () => {
    for (const v of ['abc', '1.2.3,4', 'R$ 1.234,56', '1.23,45']) {
      assert.ok(Number.isNaN(paraCentavos(v)), `${v} deveria ser NaN`);
    }
  });
  test('1.234 (só ponto) continua decimal: 123 centavos', () => {
    assert.equal(paraCentavos('1.234'), 123);
  });
});

// --- cabeçalho: contrato lido da fixture (nunca de um literal nosso) ----------

describe('lerXlsx — cabeçalho', () => {
  test('CABECALHO_ESPERADO é exatamente o cabeçalho da fixture (21 colunas)', () => {
    const wb = XLSX.readFile(FIXTURE);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const cab = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' })[0];
    assert.equal(cab.length, 21);
    assert.deepEqual(CABECALHO_ESPERADO, cab);
    assert.ok(CABECALHO_ESPERADO.includes('Tipo de Conta (Corrente ou Poupança)'));
  });

  const base = linhaXlsx({ 'ID integração': 'ADV-000001' });
  const casos = {
    'coluna ausente': [CABECALHO_ESPERADO.slice(0, 20), base.slice(0, 20)],
    'coluna extra': [[...CABECALHO_ESPERADO, 'Extra'], [...base, 'x']],
    'colunas fora de ordem': [[CABECALHO_ESPERADO[1], CABECALHO_ESPERADO[0], ...CABECALHO_ESPERADO.slice(2)], base],
    'coluna renomeada': [CABECALHO_ESPERADO.map((c) => (c === 'Motivo' ? 'Motivo da falha' : c)), base],
  };
  for (const [nome, [cab, linha]] of Object.entries(casos)) {
    test(`${nome} -> CABECALHO_INVALIDO`, () => {
      assert.throws(() => lerXlsx(xlsxDeAoa([cab, linha])), erroParse('CABECALHO_INVALIDO'));
    });
  }

  test('cabeçalho inválido é recusado ANTES de interpretar qualquer linha', () => {
    // Linhas com Valor ilegível: se o cabeçalho fosse conferido depois, não
    // sairia CABECALHO_INVALIDO.
    assert.throws(() => lerXlsx(xlsxDeAoa([['Coluna Errada', 'Outra'], ['abc', 'def']])), erroParse('CABECALHO_INVALIDO'));
  });
});

// --- formato (magic + ZIP) ----------------------------------------------------

describe('lerXlsx — formato do arquivo', () => {
  const FORMATO = erroParse('FORMATO_INVALIDO');

  test('buffer vazio / não-Buffer -> FORMATO_INVALIDO', () => {
    assert.throws(() => lerXlsx(Buffer.alloc(0)), FORMATO);
    assert.throws(() => lerXlsx('PK\x03\x04'), FORMATO);
    assert.throws(() => lerXlsx(undefined), FORMATO);
  });
  test('binário qualquer, texto, CSV e HTML -> FORMATO_INVALIDO (nunca farejados pelo SheetJS)', () => {
    assert.throws(() => lerXlsx(Buffer.from([0x00, 0xff, 0xfe, 0x10, 0x80])), FORMATO);
    assert.throws(() => lerXlsx(Buffer.from('texto qualquer renomeado para .xlsx')), FORMATO);
    assert.throws(() => lerXlsx(Buffer.from(`${CABECALHO_ESPERADO.join(',')}\n`)), FORMATO);
    assert.throws(() => lerXlsx(Buffer.from('<html><body><table><tr><td>1</td></tr></table></body></html>')), FORMATO);
  });
  test('ZIP corrompido (magic ok, sem diretório central) e XLSX truncado -> FORMATO_INVALIDO', () => {
    assert.throws(() => lerXlsx(Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(200, 7)])), FORMATO);
    const bom = montarXlsx([linhaXlsx({ 'ID integração': 'ADV-000001' })]);
    assert.throws(() => lerXlsx(bom.subarray(0, bom.length - 40)), FORMATO);
  });
  test('ZIP válido que não é planilha -> FORMATO_INVALIDO', () => {
    const zip = montarZip([{ nome: 'a.txt', dados: Buffer.from('oi') }]);
    assert.throws(() => lerXlsx(zip), FORMATO);
  });
  test('ZIP64 (campos 0xFFFFFFFF) -> FORMATO_INVALIDO', () => {
    const zip = montarZip([{ nome: 'a.txt', dados: Buffer.from('oi') }], { eocd: { offsetDir: 0xffffffff } });
    assert.throws(() => lerXlsx(zip), FORMATO);
  });
  test('pasta de trabalho sem nenhuma aba -> FORMATO_INVALIDO', () => {
    const zip = montarZip([
      { nome: '[Content_Types].xml', dados: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>') },
      { nome: '_rels/.rels', dados: Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
      { nome: 'xl/workbook.xml', dados: Buffer.from('<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/></workbook>') },
    ]);
    assert.throws(() => lerXlsx(zip), FORMATO);
  });
  test('só o cabeçalho (nenhuma linha de dados) -> ARQUIVO_VAZIO', () => {
    assert.throws(() => lerXlsx(montarXlsx([])), erroParse('ARQUIVO_VAZIO'));
  });
  test('XLSX_MIME é o mime OOXML de planilha', () => {
    assert.equal(XLSX_MIME, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });
});

// --- tetos (descompressão e linhas) --------------------------------------------

describe('lerXlsx — tetos', () => {
  test('bomba de descompressão: ZIP pequeno que declara > 32 MiB descomprimidos -> ARQUIVO_MUITO_GRANDE', () => {
    const zip = montarZip([{ nome: 'xl/worksheets/sheet1.xml', dados: Buffer.alloc(33 * 1024 * 1024) }]);
    assert.ok(zip.length < 1024 * 1024, 'a bomba precisa ser pequena comprimida');
    assert.throws(() => lerXlsx(zip), erroParse('ARQUIVO_MUITO_GRANDE'));
  });
  test('mais de 100 entradas no ZIP -> ARQUIVO_MUITO_GRANDE', () => {
    const entradas = Array.from({ length: 101 }, (_, i) => ({ nome: `p/${i}.xml`, dados: Buffer.from('x') }));
    assert.throws(() => lerXlsx(montarZip(entradas)), erroParse('ARQUIVO_MUITO_GRANDE'));
  });

  test('10.005 linhas de dados -> ARQUIVO_MUITO_GRANDE', () => {
    const uma = linhaXlsx({ 'ID integração': 'ADV-000001' });
    assert.throws(() => lerXlsx(montarXlsx(new Array(10_005).fill(uma))), erroParse('ARQUIVO_MUITO_GRANDE'));
  });
  test('exatamente 10.000 linhas de dados passam', () => {
    const uma = linhaXlsx({ 'ID integração': 'ADV-000001' });
    assert.equal(lerXlsx(montarXlsx(new Array(10_000).fill(uma))).length, 10_000);
  });
  test('linhas em branco no fim são ignoradas', () => {
    const vazia = CABECALHO_ESPERADO.map(() => '');
    const buf = montarXlsx([linhaXlsx({ 'ID integração': 'ADV-000001' }), vazia, vazia, vazia]);
    assert.equal(lerXlsx(buf).length, 1);
  });
  test('só a primeira aba é lida', () => {
    const buf = xlsxDeAoa(
      [CABECALHO_ESPERADO, linhaXlsx({ 'ID integração': 'ADV-000001' })],
      { Outra: [['lixo'], ['mais lixo']] },
    );
    const linhas = lerXlsx(buf);
    assert.equal(linhas.length, 1);
    assert.equal(linhas[0].idIntegracao, 'ADV-000001');
  });
});

// --- leitura de linhas -----------------------------------------------------------

describe('lerXlsx — linhas', () => {
  test('cabeçalho válido: normaliza as linhas (os 4 campos lidos + o sinal de valor ambíguo)', () => {
    const linhas = lerXlsx(montarXlsx([
      linhaXlsx({ 'ID integração': 'ADV-001001', Status: 'FINALIZADO', Valor: '129,40' }),
    ]));
    assert.deepEqual(linhas, [{
      idIntegracao: 'ADV-001001', status: 'FINALIZADO', statusConhecido: true, valorCentavos: 12940, valorAmbiguoTexto: null, motivoFalha: '',
    }]);
  });

  test('célula vazia no meio da linha: a coluna existe pelo cabeçalho, não pelo conteúdo (FR-004)', () => {
    // `null` no aoa NÃO grava célula: sem preenchimento posicional, as células
    // seguintes deslizariam uma coluna para a esquerda.
    const linha = linhaXlsx({
      'ID integração': 'ADV-000015', Status: 'Devolvida', Valor: '54,57', Motivo: 'Conta inválida',
    });
    linha[CABECALHO_ESPERADO.indexOf('Favorecido')] = null;
    linha[CABECALHO_ESPERADO.indexOf('Comprovante Transfeera')] = null;
    linha[CABECALHO_ESPERADO.indexOf('Comprovante Banco')] = null;
    const [l] = lerXlsx(xlsxDeAoa([CABECALHO_ESPERADO, linha]));
    assert.equal(l.idIntegracao, 'ADV-000015');
    assert.equal(l.status, 'Devolvida');
    assert.equal(l.valorCentavos, 5457);
    assert.equal(l.motivoFalha, 'Conta inválida');
  });

  test('tipos de célula: texto "54,57", número nativo 54.57 e fórmula (só o valor em cache)', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      CABECALHO_ESPERADO,
      linhaXlsx({ 'ID integração': 'ADV-000001', Valor: '54,57' }),
      linhaXlsx({ 'ID integração': 'ADV-000002', Valor: 54.57 }),
      linhaXlsx({ 'ID integração': 'ADV-000003', Valor: 0 }),
    ]);
    // Fórmula `1+1` com valor em cache 54.57: executar daria 2 (200 centavos).
    ws[`${XLSX.utils.encode_col(CABECALHO_ESPERADO.indexOf('Valor'))}4`] = { t: 'n', v: 54.57, f: '1+1' };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Transferências');
    const linhas = lerXlsx(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    assert.deepEqual(linhas.map((l) => l.valorCentavos), [5457, 5457, 5457]);
  });

  test('texto de instrução / fórmula em célula de texto é só texto (nada é executado)', () => {
    const malicioso = "=cmd|' /C calc'!A0";
    const [l] = lerXlsx(montarXlsx([
      linhaXlsx({ 'ID integração': 'ADV-000001', Status: 'Devolvida', Valor: '1,00', Motivo: malicioso }),
    ]));
    assert.equal(l.motivoFalha, malicioso);
  });
});

// --- status (FR-006, FR-007, FR-014) ---------------------------------------------

describe('status do retorno', () => {
  const itensLote = (valor = 5457) => [
    { solicitacaoId: 15, colIdIntegracao: 'ADV-000015', situacao: 'incluido', valorCentavos: valor },
  ];
  const casar = (status, extra = {}) => casarComItensDoLote(
    lerXlsx(montarXlsx([linhaXlsx({ 'ID integração': 'ADV-000015', Status: status, Valor: '54,57', ...extra })])),
    itensLote(),
  );

  test('os três rótulos medidos são os únicos conhecidos', () => {
    assert.deepEqual([...STATUS_CONHECIDOS].sort(), ['Devolvida', 'FINALIZADO', 'Finalizada']);
  });
  test('FINALIZADO e Finalizada -> efetivado (aplicável, sem motivo)', () => {
    for (const s of ['FINALIZADO', 'Finalizada']) {
      const { aplicaveis, ignoradas, faltantes } = casar(s);
      assert.deepEqual(aplicaveis, [{ solicitacaoId: 15, status: s, motivo: null }], s);
      assert.deepEqual(ignoradas, []);
      assert.deepEqual(faltantes, []);
    }
  });
  test('Devolvida -> ramo de devolução com o motivo LITERAL da coluna Motivo (US3-AS4)', () => {
    const { aplicaveis } = casar('Devolvida', { Motivo: 'Conta do recebedor não existe ou foi encerrada.' });
    assert.deepEqual(aplicaveis, [{
      solicitacaoId: 15, status: 'Devolvida', motivo: 'Conta do recebedor não existe ou foi encerrada.',
    }]);
  });
  test('Devolvida sem Motivo cai para o próprio status, nunca texto fabricado', () => {
    assert.equal(casar('Devolvida').aplicaveis[0].motivo, 'Devolvida');
  });
  test('rótulo desconhecido (XYZ) -> STATUS_DESCONHECIDO:XYZ e o lote NÃO é confirmado', () => {
    const { aplicaveis, ignoradas, faltantes } = casar('XYZ');
    assert.deepEqual(aplicaveis, []);
    assert.deepEqual(ignoradas, [{ idIntegracao: 'ADV-000015', motivo: 'STATUS_DESCONHECIDO:XYZ' }]);
    assert.deepEqual(faltantes, [15]);
  });
  test('caixa exata: "finalizado" minúsculo não é conhecido', () => {
    assert.equal(casar('finalizado').ignoradas[0].motivo, 'STATUS_DESCONHECIDO:finalizado');
  });

  test('FR-014: status de 5.000 caracteres com <script> e controle é saneado e cortado em 40', () => {
    const hostil = `<script>alert(1)</script>\u0000\u0007${'A'.repeat(5000)}`;
    const linhas = [{
      idIntegracao: 'ADV-000015', status: hostil, statusConhecido: false, valorCentavos: 5457, motivoFalha: '',
    }];
    const { ignoradas } = casarComItensDoLote(linhas, itensLote());
    const prefixo = 'STATUS_DESCONHECIDO:';
    assert.ok(ignoradas[0].motivo.startsWith(prefixo));
    const rotulo = ignoradas[0].motivo.slice(prefixo.length);
    assert.ok(rotulo.length > 0 && rotulo.length <= 40, `rótulo com ${rotulo.length} caracteres`);
    assert.match(rotulo, /^[\p{L}\p{N} ._-]*$/u, 'só caracteres imprimíveis seguros');
    assert.ok(!/[<>\u0000-\u001f]/.test(rotulo));
  });
});

// --- SC-004: 10.000 linhas -----------------------------------------------------

describe('desempenho (SC-004)', () => {
  test('10.000 linhas: lerXlsx + casarComItensDoLote em menos de 5 s', (t) => {
    const linhas = Array.from({ length: 10_000 }, (_, i) => linhaXlsx({
      'ID integração': `ADV-${String(i + 1).padStart(6, '0')}`, Valor: '10,00',
    }));
    const buf = montarXlsx(linhas);
    const itens = Array.from({ length: 5000 }, (_, i) => ({
      solicitacaoId: i + 1, colIdIntegracao: `ADV-${String(i + 1).padStart(6, '0')}`, situacao: 'incluido', valorCentavos: 1000,
    }));
    const t0 = process.hrtime.bigint();
    const lidas = lerXlsx(buf);
    const r = casarComItensDoLote(lidas, itens);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    t.diagnostic(`SC-004: 10.000 linhas, ${buf.length} bytes, lerXlsx+casar = ${ms.toFixed(0)} ms`);
    assert.equal(lidas.length, 10_000);
    assert.equal(r.aplicaveis.length, 5000);
    assert.ok(ms < 5000, `levou ${ms} ms`);
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

describe('casarComItensDoLote — mensagens de erro reais (motivo literal, sem tradução)', () => {
  for (const [codigo, mensagem] of CODIGOS_REAIS) {
    test(`Devolvida (${codigo}) -> motivo literal da coluna "Motivo"`, () => {
      const itensLote = [{
        solicitacaoId: 2001, colIdIntegracao: 'ADV-002001', situacao: 'incluido', valorCentavos: 10000,
      }];
      const linhas = lerXlsx(montarXlsx([
        linhaXlsx({
          'ID integração': 'ADV-002001', Status: 'Devolvida', Valor: '100,00', Motivo: mensagem,
        }),
      ]));
      const { aplicaveis, ignoradas, faltantes } = casarComItensDoLote(linhas, itensLote);
      assert.equal(ignoradas.length, 0);
      assert.equal(faltantes.length, 0);
      assert.deepEqual(aplicaveis, [{ solicitacaoId: 2001, status: 'Devolvida', motivo: mensagem }]);
    });
  }
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
    { // faltante — nenhuma linha do arquivo casa com este item
      solicitacaoId: 1004, colIdIntegracao: 'ADV-001004', situacao: 'incluido', valorCentavos: 7000,
    },
  ];

  const xlsx = montarXlsx([
    linhaXlsx({ 'ID integração': 'ADV-001001', Status: 'FINALIZADO', Valor: '129,40' }),
    linhaXlsx({ 'ID integração': 'ADV-001003', Status: 'FINALIZADO', Valor: '30,00' }), // já aplicado
    linhaXlsx({ 'ID integração': 'ADV-999999', Status: 'FINALIZADO', Valor: '10,00' }), // não pertence ao lote
    linhaXlsx({ 'ID integração': '', Status: 'FINALIZADO', Valor: '10,00' }), // vazio
    linhaXlsx({ 'ID integração': 'PAGAMENTO MANUAL JOAO DA SILVA', Status: 'FINALIZADO', Valor: '10,00' }), // texto livre
    linhaXlsx({ 'ID integração': 'ADV-001005', Status: 'Processando', Valor: '80,00' }), // status desconhecido
    linhaXlsx({ 'ID integração': 'ADV-001006', Status: 'FINALIZADO', Valor: '50,00' }), // valor divergente (item=99.99)
  ]);

  const linhas = lerXlsx(xlsx);
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
    // 1004: nenhuma linha no arquivo. 1005/1006: têm linha, mas foram ignoradas
    // (status desconhecido / valor divergente) — continuam sem resolução,
    // então também bloqueiam a aplicação plena do lote (nunca "pago" por omissão).
    assert.deepEqual([...faltantes].sort((a, b) => a - b), [1004, 1005, 1006]);
  });

  test('Finalizada casada por id -> aplicável, sem motivo', () => {
    const ap = aplicaveis.find((a) => a.solicitacaoId === 1001);
    assert.ok(ap);
    assert.equal(ap.status, 'FINALIZADO');
    assert.equal(ap.motivo, null);
  });

  test('reimportar o mesmo arquivo depois de aplicado: tudo vira JA_APLICADO, nada some/duplica', () => {
    const itensJaAplicados = itensLote.map((it) => (
      it.solicitacaoId === 1001 ? { ...it, situacao: 'pago' } : it
    ));
    const segunda = casarComItensDoLote(lerXlsx(xlsx), itensJaAplicados);
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
    const xlsx = montarXlsx([
      linhaXlsx({ 'ID integração': 'ADV-002001', Status: 'FINALIZADO', Valor: '129,40' }),
      linhaXlsx({
        'ID integração': 'ADV-002001', Status: 'Devolvida', Valor: '129,40', Motivo: 'Conta do recebedor não existe ou foi encerrada.',
      }),
    ]);
    assert.throws(
      () => casarComItensDoLote(lerXlsx(xlsx), itensLote),
      (e) => e instanceof RetornoTransfeeraParseError && e.motivo === 'LINHA_DUPLICADA',
    );
  });

  test('duplicata com mesmo status mas motivo diferente também é conflito', () => {
    const xlsx = montarXlsx([
      linhaXlsx({
        'ID integração': 'ADV-002001', Status: 'Devolvida', Valor: '129,40', Motivo: 'Conta do recebedor não existe ou foi encerrada.',
      }),
      linhaXlsx({
        'ID integração': 'ADV-002001', Status: 'Devolvida', Valor: '129,40', Motivo: 'Conta inválida.',
      }),
    ]);
    assert.throws(
      () => casarComItensDoLote(lerXlsx(xlsx), itensLote),
      (e) => e instanceof RetornoTransfeeraParseError && e.motivo === 'LINHA_DUPLICADA',
    );
  });

  test('duplicata idêntica (ruído do arquivo) -> deduplicada, 1 aplicável e nenhum faltante', () => {
    const linha = { 'ID integração': 'ADV-002001', Status: 'FINALIZADO', Valor: '129,40' };
    const xlsx = montarXlsx([linhaXlsx(linha), linhaXlsx(linha)]);
    const { aplicaveis, ignoradas, faltantes } = casarComItensDoLote(lerXlsx(xlsx), itensLote);
    assert.equal(aplicaveis.length, 1);
    assert.equal(aplicaveis[0].solicitacaoId, 2001);
    assert.deepEqual(ignoradas, []);
    assert.deepEqual(faltantes, []);
  });

  test('várias linhas sem id no padrão ADV-<id> não são tratadas como duplicata', () => {
    const xlsx = montarXlsx([
      linhaXlsx({ 'ID integração': '', Status: 'FINALIZADO', Valor: '10,00' }),
      linhaXlsx({ 'ID integração': '', Status: 'Devolvida', Valor: '20,00' }),
      linhaXlsx({ 'ID integração': 'ADV-002001', Status: 'FINALIZADO', Valor: '129,40' }),
    ]);
    const { aplicaveis, ignoradas } = casarComItensDoLote(lerXlsx(xlsx), itensLote);
    assert.equal(aplicaveis.length, 1);
    assert.deepEqual(ignoradas.map((i) => i.motivo), ['ID_INTEGRACAO_INVALIDO', 'ID_INTEGRACAO_INVALIDO']);
  });
});

// --- prefixo parametrizável (ADV default; REP = repasse) ----------------------

describe('prefixo do ID de integração', () => {
  const xlsxRep = montarXlsx([linhaXlsx({ 'ID integração': 'REP-000123', Status: 'FINALIZADO', Valor: '10,00' })]);
  const xlsxAdv = montarXlsx([linhaXlsx({ 'ID integração': 'ADV-000123', Status: 'FINALIZADO', Valor: '10,00' })]);
  const item = (col) => [{ solicitacaoId: 123, colIdIntegracao: col, situacao: 'incluido', valorCentavos: 1000 }];

  test('REP-000123 casa com { prefixo: "REP" }', () => {
    const r = casarComItensDoLote(lerXlsx(xlsxRep), item('REP-000123'), { prefixo: 'REP' });
    assert.deepEqual(r.aplicaveis.map((a) => a.solicitacaoId), [123]);
    assert.deepEqual(r.ignoradas, []);
  });
  test('o MESMO REP-000123 NÃO casa com o default ADV (ID_INTEGRACAO_INVALIDO)', () => {
    const r = casarComItensDoLote(lerXlsx(xlsxRep), item('REP-000123'));
    assert.deepEqual(r.aplicaveis, []);
    assert.equal(r.ignoradas[0].motivo, 'ID_INTEGRACAO_INVALIDO');
  });
  test('ADV-000123 continua casando com o default', () => {
    const r = casarComItensDoLote(lerXlsx(xlsxAdv), item('ADV-000123'));
    assert.deepEqual(r.aplicaveis.map((a) => a.solicitacaoId), [123]);
  });
  test('ADV-000123 NÃO casa com { prefixo: "REP" }', () => {
    const r = casarComItensDoLote(lerXlsx(xlsxAdv), item('ADV-000123'), { prefixo: 'REP' });
    assert.equal(r.ignoradas[0].motivo, 'ID_INTEGRACAO_INVALIDO');
  });
  test('extrairIdSolicitacao respeita o prefixo', () => {
    assert.equal(extrairIdSolicitacao('REP-000123', { prefixo: 'REP' }), 123);
    assert.equal(extrairIdSolicitacao('REP-000123'), null);
  });
  test('prefixo malformado falha alto', () => {
    for (const p of ['rep', 'R', 'A.*', 'ABCDEFGHI', '', null]) {
      assert.throws(() => extrairIdSolicitacao('X-1', { prefixo: p }), TypeError);
    }
  });
});

describe('casarComItensDoLote — valor ambíguo na borda (milhar sem decimais)', () => {
  const item = (id, valorCentavos) => ({ solicitacaoId: id, colIdIntegracao: `ADV-00${id}`, situacao: 'incluido', valorCentavos });
  const casar = (valor, valorCentavos) => casarComItensDoLote(
    lerXlsx(montarXlsx([linhaXlsx({ 'ID integração': 'ADV-00101', Valor: valor })])),
    [item(101, valorCentavos)],
  );

  for (const [texto, centavosLidos] of [['1.234', 123], ['12.345', 1235]]) {
    test(`"${texto}" -> VALOR_AMBIGUO nomeando o texto, mesmo se o valor lido bater com o item`, () => {
      const { aplicaveis, ignoradas } = casar(texto, centavosLidos);
      assert.equal(aplicaveis.length, 0);
      assert.deepEqual(ignoradas.map((i) => i.motivo), [`VALOR_AMBIGUO:${texto}`]);
    });
  }

  test('contraprova: "1.234,56" e "54,57" seguem aplicáveis', () => {
    assert.equal(casar('1.234,56', 123456).aplicaveis.length, 1);
    assert.equal(casar('54,57', 5457).aplicaveis.length, 1);
  });
});
