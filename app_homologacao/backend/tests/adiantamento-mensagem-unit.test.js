const test = require('node:test');
const assert = require('node:assert');
const { renderizarMensagem, placeholdersInvalidos } = require('../lib/adiantamento-mensagem');

const MOTORISTA = {
  nome: 'Fulano de Tal', valor: 1234.5, gorjeta: 15, total: 1249.5,
  periodoInicio: '2026-09-21', periodoFim: '2026-09-27',
};

test.describe('renderizarMensagem() — molde da mensagem do movimento (F4)', () => {
  test('interpola os seis placeholders, com dinheiro e data em pt-BR', () => {
    assert.equal(
      renderizarMensagem('Ola {nome}, nota {valor} + gorjeta {gorjeta} = {total} ({periodo_inicio} a {periodo_fim})', MOTORISTA),
      'Ola Fulano de Tal, nota 1.234,50 + gorjeta 15,00 = 1.249,50 (21/09/2026 a 27/09/2026)'
    );
  });

  test('molde sem placeholder nenhum passa intacto', () => {
    assert.equal(renderizarMensagem('Sua nota esta disponivel.', MOTORISTA), 'Sua nota esta disponivel.');
  });

  // A razão de a whitelist existir: o texto é editável por um operador e vai
  // para o WhatsApp do motorista. Interpolar campo arbitrário vazaria dado.
  test('placeholder fora da whitelist é RECUSADO, não ignorado', () => {
    assert.throws(() => renderizarMensagem('CNPJ {cnpj_prestador}', MOTORISTA),
      /placeholder nao permitido "\{cnpj_prestador\}"/);
  });

  test('gorjeta ausente vira 0,00, não "undefined" no texto do motorista', () => {
    assert.equal(renderizarMensagem('{gorjeta}', { ...MOTORISTA, gorjeta: null }), '0,00');
    assert.equal(renderizarMensagem('{gorjeta}', { ...MOTORISTA, gorjeta: undefined }), '0,00');
  });

  test('molde nulo/indefinido não quebra', () => {
    assert.equal(renderizarMensagem(null, MOTORISTA), '');
    assert.equal(renderizarMensagem(undefined, MOTORISTA), '');
  });
});

test.describe('placeholdersInvalidos() — usado no PUT, antes de gravar', () => {
  test('lista só os proibidos, na ordem em que aparecem', () => {
    assert.deepEqual(placeholdersInvalidos('{nome} {cnpj} {valor} {pix}'), ['cnpj', 'pix']);
  });

  test('molde válido devolve lista vazia', () => {
    assert.deepEqual(placeholdersInvalidos('{nome} ganhou {total}'), []);
  });

  // Controle negativo do próprio detector: se ele deixasse de olhar o conteúdo
  // da chave, este caso passaria despercebido.
  test('chave vazia {} também é inválida', () => {
    assert.deepEqual(placeholdersInvalidos('oi {}'), ['']);
  });
});
