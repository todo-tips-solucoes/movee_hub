// impeccable r24 parte 2 — o que precisa de teste nas metas é a UNIDADE.
// Aceitação/conclusão chegam como fração 0..1 e tempo disponível como
// percentual 0..100; comparar sem converter erra por fator 100 e o erro é
// silencioso (aprova ou reprova a operação inteira sem mensagem nenhuma).
const test = require('node:test');
const assert = require('node:assert');
const {
  INDICADORES,
  TAMANHO_MAX_TEXTO,
  canonizarTexto,
  validarMeta,
  chaveMeta,
} = require('../lib/hub-performance-meta');




test('validarMeta: aceita meta bem formada e canoniza', () => {
  const r = validarMeta({ praca: '  SAO PAULO ', periodo: ' ALMOCO ', indicador: 'aceitacao', valor: 0.9 });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.meta, {
    praca: 'SAO PAULO',
    periodo: 'ALMOCO',
    indicador: 'aceitacao',
    valor: 0.9,
  });
});

test('validarMeta: 90 no lugar de 0.9 é barrado com erro próprio', () => {
  const r = validarMeta({ praca: 'SP', periodo: 'ALMOCO', indicador: 'aceitacao', valor: 90 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.erro, 'VALOR_FORA_DA_FAIXA');
});

test('validarMeta: campos obrigatórios e indicador fora do enum', () => {
  assert.strictEqual(validarMeta({ periodo: 'A', indicador: 'aceitacao', valor: 0.5 }).erro, 'PRACA_OBRIGATORIA');
  assert.strictEqual(validarMeta({ praca: 'SP', indicador: 'aceitacao', valor: 0.5 }).erro, 'PERIODO_OBRIGATORIO');
  assert.strictEqual(validarMeta({ praca: 'SP', periodo: 'A', indicador: 'x', valor: 0.5 }).erro, 'INDICADOR_INVALIDO');
  assert.strictEqual(validarMeta({ praca: 'SP', periodo: 'A', indicador: 'aceitacao', valor: 'x' }).erro, 'VALOR_INVALIDO');
  assert.strictEqual(validarMeta(null).erro, 'META_INVALIDA');
});


test('chaveMeta: caixa, espaço interno e forma Unicode não criam cruzamentos distintos', () => {
  assert.strictEqual(chaveMeta(' SAO PAULO ', 'Almoco', 'aceitacao'), chaveMeta('sao paulo', 'ALMOCO', 'aceitacao'));
  assert.strictEqual(chaveMeta('SAO   PAULO', 'A', 'x'), chaveMeta('SAO PAULO', 'A', 'x'));
  // O caso mudo: NFD (planilha do macOS) vs NFC, visualmente idênticos.
  assert.strictEqual(chaveMeta('MOÓCA'.normalize('NFD'), 'A', 'x'), chaveMeta('MOÓCA'.normalize('NFC'), 'A', 'x'));
});

// A unique da 0048 é byte-exata; a chave normalizava caixa. Isso produzia DUAS
// linhas para um cruzamento e UMA chave na tela, com a última vencendo em
// silêncio — reproduzido contra o ambiente real. Gravar a forma canônica é o
// que faz as duas coisas voltarem a concordar.
test('validarMeta grava a forma CANÔNICA, a mesma que a chave usa', () => {
  const r = validarMeta({ praca: ' Sao  Paulo ', periodo: 'Almoco', indicador: 'aceitacao', valor: 0.9 });
  assert.strictEqual(r.meta.praca, 'SAO PAULO');
  assert.strictEqual(r.meta.periodo, 'ALMOCO');
  assert.strictEqual(
    chaveMeta(r.meta.praca, r.meta.periodo, 'aceitacao'),
    chaveMeta('SAO PAULO', 'ALMOCO', 'aceitacao')
  );
});

test('validarMeta barra texto acima do teto (auditoria imutável, unique sem fim)', () => {
  assert.strictEqual(validarMeta({ praca: 'x'.repeat(TAMANHO_MAX_TEXTO + 1), periodo: 'A', indicador: 'aceitacao', valor: 0.5 }).erro, 'PRACA_MUITO_LONGA');
  assert.strictEqual(validarMeta({ praca: 'A', periodo: 'x'.repeat(TAMANHO_MAX_TEXTO + 1), indicador: 'aceitacao', valor: 0.5 }).erro, 'PERIODO_MUITO_LONGO');
});

test('canonizarTexto: entrada não-string vira vazio, nunca "undefined"', () => {
  assert.strictEqual(canonizarTexto(undefined), '');
  assert.strictEqual(canonizarTexto(null), '');
  assert.strictEqual(canonizarTexto(42), '');
});

test('chaveMeta: acento distingue, porque praças podem se distinguir por ele', () => {
  assert.notStrictEqual(chaveMeta('MOOCA', 'A', 'aceitacao'), chaveMeta('MOÓCA', 'A', 'aceitacao'));
});




test('INDICADORES é o contrato fechado da migration 0048', () => {
  assert.deepStrictEqual([...INDICADORES], ['aceitacao', 'conclusao', 'tempo_disponivel']);
});
