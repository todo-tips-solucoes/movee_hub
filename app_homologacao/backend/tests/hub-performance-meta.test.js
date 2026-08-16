// impeccable r24 parte 2 — o que precisa de teste nas metas é a UNIDADE.
// Aceitação/conclusão chegam como fração 0..1 e tempo disponível como
// percentual 0..100; comparar sem converter erra por fator 100 e o erro é
// silencioso (aprova ou reprova a operação inteira sem mensagem nenhuma).
const test = require('node:test');
const assert = require('node:assert');
const {
  INDICADORES,
  normalizarLeitura,
  validarMeta,
  avaliarRegistro,
  razaoInteira,
  chaveMeta,
} = require('../lib/hub-performance-meta');

test('normalizarLeitura: tempo disponível vem em 0..100 e vira fração', () => {
  assert.strictEqual(normalizarLeitura('87.42', 'tempo_disponivel'), 0.8742);
  assert.strictEqual(normalizarLeitura(87.42, 'tempo_disponivel'), 0.8742);
});

test('normalizarLeitura: aceitação/conclusão já são fração e não são divididas', () => {
  assert.strictEqual(normalizarLeitura('0.8333', 'aceitacao'), 0.8333);
  assert.strictEqual(normalizarLeitura('0.9', 'conclusao'), 0.9);
});

test('normalizarLeitura: ausência vira null, nunca 0', () => {
  for (const v of [null, undefined, '', 'abc', NaN]) {
    assert.strictEqual(normalizarLeitura(v, 'aceitacao'), null, `valor ${String(v)}`);
  }
});

test('validarMeta: aceita meta bem formada e apara espaços', () => {
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

test('razaoInteira: sem denominador não há razão', () => {
  assert.strictEqual(razaoInteira(10, 0), null);
  assert.strictEqual(razaoInteira(10, null), null);
  assert.strictEqual(razaoInteira(null, 10), null);
  assert.strictEqual(razaoInteira(25, 30), 25 / 30);
});

test('chaveMeta: caixa e espaços não criam cruzamentos distintos', () => {
  assert.strictEqual(chaveMeta(' SAO PAULO ', 'Almoco', 'aceitacao'), chaveMeta('sao paulo', 'ALMOCO', 'aceitacao'));
});

test('chaveMeta: acento distingue, porque praças podem se distinguir por ele', () => {
  assert.notStrictEqual(chaveMeta('MOOCA', 'A', 'aceitacao'), chaveMeta('MOÓCA', 'A', 'aceitacao'));
});

test('avaliarRegistro: compara tempo disponível na unidade certa', () => {
  const registro = {
    praca: 'SP',
    periodo: 'ALMOCO',
    corridasOfertadas: 30,
    corridasAceitas: 25,
    corridasCompletadas: 20,
    tempoDisponivelPct: '80.00',
  };
  const metas = new Map([
    [chaveMeta('SP', 'ALMOCO', 'aceitacao'), 0.9],
    [chaveMeta('SP', 'ALMOCO', 'tempo_disponivel'), 0.75],
  ]);
  const r = avaliarRegistro(registro, metas);

  const aceitacao = r.find((x) => x.indicador === 'aceitacao');
  assert.ok(aceitacao.abaixo, '25/30 = 83% está abaixo da meta de 90%');

  const tempo = r.find((x) => x.indicador === 'tempo_disponivel');
  // 80,00 da API vira 0,80 e supera a meta 0,75. Sem a conversão, 80 > 0,75
  // "passaria" por acidente — e um tempo de 10% também passaria.
  assert.strictEqual(tempo.valor, 0.8);
  assert.strictEqual(tempo.abaixo, false);
});

test('avaliarRegistro: sem meta definida, nenhum julgamento é emitido', () => {
  const registro = {
    praca: 'SP',
    periodo: 'JANTAR',
    corridasOfertadas: 10,
    corridasAceitas: 1,
    corridasCompletadas: 1,
    tempoDisponivelPct: '5.00',
  };
  assert.deepStrictEqual(avaliarRegistro(registro, new Map()), []);
});

test('avaliarRegistro: meta existe mas leitura não — não inventa reprovação', () => {
  const registro = {
    praca: 'SP',
    periodo: 'ALMOCO',
    corridasOfertadas: 0,
    corridasAceitas: 0,
    corridasCompletadas: 0,
    tempoDisponivelPct: null,
  };
  const metas = new Map([[chaveMeta('SP', 'ALMOCO', 'aceitacao'), 0.9]]);
  assert.deepStrictEqual(avaliarRegistro(registro, metas), []);
});

test('INDICADORES é o contrato fechado da migration 0048', () => {
  assert.deepStrictEqual([...INDICADORES], ['aceitacao', 'conclusao', 'tempo_disponivel']);
});
