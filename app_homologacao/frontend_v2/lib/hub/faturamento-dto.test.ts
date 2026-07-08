// hub-faturamento (S6) FASE 6 task 6.1.3 — paridade DTO↔contrato
// (contracts/faturamento-api.md). Complementado pelo roundtrip real contra
// o hub-homolog (evidência em docs/plans/hub-frota/evidencias/S6/) — este
// arquivo cobre o shape estático; o roundtrip cobre drift snake_case↔camelCase
// real do backend vivo.
import { describe, expect, it } from 'vitest';
import {
  CHAVE_AGREGADOS_BONUS,
  parseFaturamentoListItem,
  parseFaturamentoListResponse,
  parseFaturamentoResumoAgrupado,
  parseFaturamentoResumoCards,
} from './faturamento-dto';

describe('parseFaturamentoListItem', () => {
  const ITEM_VALIDO = {
    id: 123,
    dataReferencia: '2026-07-01',
    dataLancamento: '2026-07-01',
    dataRepasse: '2026-07-06',
    categoria: 'Corridas concluidas',
    valor: '61.50',
    entregadorId: 42,
    entregadorNome: 'F*** S***',
    subpraca: 'SAO PAULO - ZONA SUL',
    praca: 'SAO PAULO',
    periodo: 'ALMOCO 11H30-15H29',
    comEntregador: true,
  };

  it('aceita um item completo, espelhando o contrato (§GET /faturamento)', () => {
    expect(parseFaturamentoListItem(ITEM_VALIDO)).toEqual(ITEM_VALIDO);
  });

  it('valor permanece STRING (research.md Decision 7) — nunca vira number', () => {
    const parsed = parseFaturamentoListItem(ITEM_VALIDO);
    expect(typeof parsed.valor).toBe('string');
  });

  it('lançamento agregado/bônus: entregadorId/entregadorNome null quando comEntregador=false (FR-005)', () => {
    const parsed = parseFaturamentoListItem({ ...ITEM_VALIDO, entregadorId: null, entregadorNome: null, comEntregador: false });
    expect(parsed.entregadorId).toBeNull();
    expect(parsed.entregadorNome).toBeNull();
    expect(parsed.comEntregador).toBe(false);
  });

  it('rejeita item sem id/dataReferencia (shape incompatível com o contrato)', () => {
    expect(() => parseFaturamentoListItem({ valor: '1.00' })).toThrow(TypeError);
    expect(() => parseFaturamentoListItem(null)).toThrow(TypeError);
  });
});

describe('parseFaturamentoListResponse', () => {
  it('mapeia items[] + paginação; período sem dados nunca lança (FR-012)', () => {
    const parsed = parseFaturamentoListResponse({ items: [], total: 0, page: 1, pageSize: 20 });
    expect(parsed).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('rejeita shape sem items[]', () => {
    expect(() => parseFaturamentoListResponse({ total: 0 })).toThrow(TypeError);
  });
});

describe('parseFaturamentoResumoCards', () => {
  it('aceita cards completos (§GET /faturamento/resumo sem groupBy, FR-003)', () => {
    const raw = { totalGeral: '98135.40', categoriaMaiorValor: 'Corridas concluidas', entregadoresDistintos: 691 };
    expect(parseFaturamentoResumoCards(raw)).toEqual(raw);
  });

  it('período sem dados -> zeros/null, nunca erro (FR-012)', () => {
    const raw = { totalGeral: '0.00', categoriaMaiorValor: null, entregadoresDistintos: 0 };
    expect(parseFaturamentoResumoCards(raw)).toEqual(raw);
  });

  it('totalGeral permanece STRING — nunca vira number', () => {
    expect(typeof parseFaturamentoResumoCards({ totalGeral: '1.00' }).totalGeral).toBe('string');
  });
});

describe('parseFaturamentoResumoAgrupado', () => {
  it('mapeia grupos com bucket agregados/bônus (dec-010) preservando a chave literal', () => {
    const raw = {
      groupBy: 'entregador',
      grupos: [
        { chave: '42', rotulo: 'F*** S***', total: '1250.00', quantidade: 18 },
        { chave: CHAVE_AGREGADOS_BONUS, rotulo: 'Agregados/bônus', total: '3940.40', quantidade: 885 },
      ],
    };
    const parsed = parseFaturamentoResumoAgrupado(raw);
    expect(parsed.groupBy).toBe('entregador');
    expect(parsed.grupos).toHaveLength(2);
    expect(parsed.grupos[1].chave).toBe(CHAVE_AGREGADOS_BONUS);
    expect(parsed.grupos[1].rotulo).toBe('Agregados/bônus');
  });

  it('rejeita shape sem grupos[]', () => {
    expect(() => parseFaturamentoResumoAgrupado({ groupBy: 'dia' })).toThrow(TypeError);
  });
});
