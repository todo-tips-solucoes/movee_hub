/**
 * Teste unitário — lib/notas-pendentes-api.ts (frente nota-pendente-motorista, F3).
 * Stub puro de `fetch`, sem jsdom (padrão de lib/adiantamento-api.test.ts).
 * Os componentes consomem estas funções; a decisão de renderizar o card, o
 * rótulo da origem, o aria-label e o texto de erro vivem aqui.
 *
 *   node --experimental-strip-types --test lib/notas-pendentes-api.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ariaLabelEnvio,
  dataDaPendencia,
  enviarNotaPendente,
  listarNotasPendentes,
  mensagemErroEnvio,
  mostrarCardPendentes,
  motivosRecusaAnterior,
  motivosReprovacao,
  periodoDaPendencia,
  rotuloOrigem,
  textoContagem,
  type NotaPendente,
} from './notas-pendentes-api.ts';

function stubFetch(status: number, body: unknown): { urls: string[] } {
  const urls: string[] = [];
  (globalThis as unknown as Record<string, unknown>).fetch = async (input: unknown): Promise<Response> => {
    urls.push(String(input));
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  };
  return { urls };
}

const nota: NotaPendente = {
  id: 7,
  criadoEm: '2026-10-06T12:00:00Z',
  valor: '123.45',
  dtInicial: '2026-10-05',
  dtFinal: '2026-10-11',
  cnpjTomador: '12345678000199',
  tomador: 'Movee Logística Ltda',
  origem: 'MOVIMENTO',
};

test('card: não renderiza com contagem 0, nula ou indefinida', () => {
  assert.equal(mostrarCardPendentes(0), false);
  assert.equal(mostrarCardPendentes(null), false);
  assert.equal(mostrarCardPendentes(undefined), false);
});

test('card: renderiza e mostra a contagem quando > 0', () => {
  assert.equal(mostrarCardPendentes(3), true);
  assert.equal(textoContagem(3), '3 notas pendentes');
  assert.equal(textoContagem(1), '1 nota pendente');
});

test('falha ao listar rejeita (o card captura e não aparece; a home não cai)', async () => {
  stubFetch(500, { error: 'Erro no servidor.' });
  await assert.rejects(listarNotasPendentes());
});

test('listar: chama a rota certa e devolve as notas', async () => {
  const { urls } = stubFetch(200, { notas: [nota] });
  const r = await listarNotasPendentes();
  assert.equal(r.length, 1);
  assert.match(urls[0], /\/api\/motorista\/notas-pendentes$/);
});

test('linha: data, período e tomador disponíveis', () => {
  assert.equal(dataDaPendencia(nota), '05/10/2026');
  assert.equal(periodoDaPendencia(nota), '05/10/2026 a 11/10/2026');
  assert.equal(nota.tomador, 'Movee Logística Ltda');
});

test('rótulo da origem', () => {
  assert.equal(rotuloOrigem('MOVIMENTO'), 'Movimento semanal');
  assert.equal(rotuloOrigem('REPASSE'), 'Repasse');
});

test('aria-label identifica a pendência', () => {
  assert.equal(ariaLabelEnvio(nota), 'Enviar nota de 05/10');
  assert.notEqual(ariaLabelEnvio(nota), ariaLabelEnvio({ ...nota, dtInicial: '2026-10-12' }));
});

test('erro do backend aparece com o motivo real', async () => {
  stubFetch(422, { error: 'Nenhum motorista ativo encontrado para o CNPJ do prestador' });
  await assert.rejects(enviarNotaPendente(7, new File(['<x/>'], 'n.xml')), (e: unknown) => {
    assert.equal(mensagemErroEnvio(e), 'Nenhum motorista ativo encontrado para o CNPJ do prestador');
    return true;
  });
  assert.equal(mensagemErroEnvio('x'), 'Erro ao enviar. Tente novamente.');
});

test('nota reprovada (200 valid:false) lista campos e instrução', () => {
  const m = motivosReprovacao({
    valid: false,
    notaOk: false,
    camposInvalidos: [{ campo: 'valid_valor', mensagem: 'Valor da nota não confere com o valor do movimento.' }],
    instrucao: 'Cancele esta nota e emita uma nova com os campos corrigidos.',
  });
  assert.deepEqual(m, [
    'Valor da nota não confere com o valor do movimento.',
    'Cancele esta nota e emita uma nova com os campos corrigidos.',
  ]);
});

test('motivosRecusaAnterior: item recusado devolve as mensagens; nunca enviado devolve []', () => {
  assert.deepEqual(
    motivosRecusaAnterior({ camposInvalidos: [{ campo: 'valid_valor', mensagem: 'Valor errado.' }, { campo: 'valid_cnpj', mensagem: 'CNPJ errado.' }] }),
    ['Valor errado.', 'CNPJ errado.'],
  );
  assert.deepEqual(motivosRecusaAnterior({}), []);
  assert.deepEqual(motivosRecusaAnterior({ camposInvalidos: [] }), []);
});
