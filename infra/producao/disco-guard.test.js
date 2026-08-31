/**
 * Testes do disco-guard. Rodam com: node --test infra/producao/disco-guard.test.js
 *
 * O foco é a decisão de AVISAR: um alarme que não avisa é pior que não ter
 * alarme (dá a sensação de cobertura), e um alarme que avisa 24×/dia vira ruído
 * que se aprende a ignorar — que dá no mesmo. As duas falhas são silenciosas.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { faixaDe, deveAvisar, medirDisco, corpoDoAlerta } = require('./disco-guard');

const H = 3600 * 1000;
const AGORA = new Date('2026-08-30T20:00:00Z').getTime();

describe('faixaDe — limiares padrão (20 GB alerta, 8 GB crítico)', () => {
  test('acima do limiar é ok', () => {
    assert.equal(faixaDe(36), 'ok');
    assert.equal(faixaDe(20.1), 'ok');
  });

  test('entre os dois limiares é alerta', () => {
    assert.equal(faixaDe(19.9), 'alerta');
    assert.equal(faixaDe(8.1), 'alerta');
  });

  test('abaixo do crítico é critico', () => {
    assert.equal(faixaDe(7.9), 'critico');
    // o cenário de 2026-08-30: zero bytes livres
    assert.equal(faixaDe(0), 'critico');
  });
});

describe('deveAvisar — avisa o suficiente, sem virar ruído', () => {
  test('disco ok nunca avisa', () => {
    assert.equal(deveAvisar('ok', { faixa: 'ok', avisadoEm: null }, AGORA), false);
    // nem quando acabou de normalizar
    assert.equal(deveAvisar('ok', { faixa: 'critico', avisadoEm: new Date(AGORA).toISOString() }, AGORA), false);
  });

  test('primeira entrada em alerta avisa', () => {
    assert.equal(deveAvisar('alerta', { faixa: 'ok', avisadoEm: null }, AGORA), true);
  });

  test('PIORAR de alerta para crítico avisa na hora, sem esperar o reaviso', () => {
    const anterior = { faixa: 'alerta', avisadoEm: new Date(AGORA - 5 * 60 * 1000).toISOString() };
    assert.equal(deveAvisar('critico', anterior, AGORA), true);
  });

  test('mesma faixa dentro da janela NÃO reavisa (é o que evita 24 e-mails/dia)', () => {
    const anterior = { faixa: 'alerta', avisadoEm: new Date(AGORA - 2 * H).toISOString() };
    assert.equal(deveAvisar('alerta', anterior, AGORA), false);
  });

  test('mesma faixa depois da janela reavisa (o problema não passou)', () => {
    const anterior = { faixa: 'alerta', avisadoEm: new Date(AGORA - 7 * H).toISOString() };
    assert.equal(deveAvisar('alerta', anterior, AGORA), true);
  });

  test('estado corrompido/sem timestamp avisa — na dúvida, avisar', () => {
    assert.equal(deveAvisar('critico', { faixa: 'critico', avisadoEm: null }, AGORA), true);
  });
});

describe('medirDisco — lê o filesystem de verdade', () => {
  test('devolve números coerentes para /', () => {
    const m = medirDisco('/');
    assert.ok(m.totalGb > 0, 'total deve ser positivo');
    assert.ok(m.livreGb >= 0 && m.livreGb <= m.totalGb, 'livre dentro do total');
    assert.ok(m.usoPct >= 0 && m.usoPct <= 100, 'uso entre 0 e 100');
  });
});

describe('corpoDoAlerta', () => {
  const m = { livreGb: 3.2, totalGb: 150, usoPct: 98 };

  test('traz os números e os comandos seguros de limpeza', () => {
    const corpo = corpoDoAlerta(m, 'critico');
    assert.match(corpo, /3\.2 GB de 150 GB/);
    assert.match(corpo, /98%/);
    assert.match(corpo, /docker builder prune -f/);
    assert.match(corpo, /docker image prune -f/);
  });

  test('avisa explicitamente o que NUNCA fazer — o -a apagaria os rollbacks', () => {
    const corpo = corpoDoAlerta(m, 'alerta');
    assert.match(corpo, /NUNCA: docker system prune -a/);
    assert.match(corpo, /--volumes/);
  });

  test('o crítico diz a consequência concreta, não só "atenção"', () => {
    assert.match(corpoDoAlerta(m, 'critico'), /Postgres NÃO sobe/);
  });
});
