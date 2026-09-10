/**
 * Testes do cert-guard. Rodam com: node --test infra/producao/cert-guard.test.js
 *
 * O foco é o que falhou de verdade em 2026-09-09: (a) descobrir TODOS os
 * domínios roteados — um domínio que escapa da descoberta é um domínio sem
 * alarme, que é o buraco que este guard fecha; (b) decidir avisar sem virar
 * ruído; (c) mostrar o SAN, que foi o único dado capaz de explicar por que a
 * renovação falhava.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { dominiosDeLabels, faixaDe, faixaGeral, deveAvisar, corpoDoAlerta } = require('./cert-guard');

const H = 3600 * 1000;
const AGORA = new Date('2026-09-10T00:00:00Z').getTime();

describe('dominiosDeLabels — descoberta a partir das regras do Traefik', () => {
  test('extrai o domínio de uma regra Host simples', () => {
    const labels = '{"traefik.http.routers.x.rule":"Host(`app.moveelog.com.br`)"}';
    assert.deepEqual(dominiosDeLabels(labels), ['app.moveelog.com.br']);
  });

  test('extrai de regras compostas com PathPrefix', () => {
    const labels = '{"r":"Host(`sdr.todo-tips.com`) && PathPrefix(`/admin`)"}';
    assert.deepEqual(dominiosDeLabels(labels), ['sdr.todo-tips.com']);
  });

  test('descarta o catch-all do dashboard, que não é domínio', () => {
    const labels = '{"r":"Host(`{host:.+}`)"}';
    assert.deepEqual(dominiosDeLabels(labels), []);
  });

  test('deduplica: vários routers podem servir o mesmo Host', () => {
    const labels = 'Host(`sdr.todo-tips.com`) Host(`sdr.todo-tips.com`) Host(`n8n.todo-tips.com`)';
    assert.deepEqual(dominiosDeLabels(labels), ['n8n.todo-tips.com', 'sdr.todo-tips.com']);
  });

  test('o nome do ROUTER não vira domínio — só o que está dentro de Host()', () => {
    // Regressão do incidente: o router chama-se `appmotorista` mas serve
    // `app.motorista.moveelog.com.br`. Confundir os dois faria o guard vigiar
    // um nome que não existe e ignorar o que o cliente acessa.
    const labels = '{"traefik.http.routers.appmotorista.rule":"Host(`app.motorista.moveelog.com.br`)"}';
    assert.deepEqual(dominiosDeLabels(labels), ['app.motorista.moveelog.com.br']);
  });
});

describe('faixaDe — limiares padrão (21 dias alerta, 7 dias crítico)', () => {
  test('bastante prazo é ok', () => {
    assert.equal(faixaDe({ dias: 60 }), 'ok');
    assert.equal(faixaDe({ dias: 21 }), 'ok');
  });

  test('entre os dois limiares é alerta', () => {
    assert.equal(faixaDe({ dias: 20 }), 'alerta');
    assert.equal(faixaDe({ dias: 7 }), 'alerta');
  });

  test('pouco prazo é critico', () => {
    assert.equal(faixaDe({ dias: 6 }), 'critico');
    assert.equal(faixaDe({ dias: 0 }), 'critico');
  });

  test('já expirado é critico', () => {
    assert.equal(faixaDe({ dias: -1 }), 'critico');
    assert.equal(faixaDe({ dias: -125 }), 'critico');
  });

  test('domínio que não respondeu conta como alerta, nunca como ok', () => {
    // Um erro de medição já produziu "está tudo bem" neste projeto. Não medir
    // não pode ser indistinguível de medir e estar são.
    assert.equal(faixaDe({ erro: 'timeout de 8000 ms no handshake' }), 'alerta');
  });
});

describe('faixaGeral — a pior faixa manda', () => {
  test('um crítico no meio de domínios sãos leva o host a crítico', () => {
    assert.equal(faixaGeral([{ dias: 80 }, { dias: -1 }, { dias: 60 }]), 'critico');
  });

  test('todos com prazo folgado é ok', () => {
    assert.equal(faixaGeral([{ dias: 80 }, { dias: 60 }]), 'ok');
  });

  test('alerta não é promovido a crítico', () => {
    assert.equal(faixaGeral([{ dias: 80 }, { dias: 15 }]), 'alerta');
  });
});

describe('deveAvisar — avisar sempre que precisa, sem virar ruído', () => {
  test('primeira vez, vindo de ok, avisa', () => {
    assert.equal(deveAvisar('alerta', { faixa: 'ok', avisadoEm: null }, AGORA), true);
  });

  test('piorar de alerta para crítico avisa de novo na hora', () => {
    const anterior = { faixa: 'alerta', avisadoEm: new Date(AGORA - 1 * H).toISOString() };
    assert.equal(deveAvisar('critico', anterior, AGORA), true);
  });

  test('mesma faixa dentro da janela NÃO reavisa', () => {
    const anterior = { faixa: 'alerta', avisadoEm: new Date(AGORA - 2 * H).toISOString() };
    assert.equal(deveAvisar('alerta', anterior, AGORA), false);
  });

  test('mesma faixa depois de REAVISO_HORAS reavisa', () => {
    const anterior = { faixa: 'alerta', avisadoEm: new Date(AGORA - 13 * H).toISOString() };
    assert.equal(deveAvisar('alerta', anterior, AGORA), true);
  });

  test('voltar a ok nunca avisa', () => {
    const anterior = { faixa: 'critico', avisadoEm: new Date(AGORA - 1 * H).toISOString() };
    assert.equal(deveAvisar('ok', anterior, AGORA), false);
  });
});

describe('corpoDoAlerta — o e-mail precisa dizer o que fazer', () => {
  const medidas = [
    { dominio: 'app.moveelog.com.br', dias: -1, expiraEm: 'Sep 9 22:41:57 2026 GMT', sans: 'DNS:app.moveelog.com.br, DNS:envmassv2.todo-tips.com' },
    { dominio: 'registry.todo-tips.com', dias: 57, expiraEm: 'Nov 6 03:12:58 2026 GMT', sans: 'DNS:registry.todo-tips.com' },
  ];

  test('lista só os domínios com problema, não os sãos', () => {
    const corpo = corpoDoAlerta(medidas);
    assert.match(corpo, /app\.moveelog\.com\.br/);
    assert.doesNotMatch(corpo, /registry\.todo-tips\.com: /);
  });

  test('diz há quantos dias expirou, não só "expirado"', () => {
    assert.match(corpoDoAlerta(medidas), /EXPIRADO há 1 dia/);
  });

  test('mostra os SANs quando há mais de um — foi o SAN que explicou o incidente', () => {
    assert.match(corpoDoAlerta(medidas), /SANs:.*envmassv2\.todo-tips\.com/);
  });

  test('aponta onde ler o log do ACME (que docker logs não mostra)', () => {
    assert.match(corpoDoAlerta(medidas), /var\/log\/traefik\/traefik\.log/);
  });

  test('um domínio não medido aparece no corpo em vez de sumir', () => {
    const corpo = corpoDoAlerta([{ dominio: 'x.todo-tips.com', erro: 'timeout' }]);
    assert.match(corpo, /x\.todo-tips\.com: NÃO MEDIDO — timeout/);
  });
});
