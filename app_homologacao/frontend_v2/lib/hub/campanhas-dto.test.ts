// campanhas do motorista (W3a) — parse do contrato CONTRATOS §7 e rótulos
// iguais aos da Performance. Fixtures com TODOS os campos do contrato.

import { describe, expect, it } from 'vitest';
import {
  ROTULO_INDICADOR_CAMPANHA,
  SITUACAO_LABELS,
  SITUACOES,
  diasAte,
  parseCampanhaDetalhe,
  parseCampanhaItem,
  parseCampanhaLista,
  parseOpcoes,
  parseRanking,
  parseVencedores,
} from './campanhas-dto';
import { INDICADORES_META } from './performance-metas-api';

const ITEM = {
  id: 12,
  nome: 'Rei do Jantar — Novembro',
  situacao: 'em_andamento',
  dataInicio: '2026-11-10',
  dataFim: '2026-11-30',
  pracas: ['SAO PAULO'],
  turnos: ['JANTAR 18H-22H'],
  modais: ['MOTO'],
  minTurnos: 5,
  tipo: 'nota',
  categorias: null,
  minTurnosBase: 'trabalhados',
  pesos: { aceitacao: 30, conclusao: 30, tempo: 20, pedidos: 20 },
  contagem: { classificado: 184, abaixoCorte: 23, semMinimo: 41, semModal: 12, turnos: 0, turnosValidos: 0, valorCentavos: 0 },
  premiosPendentes: 0,
  dadosAte: '2026-11-21',
};

const DETALHE = {
  ...ITEM,
  descricao: 'Regras',
  cortes: { aceitacao: 0.8, conclusao: 0.9, tempo: null, pedidos: null },
  premios: [{ id: 3, posicaoDe: 1, posicaoAte: 1, tipo: 'objeto', descricao: 'Moto', valorCentavos: 1_600_000, temFoto: true }],
  avisar: true,
  criadaPor: 'Ana R.',
  criadaEm: '2026-11-09T18:00:00Z',
  lancadaPor: 'Ana R.',
  lancadaEm: '2026-11-09T18:42:00Z',
  canceladaEm: null,
  motivoCancelamento: null,
  fechadaEm: null,
  notaCorteTop10: 88.4,
};

const LINHA = {
  posicao: 1, entregadorId: 88, nome: 'Marcos Vinícius Andrade', modal: 'MOTO', situacao: 'classificado', turnos: 19, turnosValidos: null, valorCentavos: null,
  aceitacao: 0.962, conclusao: 0.991, tempo: 0.94, pedidos: 412, nota: 97.3, notaHipotetica: null, posicaoHipotetica: null,
  motivoCorte: [], posicaoAnterior: 3,
};

describe('rótulos iguais aos da tela Performance', () => {
  it('aceitação e conclusão vêm da constante existente; os outros dois são os textos do pedido', () => {
    expect(ROTULO_INDICADOR_CAMPANHA.aceitacao).toBe(INDICADORES_META.find((i) => i.id === 'aceitacao')!.rotulo);
    expect(ROTULO_INDICADOR_CAMPANHA.aceitacao).toBe('Taxa de aceitação');
    expect(ROTULO_INDICADOR_CAMPANHA.conclusao).toBe('Taxa de conclusão');
    expect(ROTULO_INDICADOR_CAMPANHA.tempo).toBe('Tempo disponível');
    expect(ROTULO_INDICADOR_CAMPANHA.pedidos).toBe('Pedidos concluídos');
  });
  it('as 6 situações têm rótulo', () => {
    expect(SITUACOES.map((s) => SITUACAO_LABELS[s])).toEqual(['Rascunho', 'Agendada', 'Em andamento', 'Apurando', 'Encerrada', 'Cancelada']);
  });
});

describe('parse do item e da lista', () => {
  it('item completo', () => {
    expect(parseCampanhaItem(ITEM)).toEqual(ITEM);
  });
  it('praça/turno/modal null (todas) são preservados como null, não como lista vazia', () => {
    const i = parseCampanhaItem({ ...ITEM, pracas: null, turnos: null, modais: null });
    expect([i.pracas, i.turnos, i.modais]).toEqual([null, null, null]);
  });
  it('recusa shape ruim e situação desconhecida', () => {
    expect(() => parseCampanhaItem(null)).toThrow(TypeError);
    expect(() => parseCampanhaItem({ ...ITEM, id: 'x' })).toThrow(/id\/nome/);
    expect(() => parseCampanhaItem({ ...ITEM, situacao: 'voando' })).toThrow(/situação/);
    expect(() => parseCampanhaLista({ itens: 'x' })).toThrow(TypeError);
  });
  it('lista', () => {
    expect(parseCampanhaLista({ itens: [ITEM, { ...ITEM, id: 13 }] }).map((c) => c.id)).toEqual([12, 13]);
  });
});

describe('parse do detalhe', () => {
  it('completo, com cortes nulos preservados', () => {
    expect(parseCampanhaDetalhe(DETALHE)).toEqual(DETALHE);
  });
});

describe('parse do ranking, vencedores e opções', () => {
  it('ranking', () => {
    const r = parseRanking({ itens: [LINHA], contagem: ITEM.contagem, pagina: 1, porPagina: 50 });
    expect(r.itens[0]).toEqual(LINHA);
    expect(r.porPagina).toBe(50);
    expect(r.contagem.semModal).toBe(12);
  });
  it('linha abaixo do corte guarda nota/posição hipotéticas e motivo', () => {
    const l = parseRanking({
      itens: [{ ...LINHA, posicao: null, situacao: 'abaixo_corte', nota: null, notaHipotetica: 91.2, posicaoHipotetica: 4, motivoCorte: ['aceitacao'] }],
      contagem: ITEM.contagem, pagina: 1, porPagina: 50,
    }).itens[0];
    expect(l).toMatchObject({ posicao: null, notaHipotetica: 91.2, posicaoHipotetica: 4, motivoCorte: ['aceitacao'] });
  });
  it('vencedores', () => {
    const v = parseVencedores({
      itens: [{ posicao: 1, nome: 'Rafael', nota: 98.9, premio: { tipo: 'objeto', descricao: 'Moto', valorCentavos: null },
        entregueEm: null, entreguePor: null, observacao: null, exportadoEm: null, semCnpj: false }],
    });
    expect(v[0].premio.tipo).toBe('objeto');
    expect(v[0].semCnpj).toBe(false);
  });
  it('opções', () => {
    const o = parseOpcoes({ pracas: ['A'], turnos: ['T'], modais: ['MOTO'], coberturaPedidos: 0.98, alcance: { rodaram: 212, semModal: 12 } });
    expect(o).toEqual({ pracas: ['A'], turnos: ['T'], modais: ['MOTO'], coberturaPedidos: 0.98, alcance: { rodaram: 212, semModal: 12 } });
    expect(parseOpcoes({ pracas: [], turnos: [], modais: [], coberturaPedidos: null, alcance: { rodaram: 0, semModal: 0 } }).coberturaPedidos).toBeNull();
  });
});

describe('diasAte', () => {
  it('conta dias de calendário e nunca fica negativo', () => {
    expect(diasAte('2026-11-30', '2026-11-22')).toBe(8);
    expect(diasAte('2026-11-30', '2026-12-05')).toBe(0);
  });
});

describe('extrato no contrato', () => {
  it('lista/detalhe trazem tipo, categorias e base; ausentes = nota', () => {
    const e = parseCampanhaItem({ ...ITEM, tipo: 'extrato', categorias: ['familia:promocao'], minTurnosBase: 'validos' });
    expect(e).toMatchObject({ tipo: 'extrato', categorias: ['familia:promocao'], minTurnosBase: 'validos' });
    expect(parseCampanhaItem(ITEM)).toMatchObject({ tipo: 'nota', categorias: null, minTurnosBase: 'trabalhados' });
  });
  it('ranking do extrato: turnosValidos e valorCentavos; nota null', () => {
    const r = parseRanking({ itens: [{ ...LINHA, nota: null, turnosValidos: 14, valorCentavos: 203140 }], contagem: {} });
    expect(r.itens[0]).toMatchObject({ turnosValidos: 14, turnos: 19, valorCentavos: 203140, nota: null });
    expect(parseRanking({ itens: [LINHA], contagem: {} }).itens[0]).toMatchObject({ turnosValidos: null, valorCentavos: null });
  });
});
