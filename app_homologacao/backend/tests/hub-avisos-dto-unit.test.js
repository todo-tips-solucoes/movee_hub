/**
 * Testes unitários — lib/hub-avisos-dto.js (tasks.md FASE 2, 2.1.3).
 * Rodam com: node --test tests/hub-avisos-dto-unit.test.js
 *
 * Cobre `validarAviso`: título/corpo (limites + caracteres de controle
 * Unicode `Cc`/`Cf`, incluindo bidi), `modoDestinatarios`, `destinatariosIds`
 * condicional ao modo, `chaveIdempotencia` (UUID) e o teto de 1.024 bytes
 * UTF-8 do payload do push (contracts/hub-avisos.md).
 *
 * Caracteres de controle/bidi são montados via `String.fromCharCode` (nunca
 * literais no arquivo-fonte) — evita ambiguidade de encoding do próprio
 * arquivo de teste.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  validarAviso, tamanhoPayloadBytes, TITULO_MAX, CORPO_MAX, IDS_MAX,
} = require('../lib/hub-avisos-dto');

const UUID_VALIDO = 'a0b1c2d3-e4f5-4678-9abc-def012345678';

function corpoBase(overrides) {
  return Object.assign(
    {
      titulo: 'Aviso de teste',
      corpo: 'Corpo do aviso de teste',
      modoDestinatarios: 'toda_base',
      destinatariosIds: [],
      chaveIdempotencia: UUID_VALIDO,
    },
    overrides,
  );
}

describe('validarAviso — casos válidos', () => {
  test('toda_base com ids vazio: válido', () => {
    const r = validarAviso(corpoBase());
    assert.equal(r.ok, true);
    assert.equal(r.titulo, 'Aviso de teste');
    assert.equal(r.modoDestinatarios, 'toda_base');
    assert.deepEqual(r.destinatariosIds, []);
    assert.equal(r.chaveIdempotencia, UUID_VALIDO.toLowerCase());
  });

  test('individual com 1 id: válido', () => {
    const r = validarAviso(corpoBase({ modoDestinatarios: 'individual', destinatariosIds: [42] }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.destinatariosIds, [42]);
  });

  test('empresa com 500 ids (limite superior): válido', () => {
    const ids = Array.from({ length: 500 }, (_, i) => i + 1);
    const r = validarAviso(corpoBase({ modoDestinatarios: 'empresa', destinatariosIds: ids }));
    assert.equal(r.ok, true);
  });

  test('título/corpo com trim aplicado', () => {
    const r = validarAviso(corpoBase({ titulo: '  Com espaco  ', corpo: '  Corpo  ' }));
    assert.equal(r.ok, true);
    assert.equal(r.titulo, 'Com espaco');
    assert.equal(r.corpo, 'Corpo');
  });
});

describe('validarAviso — título', () => {
  test('título vazio: DADOS_INVALIDOS motivo titulo', () => {
    const r = validarAviso(corpoBase({ titulo: '' }));
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'DADOS_INVALIDOS');
    assert.equal(r.motivo, 'titulo');
  });

  test('título só espaços: DADOS_INVALIDOS motivo titulo', () => {
    const r = validarAviso(corpoBase({ titulo: '   ' }));
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'titulo');
  });

  test(`título com ${TITULO_MAX + 1} chars: CONTEUDO_EXCEDE_LIMITE`, () => {
    const r = validarAviso(corpoBase({ titulo: 'a'.repeat(TITULO_MAX + 1) }));
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'CONTEUDO_EXCEDE_LIMITE');
  });

  test(`título com exatos ${TITULO_MAX} chars: válido`, () => {
    const r = validarAviso(corpoBase({ titulo: 'a'.repeat(TITULO_MAX) }));
    assert.equal(r.ok, true);
  });

  test('título com caractere de controle Cc (U+0007 BEL): DADOS_INVALIDOS', () => {
    const titulo = `Aviso${String.fromCharCode(0x0007)}ruim`;
    const r = validarAviso(corpoBase({ titulo }));
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'DADOS_INVALIDOS');
    assert.equal(r.motivo, 'titulo');
  });

  test('título com U+202E (RLO, bidi): DADOS_INVALIDOS', () => {
    const titulo = `Aviso${String.fromCharCode(0x202e)}ruim`;
    const r = validarAviso(corpoBase({ titulo }));
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'titulo');
  });

  test('título com U+2066 (LRI, bidi): DADOS_INVALIDOS', () => {
    const titulo = `Aviso${String.fromCharCode(0x2066)}ruim`;
    const r = validarAviso(corpoBase({ titulo }));
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'titulo');
  });
});

describe('validarAviso — corpo', () => {
  test(`corpo com ${CORPO_MAX + 1} chars: CONTEUDO_EXCEDE_LIMITE`, () => {
    const r = validarAviso(corpoBase({ corpo: 'a'.repeat(CORPO_MAX + 1) }));
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'CONTEUDO_EXCEDE_LIMITE');
  });

  test('corpo vazio: DADOS_INVALIDOS motivo corpo', () => {
    const r = validarAviso(corpoBase({ corpo: '' }));
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'corpo');
  });
});

describe('validarAviso — modoDestinatarios', () => {
  test('modo inválido: DADOS_INVALIDOS motivo modo', () => {
    const r = validarAviso(corpoBase({ modoDestinatarios: 'grupo_inexistente' }));
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'DADOS_INVALIDOS');
    assert.equal(r.motivo, 'modo');
  });
});

describe('validarAviso — destinatariosIds', () => {
  test('ids vazio em individual: DADOS_INVALIDOS motivo ids', () => {
    const r = validarAviso(corpoBase({ modoDestinatarios: 'individual', destinatariosIds: [] }));
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'ids');
  });

  test(`ids com ${IDS_MAX + 1} itens: DADOS_INVALIDOS motivo ids`, () => {
    const ids = Array.from({ length: IDS_MAX + 1 }, (_, i) => i + 1);
    const r = validarAviso(corpoBase({ modoDestinatarios: 'individual', destinatariosIds: ids }));
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'ids');
  });

  test('ids não-vazio em toda_base: DADOS_INVALIDOS motivo ids', () => {
    const r = validarAviso(corpoBase({ modoDestinatarios: 'toda_base', destinatariosIds: [1] }));
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'ids');
  });

  test('id não-inteiro em empresa: DADOS_INVALIDOS motivo ids', () => {
    const r = validarAviso(corpoBase({ modoDestinatarios: 'empresa', destinatariosIds: [1.5] }));
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'ids');
  });

  test('id negativo em empresa: DADOS_INVALIDOS motivo ids', () => {
    const r = validarAviso(corpoBase({ modoDestinatarios: 'empresa', destinatariosIds: [-1] }));
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'ids');
  });
});

describe('validarAviso — chaveIdempotencia', () => {
  test('UUID inválido: DADOS_INVALIDOS motivo chave', () => {
    const r = validarAviso(corpoBase({ chaveIdempotencia: 'nao-e-um-uuid' }));
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'DADOS_INVALIDOS');
    assert.equal(r.motivo, 'chave');
  });

  test('chaveIdempotencia ausente: DADOS_INVALIDOS motivo chave', () => {
    const r = validarAviso(corpoBase({ chaveIdempotencia: undefined }));
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'chave');
  });
});

describe('validarAviso — payload do push (≤ 1.024 bytes UTF-8)', () => {
  test('payload dentro do limite com título/corpo no teto de chars (ASCII): válido', () => {
    const r = validarAviso(corpoBase({ titulo: 'a'.repeat(60), corpo: 'b'.repeat(180) }));
    assert.equal(r.ok, true);
  });

  test('pior caso de bytes dentro dos limites de caracteres (3 bytes/char, CJK) fica bem abaixo de 1.024', () => {
    // Dentro dos limites de 60/180 *caracteres* o payload nunca chega perto
    // do teto de bytes (o pior caso, só com caracteres de 3 bytes UTF-8, é
    // ~765) — por isso o teste de estouro (abaixo) exercita
    // `tamanhoPayloadBytes` isoladamente, não via `validarAviso`.
    const r = validarAviso(corpoBase({ titulo: '中'.repeat(60), corpo: '中'.repeat(180) }));
    assert.equal(r.ok, true);
  });
});

describe('tamanhoPayloadBytes — cálculo isolado do tamanho do payload de push', () => {
  test('payload com 1.025 bytes: acima do limite de 1.024', () => {
    const bytes = tamanhoPayloadBytes('a'.repeat(60), 'x'.repeat(920));
    assert.equal(bytes, 1025);
  });

  test('payload com exatos 1.024 bytes: no limite (não excede)', () => {
    const bytes = tamanhoPayloadBytes('a'.repeat(60), 'x'.repeat(919));
    assert.equal(bytes, 1024);
  });
});
