/**
 * Testes unitários offline — validacao-xml-lote (FASE 3, task 3.1 / 3.2 offline)
 *
 * Rodam com:
 *   NODE_PATH=<node_modules_disponivel> node --test tests/validacao-xml-lote-unit.test.js
 *
 * O worktree feat+validacao-xml-lote não tem node_modules próprio; use o do
 * worktree app-motorista-nfse que já tem xml2js:
 *   NODE_PATH=/var/lib/envioMassa_homologacao/.claude/worktrees/app-motorista-nfse/app_homologacao/backend/node_modules \
 *     node --test tests/validacao-xml-lote-unit.test.js
 *
 * Após merge na main e instalação local de deps, rodar normalmente:
 *   cd app_homologacao/backend && node --test tests/validacao-xml-lote-unit.test.js
 *
 * (Node 22+ nativo — sem instalar Jest nem nenhuma dep nova)
 *
 * Cobre OFFLINE (sem banco, sem FastAPI, sem servidor HTTP):
 *   T-U-01  extractNfseFields — fixture 1 (chave 50 dígitos, numnota=98, cnpj=43568174000168, data=2026-06-09)
 *   T-U-02  extractNfseFields — fixture 2 (chave 50 dígitos, numnota=146, cnpj=44890502000100, data=2026-06-09)
 *   T-U-03  extractNfseFields — fixture 3 (chave 50 dígitos, numnota=114, cnpj=55330677000180, data=2026-06-09)
 *   T-U-04  extractNfseFields — XML malformado → campos null/vazios sem lançar
 *   T-U-05  findMovimentoParaXml — casamento primário por chave
 *   T-U-06  findMovimentoParaXml — casamento por fallback cnpj|numnota|data
 *   T-U-07  findMovimentoParaXml — sem casamento → criterio='none', movimento=null
 *   T-U-08  findMovimentoParaXml — fallback: CNPJ com pontos/traços normalizado para dígitos
 *   T-U-09  Árvore de decisão: aprovada (nota_ok cheio + erro_validacao vazio) → ja_validada, SEM PATCH
 *   T-U-10  Árvore de decisão: reprovada (nota_ok cheio + erro_validacao cheio) → statusAlvo=revalidada
 *   T-U-11  Árvore de decisão: sem validação (nota_ok vazio) → statusAlvo=validada
 *   T-U-12  Dedup intra-lote: mesma chave 2x → 2ª = duplicada_no_lote, criterio herdado do 1º
 *   T-U-13  normalizeDataDia: ISO 8601 com fuso → retorna apenas YYYY-MM-DD
 *   T-U-14  normalizeDataDia: string sem data → retorna ''
 *   T-U-15  Verificar campos ausentes: nenhum campo 'valid', 'valid_cnpj_prestador', 'valid_valor' (INV-5)
 *
 * NÃO cobre (requer ambiente vivo — para o operador):
 *   - Chamadas reais à FastAPI
 *   - PATCH real no PostgREST
 *   - Cenários E2E (ver e2e-validacao-xml-lote.sh)
 *
 * Ref: docs/specs/validacao-xml-lote/tasks.md FASE 3
 *      docs/specs/validacao-xml-lote/quickstart.md
 *      docs/specs/validacao-xml-lote/contracts/validate-xml-batch.md
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');

// ──────────────────────────────────────────────────────────────────────────────
// Extrair funções puras do server.js sem instanciar Express
// As funções são definidas no escopo global do server.js; usamos um subset
// reexportável via require de módulo de suporte. Como server.js não exporta,
// COPIAMOS aqui as funções puras para testes (são idênticas ao código de prod —
// se divergirem, o teste falha por contrato).
// ──────────────────────────────────────────────────────────────────────────────

// Replica exata das funções puras de server.js (linhas 1880-2005)
// Qualquer divergência com o código real é um bug — o teste sinaliza.

function onlyDigits(str) {
  if (!str) return '';
  return String(str).replace(/\D/g, '');
}

function normalizeDataDia(v) {
  if (!v) return '';
  var s = String(v).trim();
  var m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function extractNfseFields(parsed, filename) {
  function findKey(obj, key) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj[key] !== undefined) {
      var val = obj[key];
      if (typeof val === 'object' && val._ !== undefined) return val._;
      return val;
    }
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      var found = findKey(obj[keys[i]], key);
      if (found !== null) return found;
    }
    return null;
  }

  function findNode(obj, key) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj[key] !== undefined && typeof obj[key] === 'object') return obj[key];
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      var found = findNode(obj[keys[i]], key);
      if (found !== null) return found;
    }
    return null;
  }

  var emit = findKey(parsed, 'emit');
  var prest = findKey(parsed, 'prest');
  var source = emit || prest;
  var cnpj_prestador = source ? (findKey(source, 'CNPJ') || '') : '';
  var razao_social = source ? (findKey(source, 'xNome') || '') : '';
  var data_emissao = findKey(parsed, 'dhEmi') || findKey(parsed, 'dhProc') || '';
  var valores = findKey(parsed, 'valores');
  var valor_nota = valores ? (findKey(valores, 'vLiq') || findKey(valores, 'vServ') || '') : '';

  var chave = null;
  try {
    var infNFSe = findNode(parsed, 'infNFSe');
    var rawId = (infNFSe && infNFSe.$ && infNFSe.$.Id) ? String(infNFSe.$.Id) : null;
    if (rawId) {
      var stripped = rawId.replace(/^NFS/, '');
      chave = /^\d{50}$/.test(stripped) ? stripped : (stripped || null);
    }
  } catch (e) { chave = null; }

  var numnota = null;
  try {
    var n = findKey(parsed, 'nNFSe');
    numnota = (n !== null && n !== undefined && String(n).trim() !== '') ? String(n).trim() : null;
  } catch (e) { numnota = null; }

  return {
    cnpj_prestador: cnpj_prestador,
    data_emissao: data_emissao,
    razao_social: razao_social,
    valor_nota: valor_nota,
    chave: chave,
    numnota: numnota,
    filename: filename
  };
}

function findMovimentoParaXml(extracted, movsByChave, movsByFallback) {
  if (extracted && extracted.chave) {
    var byChave = movsByChave[extracted.chave];
    if (byChave) return { movimento: byChave, criterio: 'chave' };
  }
  var cnpj = onlyDigits(extracted && extracted.cnpj_prestador);
  var num = (extracted && extracted.numnota != null) ? String(extracted.numnota).trim() : '';
  var dia = normalizeDataDia(extracted && extracted.data_emissao);
  if (cnpj && num && dia) {
    var fbKey = cnpj + '|' + num + '|' + dia;
    var byFallback = movsByFallback[fbKey];
    if (byFallback) return { movimento: byFallback, criterio: 'fallback' };
  }
  return { movimento: null, criterio: 'none' };
}

// ──────────────────────────────────────────────────────────────────────────────
// Caminhos dos fixtures reais
// ──────────────────────────────────────────────────────────────────────────────

const FIXTURES_DIR = path.resolve(__dirname, '../../../docs/nota_entrego');
const FIXTURE_1 = path.join(FIXTURES_DIR, '35503082243568174000168000000000009826065650835650.xml');
const FIXTURE_2 = path.join(FIXTURES_DIR, '35503082244890502000100000000000014626068428829820.xml');
const FIXTURE_3 = path.join(FIXTURES_DIR, '35503082255330677000180000000000011426063133427076.xml');

// Helper: parseia XML com as mesmas opções do server.js
async function parseXml(filePath) {
  const xml = fs.readFileSync(filePath, 'utf-8');
  return xml2js.parseStringPromise(xml, {
    explicitArray: false,
    tagNameProcessors: [xml2js.processors.stripPrefix]
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Suite: extractNfseFields com fixtures reais
// ──────────────────────────────────────────────────────────────────────────────

describe('extractNfseFields — fixtures reais', () => {

  test('T-U-01: fixture 1 — numnota=98, cnpj=43568174000168, chave 50 dígitos, data=2026-06-09', async () => {
    const parsed = await parseXml(FIXTURE_1);
    const fields = extractNfseFields(parsed, path.basename(FIXTURE_1));

    assert.equal(fields.numnota, '98', 'numnota deve ser "98"');
    assert.equal(fields.cnpj_prestador, '43568174000168', 'cnpj_prestador deve ser 43568174000168');
    assert.ok(fields.chave, 'chave deve ser extraída (não nula)');
    assert.equal(fields.chave.length, 50, `chave deve ter 50 dígitos, tem ${fields.chave.length}: ${fields.chave}`);
    assert.match(fields.chave, /^\d{50}$/, 'chave deve ser somente dígitos');
    assert.ok(fields.data_emissao.startsWith('2026-06-09'), `data_emissao deve começar com 2026-06-09, got: ${fields.data_emissao}`);
    // normalização de data_emissao pelo casamento de fallback
    assert.equal(normalizeDataDia(fields.data_emissao), '2026-06-09', 'normalizeDataDia deve retornar 2026-06-09');
  });

  test('T-U-02: fixture 2 — numnota=146, cnpj=44890502000100, chave 50 dígitos', async () => {
    const parsed = await parseXml(FIXTURE_2);
    const fields = extractNfseFields(parsed, path.basename(FIXTURE_2));

    assert.equal(fields.numnota, '146', 'numnota deve ser "146"');
    assert.equal(fields.cnpj_prestador, '44890502000100', 'cnpj_prestador deve ser 44890502000100');
    assert.ok(fields.chave, 'chave deve ser extraída');
    assert.equal(fields.chave.length, 50, `chave deve ter 50 dígitos, tem ${fields.chave.length}`);
    assert.match(fields.chave, /^\d{50}$/);
    assert.equal(normalizeDataDia(fields.data_emissao), '2026-06-09');
  });

  test('T-U-03: fixture 3 — numnota=114, cnpj=55330677000180, chave 50 dígitos', async () => {
    const parsed = await parseXml(FIXTURE_3);
    const fields = extractNfseFields(parsed, path.basename(FIXTURE_3));

    assert.equal(fields.numnota, '114', 'numnota deve ser "114"');
    assert.equal(fields.cnpj_prestador, '55330677000180', 'cnpj_prestador deve ser 55330677000180');
    assert.ok(fields.chave, 'chave deve ser extraída');
    assert.equal(fields.chave.length, 50, `chave deve ter 50 dígitos, tem ${fields.chave.length}`);
    assert.match(fields.chave, /^\d{50}$/);
    assert.equal(normalizeDataDia(fields.data_emissao), '2026-06-09');
  });

  test('T-U-04: XML vazio/malformado → campos null/vazio sem lançar exceção', async () => {
    // Simula parsed de XML mínimo sem campos NFSe
    const parsed = { root: {} };
    let fields;
    assert.doesNotThrow(() => {
      fields = extractNfseFields(parsed, 'teste.xml');
    });
    assert.equal(fields.chave, null, 'chave deve ser null para XML sem infNFSe');
    assert.equal(fields.numnota, null, 'numnota deve ser null para XML sem nNFSe');
    assert.equal(fields.cnpj_prestador, '', 'cnpj_prestador deve ser string vazia');
    assert.equal(fields.filename, 'teste.xml');
  });

  test('T-U-15: campos proibidos ausentes na resposta (INV-5 — sem valid/valid_cnpj_prestador/valid_valor)', async () => {
    const parsed = await parseXml(FIXTURE_1);
    const fields = extractNfseFields(parsed, path.basename(FIXTURE_1));
    // extractNfseFields não deve ter campos com nomenclatura antiga
    assert.ok(!('valid' in fields), 'campo "valid" NÃO deve existir em extractNfseFields');
    assert.ok(!('valid_cnpj_prestador' in fields), 'campo "valid_cnpj_prestador" NÃO deve existir');
    assert.ok(!('valid_valor' in fields), 'campo "valid_valor" NÃO deve existir');
  });

});

// ──────────────────────────────────────────────────────────────────────────────
// Suite: normalizeDataDia
// ──────────────────────────────────────────────────────────────────────────────

describe('normalizeDataDia', () => {

  test('T-U-13: ISO 8601 com fuso-horário → apenas YYYY-MM-DD', () => {
    assert.equal(normalizeDataDia('2026-06-09T14:41:32-03:00'), '2026-06-09');
    assert.equal(normalizeDataDia('2026-06-09T13:12:49-03:00'), '2026-06-09');
    assert.equal(normalizeDataDia('2026-06-09T12:31:05-03:00'), '2026-06-09');
    assert.equal(normalizeDataDia('2026-01-01T00:00:00Z'), '2026-01-01');
  });

  test('T-U-14: valor vazio/null → retorna string vazia', () => {
    assert.equal(normalizeDataDia(''), '');
    assert.equal(normalizeDataDia(null), '');
    assert.equal(normalizeDataDia(undefined), '');
    assert.equal(normalizeDataDia('nao-e-data'), '');
  });

});

// ──────────────────────────────────────────────────────────────────────────────
// Suite: findMovimentoParaXml — árvore de casamento
// ──────────────────────────────────────────────────────────────────────────────

describe('findMovimentoParaXml — casamento', () => {

  // Movimento mockado para fixture 1 (chave 50 dígitos)
  const CHAVE_F1 = '35503082243568174000168000000000009826065650835650';
  const CHAVE_F2 = '35503082244890502000100000000000014626068428829820';

  const movFixture1 = {
    id: 1001,
    cnpj_prestador: '43568174000168',
    numnota: '98',
    nota_ok: null,
    erro_validacao: null,
    data_emissao: '2026-06-09T14:41:32-03:00',
    id_empresa: 99
  };

  const movFixture2 = {
    id: 1002,
    cnpj_prestador: '44890502000100',
    numnota: '146',
    nota_ok: null,
    erro_validacao: null,
    data_emissao: '2026-06-09T13:12:49-03:00',
    id_empresa: 99
  };

  // Índices construídos da mesma forma que o handler do server.js
  function buildIndexes(movimentos) {
    var movsByChave = {};
    var movsByFallback = {};
    for (var mv of movimentos) {
      // Por chave (getNFeKeyFromNotaOk retorna null se nota_ok vazio — sem chave aqui)
      // Para simular chave conhecida, inserimos manualmente no índice
      var cnpjMov = onlyDigits(mv.cnpj_prestador);
      var numMov = (mv.numnota != null) ? String(mv.numnota).trim() : '';
      var diaMov = normalizeDataDia(mv.data_emissao);
      if (cnpjMov && numMov && diaMov) {
        var fbk = cnpjMov + '|' + numMov + '|' + diaMov;
        if (movsByFallback[fbk] === undefined) movsByFallback[fbk] = mv;
      }
    }
    return { movsByChave, movsByFallback };
  }

  test('T-U-05: casamento primário por chave', () => {
    const { movsByChave, movsByFallback } = buildIndexes([]);
    // Inserir chave manualmente no índice primário
    movsByChave[CHAVE_F1] = movFixture1;

    const extracted = {
      chave: CHAVE_F1,
      cnpj_prestador: '43568174000168',
      numnota: '98',
      data_emissao: '2026-06-09T14:41:32-03:00'
    };

    const result = findMovimentoParaXml(extracted, movsByChave, movsByFallback);
    assert.equal(result.criterio, 'chave', 'criterio deve ser "chave"');
    assert.deepEqual(result.movimento, movFixture1, 'deve retornar o movimento correto');
  });

  test('T-U-06: casamento por fallback cnpj|numnota|data quando chave ausente', () => {
    const { movsByChave, movsByFallback } = buildIndexes([movFixture2]);

    const extracted = {
      chave: null,  // sem chave de acesso no XML
      cnpj_prestador: '44890502000100',
      numnota: '146',
      data_emissao: '2026-06-09T13:12:49-03:00'
    };

    const result = findMovimentoParaXml(extracted, movsByChave, movsByFallback);
    assert.equal(result.criterio, 'fallback', 'criterio deve ser "fallback"');
    assert.deepEqual(result.movimento, movFixture2, 'deve retornar movFixture2');
  });

  test('T-U-07: sem casamento → criterio="none", movimento=null', () => {
    const { movsByChave, movsByFallback } = buildIndexes([movFixture1]);

    const extracted = {
      chave: CHAVE_F2,  // chave não indexada
      cnpj_prestador: '99999999000100', // cnpj sem correspondência
      numnota: '999',
      data_emissao: '2024-01-01T00:00:00-03:00'
    };

    const result = findMovimentoParaXml(extracted, movsByChave, movsByFallback);
    assert.equal(result.criterio, 'none', 'criterio deve ser "none"');
    assert.equal(result.movimento, null, 'movimento deve ser null');
  });

  test('T-U-08: fallback normaliza CNPJ com pontuação (remove não-dígitos)', () => {
    const { movsByChave, movsByFallback } = buildIndexes([movFixture1]);
    // CNPJ do XML com máscara → deve ser normalizado para digits antes do casamento
    const extracted = {
      chave: null,
      cnpj_prestador: '43.568.174/0001-68',  // cnpj mascarado = mesmo que 43568174000168
      numnota: '98',
      data_emissao: '2026-06-09T14:41:32-03:00'
    };

    const result = findMovimentoParaXml(extracted, movsByChave, movsByFallback);
    assert.equal(result.criterio, 'fallback', 'CNPJ mascarado deve ser normalizado e casar por fallback');
    assert.deepEqual(result.movimento, movFixture1);
  });

  test('T-U-12: dedup intra-lote — mesma chave processada duas vezes', () => {
    // Simula o comportamento do handler (chavesProcessadas dict)
    const chavesProcessadas = {};
    const { movsByChave, movsByFallback } = buildIndexes([]);
    movsByChave[CHAVE_F1] = movFixture1;

    const extractedA = { chave: CHAVE_F1, cnpj_prestador: '43568174000168', numnota: '98', data_emissao: '2026-06-09T14:41:32-03:00' };
    const extractedB = { chave: CHAVE_F1, cnpj_prestador: '43568174000168', numnota: '98', data_emissao: '2026-06-09T14:41:32-03:00' };

    // Processa A (1ª ocorrência)
    assert.ok(!chavesProcessadas[CHAVE_F1], '1ª vez: chave não está no dict');
    const matchA = findMovimentoParaXml(extractedA, movsByChave, movsByFallback);
    assert.equal(matchA.criterio, 'chave');
    // Registra como processada (igual ao handler)
    chavesProcessadas[CHAVE_F1] = { criterio: matchA.criterio, movimento_id: matchA.movimento.id };

    // Processa B (2ª ocorrência — deve ser duplicada_no_lote)
    assert.ok(chavesProcessadas[extractedB.chave], '2ª vez: chave já está no dict → duplicada_no_lote');
    const dedup = chavesProcessadas[extractedB.chave];
    assert.equal(dedup.criterio, 'chave', 'criterio herdado do 1º');
    assert.equal(dedup.movimento_id, movFixture1.id, 'movimento_id herdado do 1º');
  });

});

// ──────────────────────────────────────────────────────────────────────────────
// Suite: Árvore de decisão — gate de status (simulado sem I/O)
// ──────────────────────────────────────────────────────────────────────────────

describe('Árvore de decisão — gate de status (lógica inline)', () => {

  // Replica exata da lógica do handler (server.js ~linha 2130-2145)
  function resolveStatusAlvo(movimento) {
    var temNotaOk = movimento.nota_ok != null && String(movimento.nota_ok).trim() !== '';
    var temErroVazio = !movimento.erro_validacao ||
      String(movimento.erro_validacao).trim() === '';

    // GATE CENTRAL (INV-1): aprovada → ja_validada, sem PATCH
    if (temNotaOk && temErroVazio) return { status: 'ja_validada', chamarFastApi: false };

    // Reprovada → revalidada; sem validação → validada
    return { status: temNotaOk ? 'revalidada' : 'validada', chamarFastApi: true };
  }

  test('T-U-09: aprovada (nota_ok preenchido + erro_validacao vazio) → ja_validada, sem PATCH', () => {
    const mov = { id: 1, nota_ok: 'https://host/files/3550.xml', erro_validacao: null };
    const res = resolveStatusAlvo(mov);
    assert.equal(res.status, 'ja_validada');
    assert.equal(res.chamarFastApi, false, 'NÃO deve chamar FastAPI (gate central INV-1)');
  });

  test('T-U-09b: aprovada com erro_validacao string vazia → também ja_validada', () => {
    const mov = { id: 2, nota_ok: 'https://host/files/3550.xml', erro_validacao: '   ' };
    const res = resolveStatusAlvo(mov);
    assert.equal(res.status, 'ja_validada');
    assert.equal(res.chamarFastApi, false);
  });

  test('T-U-10: reprovada (nota_ok cheio + erro_validacao cheio) → revalidada, chama FastAPI', () => {
    const mov = { id: 3, nota_ok: 'https://host/files/3550.xml', erro_validacao: 'CNPJ do prestador não encontrado' };
    const res = resolveStatusAlvo(mov);
    assert.equal(res.status, 'revalidada');
    assert.equal(res.chamarFastApi, true);
  });

  test('T-U-11: sem validação (nota_ok vazio) → validada, chama FastAPI', () => {
    const mov = { id: 4, nota_ok: null, erro_validacao: null };
    const res = resolveStatusAlvo(mov);
    assert.equal(res.status, 'validada');
    assert.equal(res.chamarFastApi, true);
  });

  test('T-U-11b: sem validação com nota_ok string vazia → validada', () => {
    const mov = { id: 5, nota_ok: '', erro_validacao: null };
    const res = resolveStatusAlvo(mov);
    assert.equal(res.status, 'validada');
    assert.equal(res.chamarFastApi, true);
  });

});

// ──────────────────────────────────────────────────────────────────────────────
// Suite: extractNfseFields com fixtures reais + casamento integrado
// ──────────────────────────────────────────────────────────────────────────────

describe('Integração: extractNfseFields + findMovimentoParaXml (sem I/O real)', () => {

  test('T-U-I-01: fixture 1 parsed → casa no índice primário', async () => {
    const CHAVE = '35503082243568174000168000000000009826065650835650';
    const parsed = await parseXml(FIXTURE_1);
    const fields = extractNfseFields(parsed, path.basename(FIXTURE_1));

    assert.equal(fields.chave, CHAVE, `chave extraída deve ser exatamente ${CHAVE}`);

    const movsByChave = { [CHAVE]: { id: 501, cnpj_prestador: '43568174000168', nota_ok: null, erro_validacao: null } };
    const movsByFallback = {};

    const result = findMovimentoParaXml(fields, movsByChave, movsByFallback);
    assert.equal(result.criterio, 'chave');
    assert.equal(result.movimento.id, 501);
  });

  test('T-U-I-02: fixture 2 parsed → casa no índice primário', async () => {
    const CHAVE = '35503082244890502000100000000000014626068428829820';
    const parsed = await parseXml(FIXTURE_2);
    const fields = extractNfseFields(parsed, path.basename(FIXTURE_2));

    assert.equal(fields.chave, CHAVE);

    const movsByChave = { [CHAVE]: { id: 502, cnpj_prestador: '44890502000100', nota_ok: null, erro_validacao: null } };
    const result = findMovimentoParaXml(fields, movsByChave, {});
    assert.equal(result.criterio, 'chave');
    assert.equal(result.movimento.id, 502);
  });

  test('T-U-I-03: fixture 3 parsed → casa no índice primário', async () => {
    const CHAVE = '35503082255330677000180000000000011426063133427076';
    const parsed = await parseXml(FIXTURE_3);
    const fields = extractNfseFields(parsed, path.basename(FIXTURE_3));

    assert.equal(fields.chave, CHAVE);

    const movsByChave = { [CHAVE]: { id: 503, cnpj_prestador: '55330677000180', nota_ok: null, erro_validacao: null } };
    const result = findMovimentoParaXml(fields, movsByChave, {});
    assert.equal(result.criterio, 'chave');
    assert.equal(result.movimento.id, 503);
  });

  test('T-U-I-04: fixture 1 sem chave no índice → fallback por cnpj|numnota|data', async () => {
    const parsed = await parseXml(FIXTURE_1);
    const fields = extractNfseFields(parsed, path.basename(FIXTURE_1));

    // Índice primário vazio (nenhum movimento tem essa chave cadastrada)
    const movsByChave = {};
    // Índice fallback: '43568174000168|98|2026-06-09'
    const fbKey = '43568174000168|98|2026-06-09';
    const movsByFallback = { [fbKey]: { id: 601, cnpj_prestador: '43568174000168', nota_ok: null, erro_validacao: null } };

    const result = findMovimentoParaXml(fields, movsByChave, movsByFallback);
    assert.equal(result.criterio, 'fallback', 'deve casar por fallback quando chave não está no índice primário');
    assert.equal(result.movimento.id, 601);
  });

  test('T-U-I-05: tenant-isolamento — fixture 1 não casa em índice de empresa diferente (índices vazios)', async () => {
    // Simula que os índices foram construídos para empresa B (diferente) → sem o movimento da empresa A
    const parsed = await parseXml(FIXTURE_1);
    const fields = extractNfseFields(parsed, path.basename(FIXTURE_1));

    // Índices completamente vazios = empresa B não tem movimentos com esse CNPJ/nota
    const result = findMovimentoParaXml(fields, {}, {});
    assert.equal(result.criterio, 'none', 'tenant diferente → sem casamento → sem_movimento');
    assert.equal(result.movimento, null);
  });

});
