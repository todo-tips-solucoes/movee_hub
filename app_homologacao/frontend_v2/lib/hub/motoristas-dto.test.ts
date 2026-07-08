// hub-motoristas (S5) FASE 7 — paridade DTO↔contrato (contracts/motoristas-api.md).
import { describe, expect, it } from 'vitest';
import {
  parseContaCandidata,
  parseContasElegiveisResponse,
  parseMotoristaDetalhe,
  parseMotoristaListItem,
  parseMotoristaListResponse,
  parseSugestoesResponse,
  parseVincularResponse,
} from './motoristas-dto';

describe('parseMotoristaListItem', () => {
  const ITEM_VALIDO = {
    id: 1,
    nome: 'Fulano da Silva',
    ativo: true,
    comVinculo: true,
    areas: ['Zona Sul', 'Centro'],
  };

  it('aceita um item completo, espelhando o contrato (§GET /motoristas)', () => {
    expect(parseMotoristaListItem(ITEM_VALIDO)).toEqual(ITEM_VALIDO);
  });

  it('preenche defaults seguros quando campos opcionais ausentes', () => {
    const parsed = parseMotoristaListItem({ id: 2, nome: 'Ciclano' });
    expect(parsed.ativo).toBe(false);
    expect(parsed.comVinculo).toBe(false);
    expect(parsed.areas).toEqual([]);
  });

  it('rejeita item sem id/nome (shape incompatível com o contrato)', () => {
    expect(() => parseMotoristaListItem({ ativo: true })).toThrow(TypeError);
    expect(() => parseMotoristaListItem(null)).toThrow(TypeError);
  });
});

describe('parseMotoristaListResponse', () => {
  it('mapeia items[] + paginação; estado vazio nunca lança (FR-002 Edge Case)', () => {
    const parsed = parseMotoristaListResponse({ items: [], total: 0, page: 1, pageSize: 20 });
    expect(parsed).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('rejeita shape sem items[]', () => {
    expect(() => parseMotoristaListResponse({ total: 0 })).toThrow(TypeError);
  });
});

describe('parseMotoristaDetalhe', () => {
  const DETALHE_VALIDO = {
    id: 1,
    nome: 'Fulano da Silva',
    ativo: true,
    nomeEditadoManualmente: false,
    areas: [{ subpraca: 'Zona Sul', dataMaisRecente: '2026-07-01' }],
    resumo: { totalFaturamento: 42, totalPerformance: 30, dataMaisRecente: '2026-07-01' },
    vinculo: { contaMotoristaId: 7, nome: 'Fulano da Silva', cnpjPrestadorMascarado: '12.***.***/0001-**' },
  };

  it('aceita o shape completo do contrato (§GET /motoristas/:id)', () => {
    expect(parseMotoristaDetalhe(DETALHE_VALIDO)).toEqual(DETALHE_VALIDO);
  });

  it('vinculo: null quando sem conta vinculada (estado mais comum pós-importação, FR-003)', () => {
    const parsed = parseMotoristaDetalhe({ ...DETALHE_VALIDO, vinculo: null });
    expect(parsed.vinculo).toBeNull();
  });

  it('rejeita detalhe sem id/nome', () => {
    expect(() => parseMotoristaDetalhe({ ativo: true })).toThrow(TypeError);
  });

  it('resumo ausente/malformado cai em zeros seguros, nunca lança', () => {
    const parsed = parseMotoristaDetalhe({ id: 1, nome: 'X' });
    expect(parsed.resumo).toEqual({ totalFaturamento: 0, totalPerformance: 0, dataMaisRecente: null });
    expect(parsed.areas).toEqual([]);
  });
});

describe('parseContaCandidata (sugestões e busca manual)', () => {
  it('aceita candidato com similaridade e jaVinculadoA presente (troca de vínculo, FR-013)', () => {
    const parsed = parseContaCandidata({
      contaMotoristaId: 7,
      nome: 'Fulano',
      cnpjPrestadorMascarado: '12.***.***/0001-**',
      similaridade: 0.87,
      jaVinculadoA: { entregadorId: 3, nome: 'Outra Pessoa' },
    });
    expect(parsed.similaridade).toBe(0.87);
    expect(parsed.jaVinculadoA).toEqual({ entregadorId: 3, nome: 'Outra Pessoa' });
  });

  it('busca manual (contas-elegiveis): similaridade ausente vira undefined, não erro', () => {
    const parsed = parseContaCandidata({
      contaMotoristaId: 7,
      nome: 'Fulano',
      cnpjPrestadorMascarado: '12.***.***/0001-**',
      jaVinculadoA: null,
    });
    expect(parsed.similaridade).toBeUndefined();
    expect(parsed.jaVinculadoA).toBeNull();
  });

  it('rejeita candidato sem contaMotoristaId/nome', () => {
    expect(() => parseContaCandidata({ nome: 'X' })).toThrow(TypeError);
  });
});

describe('parseSugestoesResponse', () => {
  it('entidadeElegivel=false: items vazio é estado válido, sem erro (FR-011)', () => {
    const parsed = parseSugestoesResponse({ items: [], entidadeElegivel: false });
    expect(parsed).toEqual({ items: [], entidadeElegivel: false });
  });

  it('mapeia items com corte top 10 já aplicado pelo backend (só espelha)', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      contaMotoristaId: i,
      nome: `Conta ${i}`,
      cnpjPrestadorMascarado: '12.***.***/0001-**',
      similaridade: 0.9 - i * 0.01,
      jaVinculadoA: null,
    }));
    const parsed = parseSugestoesResponse({ items, entidadeElegivel: true });
    expect(parsed.items).toHaveLength(10);
  });
});

describe('parseContasElegiveisResponse', () => {
  it('mapeia items[] + paginação + entidadeElegivel', () => {
    const parsed = parseContasElegiveisResponse({
      items: [{ contaMotoristaId: 1, nome: 'X', cnpjPrestadorMascarado: '**', jaVinculadoA: null }],
      total: 1,
      page: 1,
      pageSize: 20,
      entidadeElegivel: true,
    });
    expect(parsed.total).toBe(1);
    expect(parsed.entidadeElegivel).toBe(true);
  });
});

describe('parseVincularResponse', () => {
  it('aceita a resposta de sucesso do POST .../vinculo', () => {
    const parsed = parseVincularResponse({
      id: 1,
      vinculo: { contaMotoristaId: 7, nome: 'Fulano', cnpjPrestadorMascarado: '12.***.***/0001-**' },
    });
    expect(parsed.vinculo.contaMotoristaId).toBe(7);
  });

  it('rejeita resposta sem vinculo (shape incompatível)', () => {
    expect(() => parseVincularResponse({ id: 1 })).toThrow(TypeError);
  });
});
