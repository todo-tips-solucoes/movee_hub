/**
 * Testes unitários — routes/hub-me.js (hub-auditoria-admin S9, tasks.md
 * FASE 3.1). Rodam com: node --test tests/hub-me-auditoria-query-unit.test.js
 *
 * Cobre as funções PURAS extraídas do handler `GET /auditoria` (sem I/O,
 * sem PostgREST real — isso é responsabilidade de
 * infra/hub/testes/hub-auditoria-admin-integration.sh, FASE 6):
 *   - parseFiltrosAuditoria: vocabulário fechado (acao/recurso), inteiros
 *     (usuarioId/entidadeId), datas ISO (de/ate), PERIODO_INVALIDO,
 *     PARAMETRO_INVALIDO (hardening owasp finding M1/A05)
 *   - parsePaginacaoAuditoria: defaults/clamps (page>=1 default 1,
 *     pageSize 1..100 default 20) — mesmo padrão de
 *     lib/hub-faturamento-dto.js#parsePaginacao
 *   - montarFiltrosQueryAuditoria: composição da query PostgREST,
 *     encodeURIComponent em todo valor
 *   - mapEventoAuditoria: mapper snake_case -> camelCase (roundtrip da
 *     borda, plan.md "Convenções de Borda")
 *
 * Ref: docs/specs/hub-auditoria-admin/contracts/auditoria-api.md, tasks.md
 * FASE 3.1.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-unit';

const {
  parseFiltrosAuditoria,
  parsePaginacaoAuditoria,
  montarFiltrosQueryAuditoria,
  montarFiltrosQueryAuditoriaGlobal,
  mapEventoAuditoria,
} = require('../routes/hub-me');

describe('parseFiltrosAuditoria', () => {
  test('sem nenhum filtro -> ok:true, tudo null', () => {
    const f = parseFiltrosAuditoria({});
    assert.deepEqual(f, {
      ok: true, acao: null, usuarioId: null, recurso: null, de: null, ate: null, entidadeId: null,
    });
  });

  test('filtros combinados válidos (acao+usuarioId+recurso+periodo)', () => {
    const f = parseFiltrosAuditoria({
      acao: 'usuario_papel_alterado', usuarioId: '17', recurso: 'usuarioentidade', de: '2026-01-01', ate: '2026-01-31',
    });
    assert.equal(f.ok, true);
    assert.equal(f.acao, 'usuario_papel_alterado');
    assert.equal(f.usuarioId, 17);
    assert.equal(f.recurso, 'usuarioentidade');
    assert.equal(f.de, '2026-01-01');
    assert.equal(f.ate, '2026-01-31');
  });

  test('acao fora do vocabulário fechado (maiúscula/espaço/hífen) -> PARAMETRO_INVALIDO', () => {
    assert.deepEqual(parseFiltrosAuditoria({ acao: 'Usuario Criado' }), { ok: false, erro: 'PARAMETRO_INVALIDO' });
    assert.deepEqual(parseFiltrosAuditoria({ acao: 'usuario-criado' }), { ok: false, erro: 'PARAMETRO_INVALIDO' });
  });

  test('recurso fora do vocabulário fechado -> PARAMETRO_INVALIDO', () => {
    assert.deepEqual(parseFiltrosAuditoria({ recurso: 'Usuario;drop' }), { ok: false, erro: 'PARAMETRO_INVALIDO' });
  });

  test('usuarioId não-inteiro -> PARAMETRO_INVALIDO', () => {
    assert.deepEqual(parseFiltrosAuditoria({ usuarioId: 'abc' }), { ok: false, erro: 'PARAMETRO_INVALIDO' });
    assert.deepEqual(parseFiltrosAuditoria({ usuarioId: '1.5' }), { ok: false, erro: 'PARAMETRO_INVALIDO' });
  });

  test('entidadeId não-inteiro -> PARAMETRO_INVALIDO', () => {
    assert.deepEqual(parseFiltrosAuditoria({ entidadeId: 'nove-mil' }), { ok: false, erro: 'PARAMETRO_INVALIDO' });
  });

  test('de/ate fora do formato ISO YYYY-MM-DD -> PARAMETRO_INVALIDO', () => {
    assert.deepEqual(parseFiltrosAuditoria({ de: '01/01/2026' }), { ok: false, erro: 'PARAMETRO_INVALIDO' });
    assert.deepEqual(parseFiltrosAuditoria({ ate: '2026-1-1' }), { ok: false, erro: 'PARAMETRO_INVALIDO' });
  });

  test('de > ate -> PERIODO_INVALIDO (edge case da spec)', () => {
    assert.deepEqual(
      parseFiltrosAuditoria({ de: '2026-02-01', ate: '2026-01-01' }),
      { ok: false, erro: 'PERIODO_INVALIDO' }
    );
  });

  test('de === ate -> válido (não é PERIODO_INVALIDO)', () => {
    const f = parseFiltrosAuditoria({ de: '2026-01-01', ate: '2026-01-01' });
    assert.equal(f.ok, true);
  });
});

describe('parsePaginacaoAuditoria', () => {
  test('sem params -> default page=1 pageSize=20', () => {
    assert.deepEqual(parsePaginacaoAuditoria({}), { page: 1, pageSize: 20, from: 0, to: 19 });
  });

  test('page=3 pageSize=10 -> from/to corretos', () => {
    assert.deepEqual(parsePaginacaoAuditoria({ page: '3', pageSize: '10' }), { page: 3, pageSize: 10, from: 20, to: 29 });
  });

  test('pageSize acima de 100 -> clamp em 100', () => {
    const p = parsePaginacaoAuditoria({ pageSize: '500' });
    assert.equal(p.pageSize, 100);
  });

  test('page<1 ou não-numérico -> default 1', () => {
    assert.equal(parsePaginacaoAuditoria({ page: '0' }).page, 1);
    assert.equal(parsePaginacaoAuditoria({ page: 'x' }).page, 1);
  });

  test('pageSize<1 ou não-numérico -> default 20', () => {
    assert.equal(parsePaginacaoAuditoria({ pageSize: '0' }).pageSize, 20);
    assert.equal(parsePaginacaoAuditoria({ pageSize: 'x' }).pageSize, 20);
  });

  test('página além do total -> paginação continua válida (from/to seguem, sem lançar)', () => {
    const p = parsePaginacaoAuditoria({ page: '999', pageSize: '20' });
    assert.equal(p.page, 999);
    assert.equal(p.from, 998 * 20);
  });
});

describe('montarFiltrosQueryAuditoria', () => {
  test('só id_empresa quando nenhum filtro adicional', () => {
    const filtros = montarFiltrosQueryAuditoria(9001, { ok: true, acao: null, usuarioId: null, recurso: null, de: null, ate: null, entidadeId: null });
    assert.deepEqual(filtros, ['id_empresa=eq.9001']);
  });

  test('acao/recurso/usuarioId/periodo combinados, com encodeURIComponent', () => {
    const filtros = montarFiltrosQueryAuditoria(9001, {
      ok: true, acao: 'usuario_criado', usuarioId: 17, recurso: 'usuario', de: '2026-01-01', ate: '2026-01-31', entidadeId: null,
    });
    assert.equal(filtros[0], 'id_empresa=eq.9001');
    assert.ok(filtros.includes('acao=eq.usuario_criado'));
    assert.ok(filtros.includes('recurso=eq.usuario'));
    assert.ok(filtros.includes('usuario_id=eq.17'));
    assert.ok(filtros.some((f) => f.startsWith('criado_em=gte.')));
    assert.ok(filtros.some((f) => f.startsWith('criado_em=lte.')));
  });

  test('de vira 00:00 UTC e ate vira 23:59:59.999 UTC (janela inclusiva do dia inteiro)', () => {
    const filtros = montarFiltrosQueryAuditoria(1, { ok: true, acao: null, usuarioId: null, recurso: null, de: '2026-03-10', ate: '2026-03-10', entidadeId: null });
    const de = decodeURIComponent(filtros.find((f) => f.startsWith('criado_em=gte.')).replace('criado_em=gte.', ''));
    const ate = decodeURIComponent(filtros.find((f) => f.startsWith('criado_em=lte.')).replace('criado_em=lte.', ''));
    assert.equal(de, '2026-03-10T00:00:00.000Z');
    assert.equal(ate, '2026-03-10T23:59:59.999Z');
  });
});

describe('montarFiltrosQueryAuditoriaGlobal (FASE 3.2 — escopo admin_plataforma)', () => {
  test('sem entidadeId -> NENHUM filtro de id_empresa (vê tudo + globais)', () => {
    const filtros = montarFiltrosQueryAuditoriaGlobal({ ok: true, acao: null, usuarioId: null, recurso: null, de: null, ate: null, entidadeId: null });
    assert.deepEqual(filtros, []);
    assert.ok(!filtros.some((f) => f.startsWith('id_empresa=')));
  });

  test('com entidadeId -> filtra só aquela entidade (qualquer uma, visão global)', () => {
    const filtros = montarFiltrosQueryAuditoriaGlobal({ ok: true, acao: null, usuarioId: null, recurso: null, de: null, ate: null, entidadeId: 9002 });
    assert.deepEqual(filtros, ['id_empresa=eq.9002']);
  });

  test('combina entidadeId com os demais filtros', () => {
    const filtros = montarFiltrosQueryAuditoriaGlobal({ ok: true, acao: 'login_sucesso', usuarioId: null, recurso: null, de: null, ate: null, entidadeId: 9001 });
    assert.deepEqual(filtros, ['id_empresa=eq.9001', 'acao=eq.login_sucesso']);
  });
});

describe('mapEventoAuditoria — roundtrip snake_case -> camelCase', () => {
  test('mapeia todas as chaves do envelope (contracts/auditoria-api.md Response 200)', () => {
    const row = {
      id: 4211,
      id_empresa: 9001,
      usuario_id: 17,
      acao: 'usuario_papel_alterado',
      recurso: 'UsuarioEntidade',
      recurso_id: '33',
      detalhes: { papelAnterior: 'operador', papelNovo: 'leitura' },
      ip: '10.0.0.5',
      criado_em: '2026-07-09T18:22:10.000Z',
    };
    const mapeado = mapEventoAuditoria(row, new Map([[9001, 'Movee Matriz']]));
    assert.deepEqual(mapeado, {
      id: 4211,
      entidadeId: 9001,
      entidadeNome: 'Movee Matriz',
      usuarioId: 17,
      acao: 'usuario_papel_alterado',
      recurso: 'UsuarioEntidade',
      recursoId: '33',
      detalhes: { papelAnterior: 'operador', papelNovo: 'leitura' },
      ip: '10.0.0.5',
      criadoEm: '2026-07-09T18:22:10.000Z',
    });
    // Nenhuma chave snake_case sobrevive na saída (roundtrip trava a convenção).
    assert.ok(!Object.prototype.hasOwnProperty.call(mapeado, 'id_empresa'));
    assert.ok(!Object.prototype.hasOwnProperty.call(mapeado, 'usuario_id'));
    assert.ok(!Object.prototype.hasOwnProperty.call(mapeado, 'recurso_id'));
    assert.ok(!Object.prototype.hasOwnProperty.call(mapeado, 'criado_em'));
    // Sem mapa de nomes (falha na busca ou id ausente) degrada para null —
    // nunca quebra a resposta (impeccable rodada 2, lib/hub-entidade-nome.js).
    assert.equal(mapEventoAuditoria(row).entidadeNome, null);
  });

  test('id_empresa NULL (evento global) -> entidadeId null (sem lançar)', () => {
    const mapeado = mapEventoAuditoria({
      id: 1, id_empresa: null, usuario_id: 5, acao: 'login_sucesso', recurso: 'Usuario', recurso_id: null, detalhes: {}, ip: null, criado_em: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(mapeado.entidadeId, null);
  });
});
