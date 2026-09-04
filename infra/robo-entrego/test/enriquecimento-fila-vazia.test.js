'use strict';
// Fila vazia NÃO pode tocar a EntreGô (corrigido em 2026-09-04, antes de
// instalar os timers). O modo sob-demanda roda a cada 5 min; sondar a
// plataforma sem trabalho a fazer é ~288 toques/dia na sessão compartilhada
// com a importação diária, com PerimeterX ativo.
const { test } = require('node:test');
const assert = require('node:assert');
const { executarRodadaEnriquecimento } = require('../src/enriquecimento');

function cenario({ itens }) {
  const chamadas = [];
  const clienteHub = {
    login: async () => { chamadas.push('hub.login'); },
    buscarMotoristasParaEnriquecer: async () => { chamadas.push('hub.fila'); return itens; },
    reportarEnriquecimento: async () => { chamadas.push('hub.reportar'); },
  };
  // page instrumentada: QUALQUER uso significa que tocou a EntreGô
  const page = new Proxy({}, { get: (_t, prop) => {
    if (typeof prop === 'string') chamadas.push(`page.${prop}`);
    return () => { throw new Error('nao deveria tocar a EntreGo com fila vazia'); };
  }});
  return { chamadas, clienteHub, page };
}

const config = {
  hubServicoEmail: 'x@example.invalid', hubServicoSenha: 'x',
  entregoEmail: 'y@example.invalid', entregoSenha: 'y',
  storageStatePath: '/tmp/inexistente.json',
};

test('fila VAZIA: consulta a fila e sai, sem tocar a EntreGo', async () => {
  const { chamadas, clienteHub, page } = cenario({ itens: [] });
  const r = await executarRodadaEnriquecimento({
    modo: 'sob-demanda', page, clienteHub, config,
    obterCodigo: async () => { throw new Error('nao deveria pedir codigo'); },
  });
  assert.equal(r.resultado, 'sem_dados');
  assert.equal(r.total, 0);
  assert.ok(chamadas.includes('hub.fila'), 'deveria consultar a fila');
  const tocouEntrego = chamadas.filter((c) => c.startsWith('page.'));
  assert.deepEqual(tocouEntrego, [], `nao deveria tocar a EntreGo, mas usou: ${tocouEntrego.join(', ')}`);
});

test('a fila e consultada ANTES de qualquer uso da page', async () => {
  const { chamadas, clienteHub, page } = cenario({ itens: [] });
  await executarRodadaEnriquecimento({
    modo: 'sob-demanda', page, clienteHub, config, obterCodigo: async () => 'x',
  });
  const iFila = chamadas.indexOf('hub.fila');
  const iPage = chamadas.findIndex((c) => c.startsWith('page.'));
  assert.ok(iFila >= 0, 'fila deveria ter sido consultada');
  assert.ok(iPage === -1 || iFila < iPage, 'a fila tem de vir antes de tocar a EntreGo');
});
