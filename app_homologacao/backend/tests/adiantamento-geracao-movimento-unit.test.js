const test = require('node:test');
const assert = require('node:assert');
const { planejarGeracao } = require('../lib/adiantamento-geracao-movimento');

const CTX = {
  cnpjTomador: '48904673000100', idEmpresa: 6,
  periodoInicio: '2026-09-21', periodoFim: '2026-09-27',
  mensagem1Modelo: 'Ola {nome}, emita nota de {valor}.',
  mensagem2Modelo: 'Gorjeta {gorjeta}, total {total}.',
};
const conta = (over = {}) => ({ cnpjPrestador: '89000000000100', nome: 'Fulano', telefone: '5511900000001', ...over });
const item = (over = {}) => ({ entregador_id: 1, creditos: '500.00', valor_nota: '480.00', valor_fora_nota: '20.00', ...over });
const planejar = (itens, contas, jaGerados = [], abertos = []) =>
  planejarGeracao(itens, new Map(contas), new Set(jaGerados), new Set(abertos), CTX);

test.describe('planejarGeracao() — o que vira movimento (F4-B)', () => {
  test('caso feliz: valor = base da nota, gorjeta = o que fica fora', () => {
    const { aGerar, recusados } = planejar([item()], [[1, conta()]]);
    assert.equal(recusados.length, 0);
    assert.equal(aGerar.length, 1);
    const l = aGerar[0].linha;
    assert.equal(l.valor, 480);
    assert.equal(l.gorjeta, 20);
    assert.equal(l.cnpj_prestador, '89000000000100');
    assert.equal(l.dt_inicial, '2026-09-21');
    assert.equal(l.enviado, 'off');
    assert.equal(l.mov_fechado, false);
  });

  // O ponto da F4 inteira: a nota NÃO inclui a gorjeta, mas o motorista recebe
  // os dois. Se esta asserção cair, a nota sai pelo valor errado.
  test('a gorjeta NUNCA entra no `valor` da nota', () => {
    const { aGerar } = planejar([item()], [[1, conta()]]);
    assert.equal(aGerar[0].linha.valor, 480);
    assert.notEqual(aGerar[0].linha.valor, 500);
    assert.equal(aGerar[0].linha.valor + aGerar[0].linha.gorjeta, 500);
  });

  test('sem gorjeta, o campo vai NULO — como a planilha grava (CL-002)', () => {
    const { aGerar } = planejar([item({ valor_fora_nota: '0.00' })], [[1, conta()]]);
    assert.equal(aGerar[0].linha.gorjeta, null);
  });

  test('as mensagens saem renderizadas com os valores do motorista', () => {
    const { aGerar } = planejar([item()], [[1, conta()]]);
    assert.equal(aGerar[0].linha.mensagem1, 'Ola Fulano, emita nota de 480,00.');
    assert.equal(aGerar[0].linha.mensagem2, 'Gorjeta 20,00, total 500,00.');
  });

  test('sem telefone GERA assim mesmo, marcado no relatório (decisão do operador)', () => {
    const { aGerar, recusados } = planejar([item()], [[1, conta({ telefone: null })]]);
    assert.equal(recusados.length, 0);
    assert.equal(aGerar[0].semTelefone, true);
    assert.equal(aGerar[0].linha.number, null);
  });
});

test.describe('planejarGeracao() — as recusas, cada uma com motivo próprio', () => {
  test('sem CNPJ no hub', () => {
    const { aGerar, recusados } = planejar([item()], []);
    assert.equal(aGerar.length, 0);
    assert.equal(recusados[0].motivo, 'SEM_CNPJ');
  });

  test('apuração fechada antes de "entra na nota" existir', () => {
    const { recusados } = planejar([item({ valor_nota: null, valor_fora_nota: null })], [[1, conta()]]);
    assert.equal(recusados[0].motivo, 'SEM_DIVISAO');
  });

  test('base da nota zero não vira nota', () => {
    const { recusados } = planejar([item({ valor_nota: '0.00' })], [[1, conta()]]);
    assert.equal(recusados[0].motivo, 'VALOR_ZERO');
  });

  test('já gerado nesta apuração — idempotência', () => {
    const { aGerar, recusados } = planejar([item()], [[1, conta()]], [1]);
    assert.equal(aGerar.length, 0);
    assert.equal(recusados[0].motivo, 'JA_GERADO');
  });

  test('já tem movimento aberto (planilha) — convivência, decisão 7', () => {
    const { aGerar, recusados } = planejar([item()], [[1, conta()]], [], ['89000000000100']);
    assert.equal(aGerar.length, 0);
    assert.equal(recusados[0].motivo, 'MOVIMENTO_ABERTO');
  });

  // A ordem importa: se o hub já gerou e o movimento foi fechado depois, o
  // motivo certo é JA_GERADO. Invertê-la faria a trilha parecer vazia.
  test('já gerado vence movimento aberto no motivo relatado', () => {
    const { recusados } = planejar([item()], [[1, conta()]], [1], ['89000000000100']);
    assert.equal(recusados[0].motivo, 'JA_GERADO');
  });

  test('cada recusa traz nome e explicação legível', () => {
    const { recusados } = planejar([item()], [[1, conta()]], [1]);
    assert.equal(recusados[0].nome, 'Fulano');
    assert.match(recusados[0].detalhe, /já gerou/);
  });
});

// O CNPJ do tomador vem do CADASTRO da empresa (`Empresa.cnpj`), decidido pelo
// operador em 2026-09-23: dado sem lugar de edição é dado que ninguém mantém.
// A F4 nasceu lendo `req.body.cnpjTomador`, que a tela nunca enviou — todo
// movimento sairia sem tomador e a FastAPI reprovaria por `valid_cnpj`.
// Estes testes travam o contrato do lado puro; a origem do valor é da rota.
test.describe('planejarGeracao() — CNPJ do tomador', () => {
  test('o tomador do contexto vai para a linha, sem transformação', () => {
    const { aGerar } = planejar([item()], [[1, conta()]]);
    assert.equal(aGerar[0].linha.cnpj_tomador, '48904673000100');
  });

  // Em produção há DUAS formas do mesmo CNPJ do tomador em uso (só dígitos até
  // out/2025, formatado desde então) e não se sabe como a FastAPI normaliza —
  // então o valor é repassado exatamente como está no cadastro, nunca
  // "arrumado" aqui. Formatar por conta própria seria decidir no escuro.
  test('CNPJ formatado passa intacto — não cabe a esta camada normalizar', () => {
    const ctxFormatado = { ...CTX, cnpjTomador: '48.904.673/0001-00' };
    const { aGerar } = planejarGeracao([item()], new Map([[1, conta()]]), new Set(), new Set(), ctxFormatado);
    assert.equal(aGerar[0].linha.cnpj_tomador, '48.904.673/0001-00');
  });

  test('prestador e tomador são campos DIFERENTES e não se misturam', () => {
    const { aGerar } = planejar([item()], [[1, conta()]]);
    assert.equal(aGerar[0].linha.cnpj_prestador, '89000000000100');  // do motorista (hub)
    assert.equal(aGerar[0].linha.cnpj_tomador, '48904673000100');    // da empresa (hub)
    assert.notEqual(aGerar[0].linha.cnpj_prestador, aGerar[0].linha.cnpj_tomador);
  });
});

// F3 (saldo mínimo carregado): os três casos de research.md Decision 8 —
// retido, pago com saldo carregado, e pré-regra (comportamento de hoje).
test.describe('planejarGeracao() — F3: saldo mínimo carregado', () => {
  test('item retido (valor_pago=0, valor_transportado>0) nunca gera nota', () => {
    const { aGerar, recusados } = planejar(
      [item({ valor_pago: '0.00', valor_transportado: '3.00' })],
      [[1, conta()]],
    );
    assert.equal(aGerar.length, 0);
    assert.equal(recusados[0].motivo, 'RETIDO');
    assert.match(recusados[0].detalhe, /entra no próximo repasse/);
  });

  // O ponto do FR-020: nunca uma nota extra por semana retida — os
  // componentes carregados somam na MESMA nota da semana em que paga.
  test('item pago com saldo carregado soma os componentes numa nota só', () => {
    const { aGerar, recusados } = planejar(
      [item({
        valor_pago: '505.00', valor_transportado: '0.00',
        valor_nota: '480.00', valor_fora_nota: '20.00',
        saldo_anterior_nota: '20.00', saldo_anterior_fora: '5.00',
      })],
      [[1, conta()]],
    );
    assert.equal(recusados.length, 0);
    assert.equal(aGerar[0].linha.valor, 500);   // 480 (semana) + 20 (saldo)
    assert.equal(aGerar[0].linha.gorjeta, 25);  // 20 (semana) + 5 (saldo)
  });

  // item() (default) não define valor_pago/valor_transportado/saldo_anterior_*
  // — é exatamente o shape de um item PRÉ-REGRA (Decision 7: colunas novas
  // NULAS). O caso feliz já cobre isso; aqui deixamos explícito que a F3 não
  // muda esse caminho.
  test('item pré-regra (valor_pago ausente) mantém o comportamento de hoje', () => {
    const { aGerar, recusados } = planejar([item()], [[1, conta()]]);
    assert.equal(recusados.length, 0);
    assert.equal(aGerar[0].linha.valor, 480);
    assert.equal(aGerar[0].linha.gorjeta, 20);
  });

  // Controle negativo (memória "controle negativo pega teste oco"): comentar
  // a checagem de `retido` em lib/adiantamento-geracao-movimento.js faz este
  // teste falhar porque `aGerar.length` vira 1 (o item retido seria
  // indevidamente gerado) — não por um erro de sintaxe/require. Conferido
  // manualmente nesta tarefa (3.7.4): revertendo o bloco `if (retido) {
  // recusar('RETIDO'); continue; }`, a suíte cai exatamente nesta asserção.
  test('sem a checagem de retido, o item retido SERIA gerado (documentação do controle negativo)', () => {
    const { aGerar } = planejar(
      [item({ valor_pago: '0.00', valor_transportado: '3.00' })],
      [[1, conta()]],
    );
    assert.equal(aGerar.length, 0, 'se isto falhar com length=1, a checagem de retido foi removida/quebrada');
  });

  // dec-055/block-008: revisão adversarial da F3 achou uma assimetria — com
  // remanescente NEGATIVO (débito > crédito) e saldo carregado (saldo_anterior
  // >0), `valor_pago=0` e `valor_transportado=saldo_anterior>0` (0098:268) são
  // exatamente o SHAPE de um item retido — mas remanescente<0 nunca teve
  // retenção nenhuma (a produção da semana é consumida pelo débito maior, não
  // "presa esperando o piso"). Decisão do operador: a semana negativa gera a
  // nota da PRÓPRIA produção (valor_nota/valor_fora_nota), sem somar o saldo
  // antigo — que segue carregado intacto (transportado_nota/_fora = saldo_
  // anterior_nota/_fora, 0098:279/284) para a nota em que finalmente pagar.
  test('remanescente negativo com saldo carregado gera a nota da própria semana, sem somar o saldo antigo', () => {
    const { aGerar, recusados } = planejar(
      [item({
        remanescente: '-10.00', valor_pago: '0.00', valor_transportado: '4.00',
        valor_nota: '20.00', valor_fora_nota: '5.00',
        saldo_anterior_nota: '3.00', saldo_anterior_fora: '1.00',
      })],
      [[1, conta()]],
    );
    assert.equal(recusados.length, 0);
    assert.equal(aGerar[0].linha.valor, 20);    // só a produção desta semana
    assert.equal(aGerar[0].linha.gorjeta, 5);   // idem — sem o 1,00 carregado
  });

  // Controle negativo (verificado manualmente nesta tarefa, revertendo a
  // cláusula `&& num(item.remanescente) >= 0` do `retido` numa cópia isolada
  // do módulo — nunca no arquivo versionado): sem ela, este item cai em
  // RETIDO por ter o mesmo shape (valor_pago=0 && valor_transportado>0).
  test('sem o remanescente>=0 no retido, este item seria indevidamente recusado (controle negativo)', () => {
    const { aGerar, recusados } = planejar(
      [item({ remanescente: '-10.00', valor_pago: '0.00', valor_transportado: '4.00' })],
      [[1, conta()]],
    );
    assert.equal(aGerar.length, 1, 'se isto falhar com length=0, a cláusula remanescente>=0 foi removida/quebrada');
    assert.notEqual(recusados[0]?.motivo, 'RETIDO');
  });

  // Controle negativo (mesma verificação manual): sem a exclusão do saldo
  // carregado quando `negativo` é true, valor/gorjeta duplicariam o saldo
  // antigo (23/6 em vez de 20/5) — ele já segue carregado pela 0098 e seria
  // cobrado de novo quando a nota futura finalmente somá-lo.
  test('sem a exclusão do saldo carregado, o valor duplicaria o saldo antigo (controle negativo)', () => {
    const { aGerar } = planejar(
      [item({
        remanescente: '-10.00', valor_pago: '0.00', valor_transportado: '4.00',
        valor_nota: '20.00', valor_fora_nota: '5.00',
        saldo_anterior_nota: '3.00', saldo_anterior_fora: '1.00',
      })],
      [[1, conta()]],
    );
    assert.notEqual(aGerar[0].linha.valor, 23, 'se isto falhar com 23, o saldo antigo foi somado de novo (duplicidade)');
    assert.notEqual(aGerar[0].linha.gorjeta, 6, 'se isto falhar com 6, o saldo antigo foi somado de novo (duplicidade)');
  });
});

test.describe('planejarGeracao() — lote', () => {
  test('separa quem gera de quem não, sem perder ninguém', () => {
    const itens = [item({ entregador_id: 1 }), item({ entregador_id: 2 }), item({ entregador_id: 3, valor_nota: null })];
    const contas = [[1, conta()], [2, conta({ cnpjPrestador: '89000000000200' })], [3, conta()]];
    const { aGerar, recusados } = planejar(itens, contas, [], ['89000000000200']);
    assert.equal(aGerar.length, 1);
    assert.equal(recusados.length, 2);
    assert.equal(aGerar.length + recusados.length, itens.length);
  });
});

// Issue #229 — a planilha não sabe da retenção. Motorista retido na semana X
// (14–20/09) é pago na Y (21–27/09) com o saldo de X somado na nota; se X já
// saiu em movimento pelo método antigo, a nota de Y duplicaria esse valor.
test.describe('entregadoresComMovimentoEmSemanaRetida() — issue #229', () => {
  const { entregadoresComMovimentoEmSemanaRetida } = require('../lib/adiantamento-geracao-movimento');
  const CNPJ = '89000000000100';
  const contas = new Map([[1, { cnpjPrestador: CNPJ }]]);
  const pagoComSaldo = item({ remanescente: '4.00', saldo_anterior_nota: '3.00', saldo_anterior_fora: '0.00' });
  const semanaX = { entregador_id: 1, valor_pago: '0.00', valor_transportado: '3.00', remanescente: '3.00',
    periodo_inicio: '2026-09-14', periodo_fim: '2026-09-20' };
  const movX = (over = {}) => ({ cnpj_prestador: CNPJ, dt_inicial: '2026-09-14T03:00:00+00:00', dt_final: '2026-09-21T02:59:59+00:00', ...over });
  const bloqueia = (itens, historico, movimentos) => entregadoresComMovimentoEmSemanaRetida(itens, historico, movimentos, contas);

  test('movimento legado FECHADO cobrindo a semana retida → bloqueia', () => {
    assert.deepEqual([...bloqueia([pagoComSaldo], [semanaX], [movX()])], [1]);
  });

  test('sem movimento legado na semana retida → não bloqueia (gera com a soma)', () => {
    assert.equal(bloqueia([pagoComSaldo], [semanaX], []).size, 0);
    // movimento de OUTRA semana (a própria Y) não conta
    assert.equal(bloqueia([pagoComSaldo], [semanaX],
      [movX({ dt_inicial: '2026-09-21T03:00:00+00:00', dt_final: '2026-09-28T02:59:59+00:00' })]).size, 0);
  });

  test('fim de período às 23:59 -03 não vira o dia seguinte (fuso de São Paulo)', () => {
    // termina em 13/09 23:59 local = 14/09 02:59Z: NÃO cruza a semana X
    assert.equal(bloqueia([pagoComSaldo], [semanaX],
      [movX({ dt_inicial: '2026-09-07T03:00:00+00:00', dt_final: '2026-09-14T02:59:59+00:00' })]).size, 0);
  });

  test('acúmulo de várias semanas: movimento em qualquer uma delas bloqueia', () => {
    const semanaW = { ...semanaX, valor_transportado: '1.50', remanescente: '1.50', periodo_inicio: '2026-09-07', periodo_fim: '2026-09-13' };
    const movW = movX({ dt_inicial: '2026-09-07T03:00:00+00:00', dt_final: '2026-09-14T02:59:59+00:00' });
    assert.equal(bloqueia([pagoComSaldo], [semanaX, semanaW], [movW]).size, 1);
  });

  test('a cadeia para na primeira semana paga: movimento antes dela não conta', () => {
    const semanaPaga = { ...semanaX, valor_pago: '50.00', valor_transportado: '0.00', periodo_inicio: '2026-09-07', periodo_fim: '2026-09-13' };
    const movW = movX({ dt_inicial: '2026-09-07T03:00:00+00:00', dt_final: '2026-09-14T02:59:59+00:00' });
    assert.equal(bloqueia([pagoComSaldo], [semanaX, semanaPaga], [movW]).size, 0);
  });

  test('semana negativa na cadeia preserva o saldo mas não é semana de origem', () => {
    const semanaNeg = { ...semanaX, remanescente: '-10.00', periodo_inicio: '2026-09-14', periodo_fim: '2026-09-20' };
    const semanaW = { ...semanaX, valor_transportado: '3.00', periodo_inicio: '2026-09-07', periodo_fim: '2026-09-13' };
    // movimento só na semana negativa (que emite a própria nota) → não bloqueia
    assert.equal(bloqueia([pagoComSaldo], [semanaNeg, semanaW], [movX()]).size, 0);
    // movimento na W (origem real do saldo) → bloqueia
    const movW = movX({ dt_inicial: '2026-09-07T03:00:00+00:00', dt_final: '2026-09-14T02:59:59+00:00' });
    assert.equal(bloqueia([pagoComSaldo], [semanaNeg, semanaW], [movW]).size, 1);
  });

  // Revisão adversarial (HIGH): o movimento que o PRÓPRIO hub gera numa semana
  // negativa grava dt_* como data pura (vira 00:00Z = dia anterior em SP) e
  // cruzaria a semana de origem. Sem excluir a trilha, o pagamento seguinte
  // ficaria preso para sempre com um "movimento antigo" que não existe.
  test('movimento gerado pelo hub (trilha) nunca conta como método antigo', () => {
    const semanaNeg = { ...semanaX, remanescente: '-10.00', periodo_inicio: '2026-09-21', periodo_fim: '2026-09-27' };
    const doHub = { id: 900, cnpj_prestador: CNPJ, dt_inicial: '2026-09-21T00:00:00+00:00', dt_final: '2026-09-27T00:00:00+00:00' };
    const hist = [semanaNeg, semanaX];
    // sem a trilha, o formato do hub cruzaria a semana X (controle do bug)
    assert.equal(entregadoresComMovimentoEmSemanaRetida([pagoComSaldo], hist, [doHub], contas).size, 1);
    // com a trilha, é reconhecido como do hub e não bloqueia
    assert.equal(entregadoresComMovimentoEmSemanaRetida([pagoComSaldo], hist, [doHub], contas, new Set([900])).size, 0);
    // e um movimento legado de verdade na X continua bloqueando mesmo com a trilha
    assert.equal(entregadoresComMovimentoEmSemanaRetida([pagoComSaldo], hist, [doHub, movX({ id: 1 })], contas, new Set([900])).size, 1);
  });

  test('sem saldo carregado ou semana atual negativa → nunca bloqueia', () => {
    assert.equal(bloqueia([item({ remanescente: '50.00' })], [semanaX], [movX()]).size, 0);
    assert.equal(bloqueia([item({ remanescente: '-5.00', saldo_anterior_nota: '3.00' })], [semanaX], [movX()]).size, 0);
  });

  test('planejarGeracao recusa com o motivo novo e não gera a nota', () => {
    const { aGerar, recusados } = planejarGeracao([pagoComSaldo], new Map([[1, conta()]]), new Set(), new Set(), CTX, new Set([1]));
    assert.equal(aGerar.length, 0);
    assert.equal(recusados[0].motivo, 'MOVIMENTO_LEGADO_EM_SEMANA_RETIDA');
  });
});
