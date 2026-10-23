/**
 * Leitor de "pagos por fora" (5 colunas) — fixtures 100% sintéticas (tasks 3.1/2.1).
 * Rodam com: node --test tests/lancamento-externo-unit.test.js
 */
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lerLancamentos, contarPorMotivo, LancamentoExternoParseError } = require('../lib/lancamento-externo');
const { xlsxComDimensao, xlsxDeAoa, comCabecalho, cnpjSintetico, nomeSintetico, CABECALHO } = require('./helpers/xlsx-sintetico');
const { varrer } = require('./helpers/varredura-pii-xlsx');

const HOJE = '2026-10-22';
const ler = (...linhas) => lerLancamentos(xlsxDeAoa(comCabecalho(...linhas)), { hoje: HOJE });
const motivos = (r) => r.recusadas.map((x) => x.motivo);
const erroArquivo = (motivo) => (e) => e instanceof LancamentoExternoParseError && e.motivo === motivo;

describe('cabeçalho por contrato (arquivo inteiro)', () => {
  test('ordem trocada -> CABECALHO_INVALIDO', () => {
    const aoa = [['Data do pagamento', 'CNPJ', 'Valor', 'Nome', 'Observação'], [cnpjSintetico(1), '21/10/2026', 30, 'x', '']];
    assert.throws(() => lerLancamentos(xlsxDeAoa(aoa), { hoje: HOJE }), erroArquivo('CABECALHO_INVALIDO'));
  });
  test('só cabeçalho -> ARQUIVO_VAZIO (nunca "0 aplicadas, sucesso")', () => {
    assert.throws(() => lerLancamentos(xlsxDeAoa([CABECALHO]), { hoje: HOJE }), erroArquivo('ARQUIVO_VAZIO'));
  });
  test('não é XLSX -> FORMATO_INVALIDO', () => {
    assert.throws(() => lerLancamentos(Buffer.from('CNPJ;Data'), { hoje: HOJE }), erroArquivo('FORMATO_INVALIDO'));
  });
});

describe('M1 (rodada 4) — número da linha na planilha', () => {
  test('linhas em branco no meio e no início não deslocam `linha`', () => {
    const aoa = [CABECALHO, [], [cnpjSintetico(2), '21/10/2026', 30, 'x', ''], [], [], ['xx', '21/10/2026', 30, 'x', '']];
    const r = lerLancamentos(xlsxDeAoa(aoa), { hoje: HOJE });
    assert.deepEqual(r.validas.map((v) => v.linha), [3]);
    assert.equal(r.recusadas.length, 1);
    assert.equal(r.validas[0].i, 0, 'o índice `i` (contrato com a RPC) segue sendo o da lista filtrada');
  });
});

describe('MEDIUM 2/3 (rodada 3) — planilha feita à mão', () => {
  const XLSX = require('xlsx');
  const comDimensao = (aoa, ref) => {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!ref'] = ref;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Planilha1');
    wb.Workbook = { WBProps: { date1904: false } };
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  };
  const linhaOk = [cnpjSintetico(2), '21/10/2026', 30, 'x', ''];

  test('MEDIUM 2: 1 linha de dados com <dimension> inflada (A1:E20000, o Excel faz isso ao apagar linhas) É lida', () => {
    const buf = comDimensao(comCabecalho(linhaOk), 'A1:E20000');
    assert.equal(XLSX.read(buf).Sheets.Planilha1['!ref'], 'A1:E20000', 'fixture: a dimensão inflada está de fato no arquivo');
    const r = lerLancamentos(buf, { hoje: HOJE });
    assert.equal(r.validas.length, 1);
  });
  test('MEDIUM 2 (controle negativo): dimensão inflada E 10.005 linhas REAIS continua ARQUIVO_MUITO_GRANDE', () => {
    const muitas = Array.from({ length: 10005 }, (_, i) => [cnpjSintetico(2 + (i % 90)), '21/10/2026', 1, '', '']);
    assert.throws(() => lerLancamentos(comDimensao(comCabecalho(...muitas), 'A1:E20000'), { hoje: HOJE }), erroArquivo('ARQUIVO_MUITO_GRANDE'));
  });
  test('MEDIUM 2 (controle negativo): dado REAL depois de milhares de linhas em branco é LIDO — nunca descartado calado', () => {
    const ws = XLSX.utils.aoa_to_sheet(comCabecalho(linhaOk));
    XLSX.utils.sheet_add_aoa(ws, [[cnpjSintetico(3), '21/10/2026', 30, 'x', '']], { origin: 'A20000' });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Planilha1');
    wb.Workbook = { WBProps: { date1904: false } };
    const r = lerLancamentos(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { hoje: HOJE });
    assert.equal(r.validas.length, 2);
  });
  // --- Rodada 4 (A3/A4/M5): a ÁREA declarada, não o tamanho do arquivo, é o que custa CPU --------------------------
  describe('rodada 4 — área declarada e dimensão mentirosa (arquivos de poucos KB)', () => {
    const linha = [cnpjSintetico(2), '21/10/2026', 30, 'x', 'y'];
    const medir = (buf) => { const t0 = Date.now(); const r = lerLancamentos(buf, { hoje: HOJE }); return { r, ms: Date.now() - t0 }; };

    test('A3: <dimension> A1:XFD1048576 (2,5 KB) é lida em milissegundos — antes custava >90 s com o backend parado', () => {
      for (const ref of ['A1:XFD1048576', 'A1:Z1048576', 'A1:E1048576']) {
        const buf = xlsxComDimensao(comCabecalho(linha), ref);
        assert.ok(buf.length < 10 * 1024, 'fixture pequena');
        const { r, ms } = medir(buf);
        assert.equal(r.validas.length, 1, ref);
        assert.ok(ms < 1500, `${ref} levou ${ms} ms`);
      }
    });
    test('A3: duas células nos cantos opostos (A1 e XFD1048576) -> ARQUIVO_MUITO_GRANDE, sem iterar a área', () => {
      const buf = xlsxComDimensao(comCabecalho(linha), 'A1:XFD1048576', '<row r="1048576"><c r="XFD1048576"><v>1</v></c></row>');
      const t0 = Date.now();
      assert.throws(() => lerLancamentos(buf, { hoje: HOJE }), erroArquivo('ARQUIVO_MUITO_GRANDE'));
      assert.ok(Date.now() - t0 < 1500);
    });
    test('M5: dimensão inflada + XML descomprimido > 2 MiB -> ARQUIVO_MUITO_GRANDE (o gate MAX_BYTES_RELEITURA)', () => {
      const grande = [cnpjSintetico(2), '21/10/2026', 30, 'x'.repeat(3 * 1024 * 1024), ''];
      assert.throws(() => lerLancamentos(xlsxComDimensao(comCabecalho(grande), 'A1:E20000'), { hoje: HOJE }), erroArquivo('ARQUIVO_MUITO_GRANDE'));
      // controle: a MESMA planilha sem a dimensão inflada é lida (o gate é o que a recusa, não o tamanho)
      assert.equal(lerLancamentos(xlsxComDimensao(comCabecalho(grande), 'A1:E2'), { hoje: HOJE }).validas.length, 1);
    });
    test('A4: 30 linhas reais com <dimension> A1:E2 são TODAS lidas — antes entrava 1 e respondia 200 "tudo certo"', () => {
      const aoa = comCabecalho(...Array.from({ length: 30 }, (_, i) => [cnpjSintetico(2 + i), '21/10/2026', 30, 'x', 'y']));
      const r = lerLancamentos(xlsxComDimensao(aoa, 'A1:E2'), { hoje: HOJE });
      assert.equal(r.validas.length + r.recusadas.length, 30);
    });
    // Rodada 5b (A2): 10.022 linhas físicas, 10.020 de dados, 1 BRANCO na física 2. A rede antiga contava não-vazias
    // (linhas.length) e o branco a derrubava para baixo do teto -> aceitava 10.000 e descartava 20 pagamentos calada.
    describe('A2 (rodada 5b) — linha em branco dentro do corte não esconde o excedente', () => {
      const dados = (n) => Array.from({ length: n }, (_, i) => [cnpjSintetico(2 + (i % 90)), '21/10/2026', 1, '', '']);
      const comBranco = comCabecalho(['', '', '', '', ''], ...dados(10020)); // 10.022 físicas
      for (const ref of ['A1:E2', 'A1:E10001']) {
        test(`dimensão subdeclarada ${ref} + branco na física 2 -> ARQUIVO_MUITO_GRANDE`, () => {
          assert.throws(() => lerLancamentos(xlsxComDimensao(comBranco, ref), { hoje: HOJE }), erroArquivo('ARQUIVO_MUITO_GRANDE'));
        });
      }
      test('XML > 2 MiB (sem releitura: só o corte vale) + dimensão subdeclarada + branco -> ARQUIVO_MUITO_GRANDE', () => {
        const grande = comCabecalho(['', '', '', '', ''], [cnpjSintetico(2), '21/10/2026', 1, 'x'.repeat(3 * 1024 * 1024), ''], ...dados(10019));
        assert.throws(() => lerLancamentos(xlsxComDimensao(grande, 'A1:E2'), { hoje: HOJE }), erroArquivo('ARQUIVO_MUITO_GRANDE'));
      });
      test('controle: dimensão honesta A1:E10022 recusa', () => {
        assert.throws(() => lerLancamentos(xlsxComDimensao(comBranco, 'A1:E10022'), { hoje: HOJE }), erroArquivo('ARQUIVO_MUITO_GRANDE'));
      });
      test('controle: sem a tag <dimension> recusa', () => {
        assert.throws(() => lerLancamentos(xlsxComDimensao(comBranco, null), { hoje: HOJE }), erroArquivo('ARQUIVO_MUITO_GRANDE'));
      });
      test('controle: sem o branco (10.009 dados) recusa', () => {
        assert.throws(() => lerLancamentos(xlsxComDimensao(comCabecalho(...dados(10009)), 'A1:E2'), { hoje: HOJE }), erroArquivo('ARQUIVO_MUITO_GRANDE'));
      });
      test('limite exato: 10.000 dados sem branco, dimensão A1:E2, é LIDO (a rede não recusa arquivo que cabe)', () => {
        const r = lerLancamentos(xlsxComDimensao(comCabecalho(...dados(10000)), 'A1:E2'), { hoje: HOJE });
        assert.equal(r.validas.length + r.recusadas.length, 10000);
      });
    });
    test('A4: dimensão pequena e 10.001 linhas reais -> ARQUIVO_MUITO_GRANDE (nunca importa o recorte)', () => {
      const aoa = comCabecalho(...Array.from({ length: 10001 }, () => linha));
      assert.throws(() => lerLancamentos(xlsxComDimensao(aoa, 'A1:E2'), { hoje: HOJE }), erroArquivo('ARQUIVO_MUITO_GRANDE'));
    });
  });

  test('MEDIUM 3: caixa, acento e célula VAZIA a mais à direita não derrubam o arquivo', () => {
    for (const cab of [
      ['cnpj', 'data do pagamento', 'valor', 'nome', 'observacao'],
      ['CNPJ', 'Data do Pagamento', 'Valor', 'Nome', 'Observacao'],
      ['CNPJ', 'Data do pagamento', 'Valor', 'Nome', 'Observação', ''],
      ['  CNPJ ', 'Data  do   pagamento', 'Valor', 'Nome', 'OBSERVAÇÃO', '', ''],
    ]) {
      assert.equal(lerLancamentos(xlsxDeAoa([cab, linhaOk]), { hoje: HOJE }).validas.length, 1, JSON.stringify(cab));
    }
  });
  test('MEDIUM 3 (controle negativo): coluna a mais COM texto, a menos, outro nome ou outra ordem continuam recusadas', () => {
    for (const cab of [
      ['CNPJ', 'Data do pagamento', 'Valor', 'Nome', 'Observação', 'Extra'],
      ['CNPJ', 'Data do pagamento', 'Valor', 'Nome'],
      ['CNPJ', 'Data do pagamento', 'Valores', 'Nome', 'Observação'],
      ['Valor', 'CNPJ', 'Data do pagamento', 'Nome', 'Observação'],
    ]) {
      assert.throws(() => lerLancamentos(xlsxDeAoa([cab, linhaOk]), { hoje: HOJE }), erroArquivo('CABECALHO_INVALIDO'), JSON.stringify(cab));
    }
  });
});

describe('CNPJ', () => {
  test('fixtures sintéticas têm DV INVÁLIDO (não parecem CNPJ real) para todo id usado', () => {
    const valido = (c) => {
      const calc = (n) => { const w = n === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2]; const r = w.reduce((a, x, i) => a + x * Number(c[i]), 0) % 11; return r < 2 ? 0 : 11 - r; };
      return `${calc(12)}${calc(13)}` === c.slice(12);
    };
    assert.equal(valido('90000000000001'), true, 'a função de DV precisa reconhecer um válido (controle)');
    for (let id = 1; id <= 99; id += 1) assert.equal(valido(cnpjSintetico(id)), false, `id ${id}`);
  });
  test('com e sem máscara normalizam para 14 dígitos', () => {
    const r = ler(['90.000.000/0010-01', '21/10/2026', 30], ['90000000000002', '21/10/2026', 30]);
    assert.deepEqual(r.validas.map((v) => v.cnpj), [cnpjSintetico(1), cnpjSintetico(2)]);
  });
  test('menos de 14 dígitos -> CNPJ_INVALIDO', () => {
    assert.deepEqual(motivos(ler(['123', '21/10/2026', 30])), ['CNPJ_INVALIDO']);
  });
});

describe('valor', () => {
  test('1.234 (milhar sem decimais) -> VALOR_AMBIGUO', () => {
    assert.deepEqual(motivos(ler([cnpjSintetico(1), '21/10/2026', '1.234'])), ['VALOR_AMBIGUO']);
  });
  test('1.234,56 e "R$ 30,5" são aceitos', () => {
    const r = ler([cnpjSintetico(1), '21/10/2026', '1.234,56'], [cnpjSintetico(2), '21/10/2026', 'R$ 30,5']);
    assert.deepEqual(r.validas.map((v) => v.valor), ['1234.56', '30.50']);
  });
  test('zero, negativo e texto -> VALOR_INVALIDO', () => {
    const r = ler([cnpjSintetico(1), '21/10/2026', 0], [cnpjSintetico(2), '21/10/2026', -5], [cnpjSintetico(3), '21/10/2026', 'abc']);
    assert.deepEqual(motivos(r), ['VALOR_INVALIDO', 'VALOR_INVALIDO', 'VALOR_INVALIDO']);
  });
  test('FR-047: 1234.565 e "100,005" -> VALOR_FRACAO_DE_CENTAVO (gate ANTES de paraCentavos)', () => {
    const r = ler([cnpjSintetico(1), '21/10/2026', 1234.565], [cnpjSintetico(2), '21/10/2026', '100,005']);
    assert.deepEqual(motivos(r), ['VALOR_FRACAO_DE_CENTAVO', 'VALOR_FRACAO_DE_CENTAVO']);
  });
  test('erro de representação binária não recusa: 0.1+0.2 vira 0,30', () => {
    assert.equal(ler([cnpjSintetico(1), '21/10/2026', 0.1 + 0.2]).validas[0].valor, '0.30');
  });
  test('FR-048: teto R$ 5.000 por linha (5000 passa, 5000,01 recusa e nomeia o teto)', () => {
    const r = ler([cnpjSintetico(1), '21/10/2026', 5000], [cnpjSintetico(2), '21/10/2026', 5000.01]);
    assert.equal(r.validas.length, 1);
    assert.deepEqual(motivos(r), ['VALOR_ACIMA_DO_TETO']);
  });
});

describe('data (texto) e faixa', () => {
  test('dd/mm/aaaa e aaaa-mm-dd; 31/02 -> DATA_INVALIDA', () => {
    const r = ler([cnpjSintetico(1), '21/10/2026', 1], [cnpjSintetico(2), '2026-10-21', 1], [cnpjSintetico(3), '31/02/2026', 1]);
    assert.equal(r.validas.length, 2);
    assert.deepEqual(motivos(r), ['DATA_INVALIDA']);
  });
  test('fora da faixa: antes de 2024-01-01 e depois de hoje+1; hoje+1 passa', () => {
    const r = ler([cnpjSintetico(1), '31/12/2023', 1], [cnpjSintetico(2), '24/10/2026', 1], [cnpjSintetico(3), '23/10/2026', 1]);
    assert.deepEqual(motivos(r), ['DATA_FORA_DA_FAIXA', 'DATA_FORA_DA_FAIXA']);
    assert.equal(r.validas.length, 1);
  });
});

describe('observação e dedup no arquivo', () => {
  test('500 passa; 501 -> OBSERVACAO_MUITO_LONGA (sem truncar); vazia -> null', () => {
    const r = ler([cnpjSintetico(1), '21/10/2026', 1, '', 'a'.repeat(500)], [cnpjSintetico(2), '21/10/2026', 1, '', 'a'.repeat(501)], [cnpjSintetico(3), '21/10/2026', 1]);
    assert.equal(r.validas[0].obs.length, 500);
    assert.equal(r.validas[1].obs, null);
    assert.deepEqual(motivos(r), ['OBSERVACAO_MUITO_LONGA']);
  });
  test('FR-029: mesma chave (cnpj+data) -> 1ª aplicada, 2ª DUPLICADA_NO_ARQUIVO, nunca soma', () => {
    const r = ler([cnpjSintetico(1), '21/10/2026', 10], [cnpjSintetico(1), '2026-10-21', 99]);
    assert.deepEqual(r.validas.map((v) => v.valor), ['10.00']);
    assert.deepEqual(motivos(r), ['DUPLICADA_NO_ARQUIVO']);
  });
});

describe('nada identificável nas saídas (FR-031)', () => {
  test('Nome nunca aparece em validas/recusadas; motivo é token fechado', () => {
    const r = ler([cnpjSintetico(1), '21/10/2026', 'lixo ' + nomeSintetico(1), nomeSintetico(1), '']);
    assert.ok(!JSON.stringify(r).includes('Motorista Teste'));
    assert.ok(motivos(r).every((m) => /^[A-Z_]+$/.test(m)));
  });
  test('contarPorMotivo devolve só motivo+total', () => {
    assert.deepEqual(contarPorMotivo(['A', 'B', 'A']), [{ motivo: 'A', total: 2 }, { motivo: 'B', total: 1 }]);
  });
  // MEDIUM 7 (rodada 3): a tabela de textos que o operador LÊ é a do frontend (`MOTIVO_LINHA`); a do backend era
  // código morto e o teste validava a morta. Aqui o conjunto de TOKENS que a RPC e o leitor emitem é extraído do
  // código-fonte e cruzado com a tabela do frontend — um token novo sem texto (ou um texto órfão) reprova.
  const FRONT = fs.readFileSync(path.join(__dirname, '../../frontend_v2/lib/hub/lancamento-externo.ts'), 'utf8');
  const tabelaFront = () => {
    const bloco = FRONT.slice(FRONT.indexOf('const MOTIVO_LINHA'), FRONT.indexOf('export const rotuloMotivoLinha'));
    return Object.fromEntries([...bloco.matchAll(/^ {2}([A-Z][A-Z_0-9]+): (.+),$/gm)].map((m) => [m[1], m[2]]));
  };
  const tokensDaRpc = () => {
    const sql = fs.readFileSync(path.join(__dirname, '../../../infra/hub/migrations/0117_lancamento_externo.sql'), 'utf8');
    const corpo = sql.slice(sql.indexOf('CREATE FUNCTION hub_lancamento_externo_aplicar'), sql.indexOf('REVOKE ALL ON FUNCTION hub_lancamento_externo_aplicar'));
    const ts = new Set();
    for (const m of corpo.matchAll(/RETURN QUERY SELECT v_idx,[^;]*;/g)) for (const t of m[0].matchAll(/'([A-Z][A-Z_]+)'/g)) ts.add(t[1]);
    ts.delete('APLICADA');
    return ts;
  };
  const tokensDoLeitor = () => {
    const src = fs.readFileSync(path.join(__dirname, '../lib/lancamento-externo.js'), 'utf8');
    const ts = new Set([...src.matchAll(/(?:recusa\(|motivo: )'([A-Z][A-Z_]+)'/g)].map((m) => m[1]));
    return ts;
  };
  test('CHK042/FR-033 + MEDIUM 7: tokens da RPC + do leitor == chaves de MOTIVO_LINHA (frontend), cada uma com texto', () => {
    const emitidos = new Set([...tokensDaRpc(), ...tokensDoLeitor()]);
    assert.ok(emitidos.size >= 14, 'a extração de tokens do código-fonte não pode ficar oca');
    for (const quatroDoBanco of ['CNPJ_SEM_MOTORISTA', 'SEMANA_JA_FECHADA', 'SEMANA_ANTERIOR_A_APURACAO', 'VALOR_EXCEDE_LIQUIDO']) {
      assert.ok(tokensDaRpc().has(quatroDoBanco), `a RPC deve emitir ${quatroDoBanco}`);
    }
    const tabela = tabelaFront();
    assert.deepEqual(Object.keys(tabela).sort(), [...emitidos].sort());
    for (const [k, v] of Object.entries(tabela)) assert.match(v, /\p{L}{4,}/u, k);
  });
  test('H4: os dois motivos de chave repetida explicam a chave, a consequência e o que fazer (igual ao frontend)', () => {
    assert.ok(FRONT.includes("UM_POR_DIA = 'É um lançamento por motorista, por dia e por tipo. Se houve dois pagamentos no mesmo dia, some-os numa única linha ANTES de enviar o arquivo.'"));
    const tabela = tabelaFront();
    for (const k of ['VALOR_DIVERGENTE', 'DUPLICADA_NO_ARQUIVO']) {
      assert.match(tabela[k], /\$\{UM_POR_DIA\}/, k);
      assert.match(tabela[k], /NÃO deduz/, k);
    }
  });
});

describe('2.1 varredura de PII das fixtures', () => {
  test('controle negativo: a varredura REPROVA CNPJ fora do prefixo e nome real-looking', () => {
    const sujo = xlsxDeAoa(comCabecalho(['12.345.678/0001-96', '21/10/2026', 30, 'Joao da Silva Pereira', '']));
    const { inspecionadas, achados } = varrer(sujo);
    assert.ok(inspecionadas >= 5);
    assert.deepEqual(achados.map((a) => a.tipo).sort(), ['documento', 'nome']);
  });
  test('fixtures da feature: zero PII, com células de fato inspecionadas', () => {
    const limpo = xlsxDeAoa(comCabecalho([cnpjSintetico(1), '21/10/2026', 30, nomeSintetico(1), 'obs sintetica']));
    const { inspecionadas, achados } = varrer(limpo);
    assert.ok(inspecionadas >= 9);
    assert.deepEqual(achados, []);
  });
  test('controle negativo: nome de terceiro na OBSERVAÇÃO também é achado (não há isenção por prefixo)', () => {
    const sujo = xlsxDeAoa(comCabecalho([cnpjSintetico(2), '21/10/2026', 30, nomeSintetico(2), 'obs Joao da Silva Pereira']));
    assert.deepEqual(varrer(sujo).achados.map((a) => a.tipo), ['nome']);
  });
  test('varredura oca lança (arquivo sem texto não vira "limpo")', () => {
    assert.throws(() => varrer(xlsxDeAoa([[]])), /oca/);
  });
});
