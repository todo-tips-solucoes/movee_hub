const test = require('node:test');
const assert = require('node:assert');
const { mascararEmail, planejarRecuperacao } = require('../lib/motorista-recuperacao-senha');

test.describe('mascararEmail() — o que a tela pode mostrar', () => {
  test('mostra o suficiente para reconhecer a caixa, não para reconstruí-la', () => {
    assert.equal(mascararEmail('fulano.silva@gmail.com'), 'fu***@gm***.com');
    assert.equal(mascararEmail('motorista@empresa.com.br'), 'mo***@em***.com.br');
  });

  // Com o ÚLTIMO ponto, "b.com.br" viraria "b.***.br" — confunde mais do que
  // esconde. O primeiro ponto mantém o domínio legível.
  test('domínio com dois níveis fica legível', () => {
    assert.equal(mascararEmail('a@b.com.br'), 'a***@b***.com.br');
  });

  test('pedaço curto revela só 1 caractere — metade de 3 letras não mascara nada', () => {
    assert.equal(mascararEmail('ab@x.com'), 'a***@x***.com');
    assert.equal(mascararEmail('abc@xyz.com'), 'a***@x***.com');
    assert.equal(mascararEmail('abcd@wxyz.com'), 'ab***@wx***.com');
  });

  test('normaliza antes de mascarar (o cadastro pode ter vindo torto)', () => {
    assert.equal(mascararEmail('  Fulano@GMAIL.com '), 'fu***@gm***.com');
  });

  test('entrada inválida vira null, nunca uma máscara falsa', () => {
    for (const ruim of ['invalido', 'x@y', '@x.com', 'a@', '', null, undefined]) {
      assert.equal(mascararEmail(ruim), null, `deveria recusar: ${JSON.stringify(ruim)}`);
    }
  });

  // A máscara não pode deixar escapar o comprimento do endereço: um usuário de
  // 3 e outro de 30 letras têm de sair com a mesma forma.
  test('não vaza o comprimento do endereço', () => {
    const curto = mascararEmail('abcd@wxyz.com');
    const longo = mascararEmail('abcdefghijklmnopqrst@wxyzabcdefgh.com');
    assert.equal(curto.length, longo.length);
  });
});

test.describe('planejarRecuperacao() — quem recebe e-mail', () => {
  const conta = (over = {}) => ({ id: 1, email: 'fulano@gmail.com', ativo: true, ...over });

  test('conta com e-mail: envia e devolve a máscara', () => {
    const r = planejarRecuperacao(conta());
    assert.equal(r.enviar, true);
    assert.equal(r.emailMascarado, 'fu***@gm***.com');
    assert.equal(r.motivo, null);
  });

  test('CNPJ inexistente: não envia, e o motivo fica para a auditoria', () => {
    const r = planejarRecuperacao(null);
    assert.equal(r.enviar, false);
    assert.equal(r.motivo, 'CNPJ_NAO_ENCONTRADO');
    assert.equal(r.emailMascarado, null);
  });

  // 242 das 1.456 contas estavam nesta situação quando isto foi escrito.
  test('conta sem e-mail: não envia, motivo SEM_EMAIL (o hub vai saber e cadastrar)', () => {
    for (const vazio of [null, '', '   ']) {
      const r = planejarRecuperacao(conta({ email: vazio }));
      assert.equal(r.enviar, false);
      assert.equal(r.motivo, 'SEM_EMAIL');
    }
  });

  test('conta desativada não recupera senha', () => {
    const r = planejarRecuperacao(conta({ ativo: false }));
    assert.equal(r.enviar, false);
    assert.equal(r.motivo, 'CONTA_INATIVA');
  });

  test('e-mail corrompido no cadastro cai em SEM_EMAIL, não quebra', () => {
    const r = planejarRecuperacao(conta({ email: 'isto-nao-e-email' }));
    assert.equal(r.enviar, false);
    assert.equal(r.motivo, 'SEM_EMAIL');
  });
});
