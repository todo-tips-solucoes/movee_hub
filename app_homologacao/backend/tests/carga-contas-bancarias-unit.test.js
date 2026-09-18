/**
 * Testes unitários — scripts/carga-contas-bancarias.js (tasks.md FASE 8,
 * 8.1.5/8.1.6). Rodam com: node --test tests/carga-contas-bancarias-unit.test.js
 *
 * NUNCA lê o arquivo real do operador (`docs/documentos_apoio/
 * conta_bancária_drivers.xlsx`, PII de gente real, fora do git) — toda
 * planilha aqui é sintética, gerada na hora, com o MESMO CPF/CNPJ didático
 * já usado por tests/adiantamento-conta-unit.test.js (123.456.789-09,
 * 11.222.333/0001-81) e UUIDs de exemplo sem relação com dado real.
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const {
  validarLinha,
  processarCarga,
  normalizarCodigoBanco,
  lerPlanilha,
  resumoAgregado,
  gravarRelatorio,
} = require('../scripts/carga-contas-bancarias');

const CPF_VALIDO = '12345678909';
const CNPJ_VALIDO = '11222333000181';
const UUID_1 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const UUID_2 = '11111111-2222-4333-8444-555555555555';

function linhaBase(overrides) {
  return {
    Nome: 'Fulano de Tal',
    ID: UUID_1,
    CPFEntregador: '999.999.999-99',
    'Nome titular': 'Fulano de Tal',
    'CPF/CNPJ do titular da Conta': CPF_VALIDO,
    Banco: '260',
    Agência: '0001',
    Conta: '123456',
    Dígito: '7',
    'Tipo Conta': 'Conta Corrente',
    ...overrides,
  };
}

describe('normalizarCodigoBanco', () => {
  test('código curto ganha zero à esquerda até 3 dígitos', () => {
    assert.equal(normalizarCodigoBanco('1'), '001');
    assert.equal(normalizarCodigoBanco('77'), '077');
    assert.equal(normalizarCodigoBanco('260'), '260');
  });

  test('ISPB (8 dígitos) e nome por extenso passam INALTERADOS — nunca mapeados por suposição (dec-027)', () => {
    assert.equal(normalizarCodigoBanco('00000208'), '00000208');
    assert.equal(normalizarCodigoBanco('Recargapay S.A.'), 'Recargapay S.A.');
  });
});

describe('validarLinha', () => {
  test('linha válida é aceita com dados normalizados', () => {
    const r = validarLinha(linhaBase());
    assert.equal(r.aceito, true);
    assert.equal(r.idExterno, UUID_1);
    assert.equal(r.dados.bancoCodigo, '260');
    assert.equal(r.dados.agencia, '0001');
    assert.equal(r.dados.tipoConta, 'CORRENTE');
    assert.equal(r.dados.titularDocumento, CPF_VALIDO);
    assert.equal(r.dados.titularTipo, 'PF');
  });

  test('banco escrito por nome (não numérico) é RECUSADO, nunca mapeado por suposição (dec-027, 8.1.2)', () => {
    const r = validarLinha(linhaBase({ Banco: 'Recargapay S.A.' }));
    assert.equal(r.aceito, false);
    assert.equal(r.motivo, 'BANCO_NAO_IDENTIFICADO');
  });

  test('banco em formato ISPB (8 dígitos) é RECUSADO, nunca mapeado por suposição (dec-027, 8.1.2)', () => {
    const r = validarLinha(linhaBase({ Banco: '00000208' }));
    assert.equal(r.aceito, false);
    assert.equal(r.motivo, 'BANCO_NAO_IDENTIFICADO');
  });

  test('código COMPE inexistente na lista é RECUSADO', () => {
    const r = validarLinha(linhaBase({ Banco: '999' }));
    assert.equal(r.aceito, false);
    assert.equal(r.motivo, 'BANCO_NAO_IDENTIFICADO');
  });

  test('ID fora do formato uuid é recusado', () => {
    const r = validarLinha(linhaBase({ ID: 'nao-e-uuid' }));
    assert.equal(r.aceito, false);
    assert.equal(r.motivo, 'ID_INVALIDO');
  });

  test('documento do titular com dígito verificador inválido é recusado', () => {
    const r = validarLinha(linhaBase({ 'CPF/CNPJ do titular da Conta': '11111111111' }));
    assert.equal(r.aceito, false);
    assert.equal(r.motivo, 'DOCUMENTO_INVALIDO');
  });

  test('titular PJ (CNPJ) é aceito, titularTipo=PJ', () => {
    const r = validarLinha(linhaBase({ 'CPF/CNPJ do titular da Conta': CNPJ_VALIDO }));
    assert.equal(r.aceito, true);
    assert.equal(r.dados.titularTipo, 'PJ');
  });

  test('tipo de conta fora de "Conta Corrente"/"Conta Poupança" é recusado', () => {
    const r = validarLinha(linhaBase({ 'Tipo Conta': 'Conta Salário' }));
    assert.equal(r.aceito, false);
    assert.equal(r.motivo, 'TIPO_CONTA_INVALIDO');
  });
});

describe('processarCarga — idempotência (8.1.6)', () => {
  test('rodar duas vezes sobre o mesmo arquivo não duplica contas', async () => {
    const linhas = [linhaBase({ ID: UUID_1 }), linhaBase({ ID: UUID_2 })];
    const entregadores = new Map([[UUID_1, { id: 101 }], [UUID_2, { id: 102 }]]);
    // Fake que simula a RPC real (ON CONFLICT ... DO NOTHING): um Set de
    // entregadorId já gravados — 2ª tentativa para o mesmo id nunca duplica.
    const gravados = new Set();
    const buscarEntregadorFn = async (idExterno) => entregadores.get(idExterno) || null;
    const gravarContaFn = async (entregadorId) => {
      if (gravados.has(entregadorId)) return { criada: false };
      gravados.add(entregadorId);
      return { criada: true };
    };

    const primeira = await processarCarga(linhas, { buscarEntregadorFn, gravarContaFn, simular: false });
    assert.equal(primeira.criadas, 2);
    assert.equal(primeira.jaExistentes, 0);
    assert.equal(gravados.size, 2);

    const segunda = await processarCarga(linhas, { buscarEntregadorFn, gravarContaFn, simular: false });
    assert.equal(segunda.criadas, 0, 'reexecução não deve criar de novo');
    assert.equal(segunda.jaExistentes, 2);
    assert.equal(gravados.size, 2, 'o "banco" de contas gravadas não pode crescer na 2ª execução');
  });

  test('--simular nunca chama gravarContaFn (relatório sem gravar, 8.1.3)', async () => {
    let chamado = false;
    const linhas = [linhaBase()];
    const relatorio = await processarCarga(linhas, {
      buscarEntregadorFn: async () => ({ id: 101 }),
      gravarContaFn: async () => { chamado = true; return { criada: true }; },
      simular: true,
    });
    assert.equal(chamado, false);
    assert.equal(relatorio.modo, 'simular');
    assert.equal(relatorio.criadas, 1, 'simular reporta quantas SERIAM criadas');
  });

  test('linha válida sem Entregador correspondente entra em semEntregador, nunca vira conta', async () => {
    const relatorio = await processarCarga([linhaBase()], {
      buscarEntregadorFn: async () => null,
      gravarContaFn: async () => { throw new Error('não deveria ser chamado'); },
      simular: false,
    });
    assert.equal(relatorio.semEntregador.length, 1);
    assert.equal(relatorio.semEntregador[0].idExterno, UUID_1);
    assert.equal(relatorio.criadas, 0);
  });
});

describe('lerPlanilha — leitura real via SheetJS (planilha sintética, nunca o arquivo do operador)', () => {
  test('lê linhas de uma planilha .xlsx gerada em memória', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carga-contas-teste-'));
    const arquivo = path.join(dir, 'sintetica.xlsx');
    try {
      const linhas = [linhaBase({ ID: UUID_1 }), linhaBase({ ID: UUID_2, Banco: '1' })];
      const ws = XLSX.utils.json_to_sheet(linhas);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Planilha1');
      XLSX.writeFile(wb, arquivo);

      const lidas = lerPlanilha(arquivo);
      assert.equal(lidas.length, 2);
      assert.equal(lidas[0].ID, UUID_1);
      assert.equal(lidas[1].Banco, '1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('relatório — sem PII no stdout / arquivo 0600 fora do git (8.1.4/8.1.5)', () => {
  test('resumoAgregado nunca inclui nome/documento/agência/conta do titular', async () => {
    const relatorio = await processarCarga(
      [linhaBase({ ID: UUID_1 }), linhaBase({ ID: UUID_2, Banco: 'Recargapay S.A.' })],
      {
        buscarEntregadorFn: async () => ({ id: 101 }),
        gravarContaFn: async () => ({ criada: true }),
        simular: false,
      },
    );
    const resumo = resumoAgregado(relatorio);
    const textoStdout = JSON.stringify(resumo);

    // Nenhum campo de PII pode escapar para o texto que iria para console.log.
    for (const campoProibido of ['Fulano de Tal', CPF_VALIDO, CNPJ_VALIDO, '0001', '123456']) {
      assert.equal(textoStdout.includes(campoProibido), false, `PII vazou no stdout: ${campoProibido}`);
    }
    // Só contadores agregados.
    assert.deepEqual(Object.keys(resumo).sort(), [
      'aceitas', 'criadas', 'jaExistentes', 'modo', 'recusadas', 'semEntregador', 'totalLinhas',
    ].sort());
  });

  test('gravarRelatorio grava o arquivo com permissão 0600', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carga-contas-relatorio-'));
    const arquivo = path.join(dir, 'sub', 'relatorio.json');
    try {
      gravarRelatorio({ ok: true }, arquivo);
      const stat = fs.statSync(arquivo);
      assert.equal(stat.mode & 0o777, 0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
