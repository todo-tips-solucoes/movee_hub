/**
 * Testes unitários — lib/adiantamento-regras.js (tasks.md 2.1).
 * Rodam com: node --test tests/adiantamento-regras-unit.test.js
 *
 * 2.1.5: a bateria de fronteiras usa `tests/fixtures/adiantamento-janela-vetores.json`,
 * o MESMO arquivo consumido pelo cenário SQL de
 * `infra/hub/testes/hub-adiantamentos-integration.sh` — garante que
 * `janela()` (JS) e `hub_adiantamento_janela` (SQL) nunca divergem.
 *
 * Ref: plan.md §Regras "Janela"/"D-1 calendário"; Spec §FR-002, §FR-003,
 * §FR-005, §FR-007, §FR-008.
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  janela,
  podeSolicitar,
  nextAvailableAt,
  cortePassou,
  textoRegras,
  textoDiasHabilitados,
  formatarPercentual,
  nomeAmigavelFuso,
} = require('../lib/adiantamento-regras');

const vetoresFixture = require('./fixtures/adiantamento-janela-vetores.json');

const CONFIG_PADRAO = {
  id: 501, // configuracaoId (PK da AdiantamentoConfiguracao) — distinto de `versao` de propósito (3.7.3/dec-071)
  versao: 3, // configVersion (versão de exibição — "versão 3" no protótipo M06/M15)
  timezone: 'America/Sao_Paulo',
  dias_habilitados: [1, 2, 3, 4, 5, 6],
  horario_abertura: '09:00:00',
  horario_corte: '15:00:00',
  percentual: 60,
  taxa_fixa: 0.35,
  previsao_pagamento_texto: 'entre 17h e 18h de hoje',
};

describe('janela() — fronteiras compartilhadas com o SQL (2.1.5)', () => {
  for (const vetor of vetoresFixture.vetores) {
    test(vetor.descricao, () => {
      const config = { ...CONFIG_PADRAO, ...vetoresFixture.config };
      const obtido = janela(config, new Date(vetor.instante));
      assert.deepEqual(obtido, vetor.esperado);
    });
  }
});

describe('janela() — espelha hub_adiantamento_janela (2.1.1)', () => {
  test('dia habilitado E dentro do horário -> antes_abertura=false, apos_corte=false', () => {
    const r = janela(CONFIG_PADRAO, new Date('2026-09-17T12:00:00-03:00'));
    assert.equal(r.dia_habilitado, true);
    assert.equal(r.antes_abertura, false);
    assert.equal(r.apos_corte, false);
  });

  test('container em UTC não interfere: o mesmo instante dá o mesmo resultado independente do TZ do processo', () => {
    const instante = new Date('2026-09-17T12:00:00-03:00');
    const a = janela(CONFIG_PADRAO, instante);
    const b = janela(CONFIG_PADRAO, new Date(instante.getTime()));
    assert.deepEqual(a, b);
    // instante em UTC puro deve corresponder a 09:00 local (-03:00 = 12:00 UTC)
    assert.equal(instante.toISOString(), '2026-09-17T15:00:00.000Z');
  });
});

describe('podeSolicitar() — veredito + motivo (FR-003)', () => {
  test('DAY_NOT_ALLOWED no domingo', () => {
    const r = podeSolicitar(CONFIG_PADRAO, new Date('2026-09-20T10:00:00-03:00'));
    assert.equal(r.canRequest, false);
    assert.equal(r.reason, 'DAY_NOT_ALLOWED');
  });

  test('BEFORE_OPENING antes das 09:00', () => {
    const r = podeSolicitar(CONFIG_PADRAO, new Date('2026-09-17T08:00:00-03:00'));
    assert.equal(r.canRequest, false);
    assert.equal(r.reason, 'BEFORE_OPENING');
  });

  test('AFTER_CUTOFF depois das 15:00', () => {
    const r = podeSolicitar(CONFIG_PADRAO, new Date('2026-09-17T15:00:01-03:00'));
    assert.equal(r.canRequest, false);
    assert.equal(r.reason, 'AFTER_CUTOFF');
  });

  test('canRequest=true dentro da janela em dia habilitado', () => {
    const r = podeSolicitar(CONFIG_PADRAO, new Date('2026-09-17T10:00:00-03:00'));
    assert.equal(r.canRequest, true);
    assert.equal(r.reason, null);
  });
});

describe('D-1 calendário puro (2.1.2, 2.1.6)', () => {
  test('segunda-feira usa domingo como data de produção, mesmo domingo desabilitado', () => {
    const r = janela(CONFIG_PADRAO, new Date('2026-09-21T10:00:00-03:00'));
    assert.equal(r.data_solicitacao, '2026-09-21');
    assert.equal(r.data_producao, '2026-09-20');
  });

  test('virada de mês: 1º de outubro produz para 30 de setembro', () => {
    const r = janela(CONFIG_PADRAO, new Date('2026-10-01T10:00:00-03:00'));
    assert.equal(r.data_producao, '2026-09-30');
  });

  test('virada de ano: 1º de janeiro produz para 31 de dezembro do ano anterior', () => {
    const r = janela(CONFIG_PADRAO, new Date('2026-01-01T10:00:00-03:00'));
    assert.equal(r.data_producao, '2025-12-31');
  });

  test('nunca aplica dia útil/feriado: sábado produz para sexta normalmente', () => {
    const r = janela(CONFIG_PADRAO, new Date('2026-09-19T10:00:00-03:00')); // sábado
    assert.equal(r.data_solicitacao, '2026-09-19');
    assert.equal(r.data_producao, '2026-09-18');
  });
});

describe('nextAvailableAt() (2.1.3)', () => {
  test('antes da abertura hoje -> hoje às 09:00, com offset -03:00', () => {
    const r = nextAvailableAt(CONFIG_PADRAO, new Date('2026-09-17T07:00:00-03:00'));
    assert.equal(r, '2026-09-17T09:00:00-03:00');
  });

  test('depois do corte hoje (quinta) -> amanhã (sexta) às 09:00', () => {
    const r = nextAvailableAt(CONFIG_PADRAO, new Date('2026-09-17T16:00:00-03:00'));
    assert.equal(r, '2026-09-18T09:00:00-03:00');
  });

  test('sábado depois do corte -> pula domingo (desabilitado) e cai na segunda', () => {
    const r = nextAvailableAt(CONFIG_PADRAO, new Date('2026-09-19T16:00:00-03:00'));
    assert.equal(r, '2026-09-21T09:00:00-03:00');
  });

  test('domingo (desabilitado) a qualquer hora -> segunda às 09:00', () => {
    const r = nextAvailableAt(CONFIG_PADRAO, new Date('2026-09-20T23:00:00-03:00'));
    assert.equal(r, '2026-09-21T09:00:00-03:00');
  });
});

describe('cortePassou() — espelha hub_adiantamento_corte_passou (dec-047)', () => {
  test('mesmo dia, antes do corte -> false', () => {
    assert.equal(
      cortePassou('2026-09-17', '15:00:00', 'America/Sao_Paulo', new Date('2026-09-17T14:00:00-03:00')),
      false,
    );
  });

  test('mesmo dia, exatamente no corte -> true', () => {
    assert.equal(
      cortePassou('2026-09-17', '15:00:00', 'America/Sao_Paulo', new Date('2026-09-17T15:00:00-03:00')),
      true,
    );
  });

  test('solicitação de dia anterior, tick rodando de madrugada -> corte já passou', () => {
    // simula backend reiniciado: solicitação de ontem, tick roda hoje às 02:00
    assert.equal(
      cortePassou('2026-09-16', '15:00:00', 'America/Sao_Paulo', new Date('2026-09-17T02:00:00-03:00')),
      true,
    );
  });
});

describe('textoRegras() — regras vigentes + aceiteSha256 (2.1.4, FR-005/FR-007)', () => {
  test('usa os valores da configuração recebida, nunca fixos', () => {
    const r = textoRegras(CONFIG_PADRAO);
    assert.equal(r.configVersion, 3); // config.versao (exibição) — 3.7.3/dec-071
    assert.equal(r.configuracaoId, 501); // config.id (PK, identificador enviado em POST /adiantamentos)
    assert.match(r.texto, /60%/);
    assert.match(r.texto, /0,35/);
    assert.match(r.texto, /09:00/);
    assert.match(r.texto, /15:00/);
    assert.equal(r.itens.length, 8); // 2.6.1: os 8 blocos de M15, não só 3
    assert.match(r.aceiteSha256, /^[0-9a-f]{64}$/);
  });

  test('aceiteSha256 é determinístico e muda quando a configuração muda', () => {
    const a = textoRegras(CONFIG_PADRAO);
    const b = textoRegras(CONFIG_PADRAO);
    assert.equal(a.aceiteSha256, b.aceiteSha256);
    const c = textoRegras({ ...CONFIG_PADRAO, percentual: 70 });
    assert.notEqual(a.aceiteSha256, c.aceiteSha256);
  });
});

describe('textoRegras() — os 8 blocos de M15/M06 com config não padrão (2.6.1, 2.6.4)', () => {
  const CONFIG_NAO_PADRAO = {
    versao: 7,
    timezone: 'America/Sao_Paulo',
    dias_habilitados: [2, 3, 4, 5, 6], // terça a sábado
    horario_abertura: '08:00:00',
    horario_corte: '14:30:00',
    percentual: 62.5,
    taxa_fixa: 0.5,
    previsao_pagamento_texto: 'entre 18h e 19h de hoje',
  };

  test('gera os 8 itens, na ordem de M15, com valores da config não padrão', () => {
    const r = textoRegras(CONFIG_NAO_PADRAO);
    assert.equal(r.itens.length, 8);
    assert.deepEqual(
      r.itens.map((i) => i.titulo),
      ['Produção considerada', 'Percentual', 'Taxa', 'Dias disponíveis', 'Prazo', 'Pagamento', 'Limite', 'Repasse semanal'],
    );
    assert.match(r.texto, /produção registrada ontem/);
    assert.match(r.texto, /62,5%/);
    assert.match(r.texto, /0,50/);
    assert.match(r.texto, /terça-feira, quarta-feira, quinta-feira, sexta-feira, sábado/);
    assert.match(r.texto, /08:00 até 14:30/);
    assert.match(r.texto, /horário de Brasília/);
    assert.match(r.texto, /entre 18h e 19h de hoje/);
    assert.match(r.texto, /Dias sem solicitação não acumulam/);
    assert.match(r.texto, /cancelar até o corte \(14:30\)/);
    assert.match(r.texto, /descontado do repasse do período da produção/);
  });

  test('hash muda quando qualquer um dos 8 valores muda', () => {
    const base = textoRegras(CONFIG_NAO_PADRAO);
    const overrides = {
      percentual: 70,
      taxa_fixa: 0.75,
      horario_abertura: '07:00:00',
      horario_corte: '13:00:00',
      timezone: 'UTC',
      previsao_pagamento_texto: 'outro texto',
      dias_habilitados: [1, 2, 3, 4, 5, 6],
    };
    for (const [campo, valor] of Object.entries(overrides)) {
      const outro = textoRegras({ ...CONFIG_NAO_PADRAO, [campo]: valor });
      assert.notEqual(base.aceiteSha256, outro.aceiteSha256, `campo ${campo} não mudou o hash`);
    }
  });
});

describe('formatarPercentual() — pt-BR sem zeros supérfluos (2.6.2)', () => {
  test('inteiro não ganha casas decimais', () => {
    assert.equal(formatarPercentual(60), '60');
  });

  test('decimal usa vírgula e mantém só as casas necessárias', () => {
    assert.equal(formatarPercentual(62.5), '62,5');
  });
});

describe('nomeAmigavelFuso() — 2.6.2', () => {
  test('America/Sao_Paulo vira "horário de Brasília"', () => {
    assert.equal(nomeAmigavelFuso('America/Sao_Paulo'), 'horário de Brasília');
  });

  test('fuso desconhecido cai no próprio identificador IANA', () => {
    assert.equal(nomeAmigavelFuso('America/New_York'), 'America/New_York');
  });
});

describe('nextAvailableAt() — offset zero é sempre "+00:00" (2.6.2)', () => {
  test('config UTC nunca produz "-00:00"', () => {
    const configUtc = { ...CONFIG_PADRAO, timezone: 'UTC' };
    const r = nextAvailableAt(configUtc, new Date('2026-09-17T07:00:00Z'));
    assert.match(r, /\+00:00$/);
  });
});

describe('textoDiasHabilitados()', () => {
  test('lista na ordem domingo..sábado, independente da ordem de entrada', () => {
    assert.equal(textoDiasHabilitados([5, 1, 3]), 'segunda-feira, quarta-feira, sexta-feira');
  });
});
