// hub-motoristas (S5) FASE 7 — paridade DTO↔contrato (contracts/motoristas-api.md).
import { describe, expect, it } from 'vitest';
import {
  isUuidValido,
  parseAtualizarCredencialResponse,
  parseContaCandidata,
  parseContasElegiveisResponse,
  parseCriarCredencialResponse,
  parseCriarMotoristaResponse,
  parseMotoristaDetalhe,
  parseMotoristaListItem,
  parseMotoristaListResponse,
  parseResetCredencialResponse,
  parseSugestoesResponse,
  parseVincularResponse,
} from './motoristas-dto';

describe('parseMotoristaListItem', () => {
  const ITEM_VALIDO = {
    id: 1,
    nome: 'Fulano da Silva',
    idExterno: '11111111-1111-1111-1111-111111111111',
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
    expect(parsed.idExterno).toBe('');
  });

  it('rejeita item sem id/nome (shape incompatível com o contrato)', () => {
    expect(() => parseMotoristaListItem({ ativo: true })).toThrow(TypeError);
    expect(() => parseMotoristaListItem(null)).toThrow(TypeError);
  });

  // FASE 4 (task 4.1.4): idExterno (uuid) exposto no item de listagem (FR-016)
  it('idExterno (uuid) exposto no formato esperado', () => {
    const parsed = parseMotoristaListItem(ITEM_VALIDO);
    expect(parsed.idExterno).toBe('11111111-1111-1111-1111-111111111111');
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
    idExterno: '22222222-2222-2222-2222-222222222222',
    ativo: true,
    nomeEditadoManualmente: false,
    // FASE 4 (task 4.1, FR-008) — CNPJ do legado, não mascarado.
    cnpjPrestador: '12345678000195',
    areas: [{ subpraca: 'Zona Sul', dataMaisRecente: '2026-07-01' }],
    resumo: { totalFaturamento: 42, totalPerformance: 30, dataMaisRecente: '2026-07-01' },
    vinculo: { contaMotoristaId: 7, nome: 'Fulano da Silva', cnpjPrestadorMascarado: '12.***.***/0001-**', ativo: true },
    // FASE 6 (tasks.md 6.4/6.5) — seção "Atividades" (histórico read-only).
    atividades: {
      items: [{ tipo: 'faturamento', data: '2026-07-01', descricao: 'Entrega X', valor: 42.5 }],
      total: 1,
      offset: 0,
      limit: 20,
    },
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
    expect(parsed.idExterno).toBe('');
  });

  // FASE 4 (task 4.1, FR-008 Acceptance Scenario 1/2) — "motorista com e
  // sem CNPJ vinculado", espelhando lib/hub-motoristas-dto.test.js do backend.
  it('cnpjPrestador presente é repassado tal-e-qual (não mascarado)', () => {
    const parsed = parseMotoristaDetalhe(DETALHE_VALIDO);
    expect(parsed.cnpjPrestador).toBe('12345678000195');
  });

  it('cnpjPrestador ausente/null (sem vínculo) -> null, nunca lança (Acceptance Scenario 2)', () => {
    const parsed = parseMotoristaDetalhe({ id: 1, nome: 'X' });
    expect(parsed.cnpjPrestador).toBeNull();
  });

  // FASE 4 (task 4.1.4): idExterno (uuid) exposto no detalhe (FR-016)
  it('idExterno (uuid) exposto no formato esperado', () => {
    const parsed = parseMotoristaDetalhe(DETALHE_VALIDO);
    expect(parsed.idExterno).toBe('22222222-2222-2222-2222-222222222222');
  });

  // FASE 6 (tasks.md 6.4/6.5) — atividades ausente/malformado nunca lança
  // (motorista sem atividades ainda consultadas, task 6.4.4).
  it('atividades ausente -> default vazio, nunca lança', () => {
    const parsed = parseMotoristaDetalhe({ id: 1, nome: 'X' });
    expect(parsed.atividades).toEqual({ items: [], total: 0, offset: 0, limit: 0 });
  });

  it('atividades com item de tipo desconhecido é filtrado (defesa em profundidade)', () => {
    const parsed = parseMotoristaDetalhe({
      id: 1,
      nome: 'X',
      atividades: {
        items: [
          { tipo: 'faturamento', data: '2026-07-01', descricao: null, valor: 10 },
          { tipo: 'tipo-desconhecido', data: '2026-07-02', descricao: null, valor: null },
        ],
        total: 2,
        offset: 0,
        limit: 20,
      },
    });
    expect(parsed.atividades.items).toHaveLength(1);
    expect(parsed.atividades.items[0].tipo).toBe('faturamento');
  });
});

describe('parseCriarMotoristaResponse (POST /motoristas — FASE 4, task 4.2)', () => {
  const RESPOSTA_VALIDA = {
    id: 10,
    idExterno: '33333333-3333-3333-3333-333333333333',
    nome: 'Fulano da Silva',
    ativo: true,
  };

  it('aceita o shape do contrato (§POST /motoristas — 201)', () => {
    expect(parseCriarMotoristaResponse(RESPOSTA_VALIDA)).toEqual(RESPOSTA_VALIDA);
  });

  it('rejeita shape sem id/nome/idExterno', () => {
    expect(() => parseCriarMotoristaResponse({ id: 1 })).toThrow(TypeError);
    expect(() => parseCriarMotoristaResponse(null)).toThrow(TypeError);
  });
});

describe('isUuidValido (validação client-side espelhando lib/hub-import-normalizer.js#uuidValido)', () => {
  it('aceita uuid em formato válido (minúsculo ou maiúsculo)', () => {
    expect(isUuidValido('11111111-1111-1111-1111-111111111111')).toBe(true);
    expect(isUuidValido('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')).toBe(true);
  });

  it('rejeita formato inválido', () => {
    expect(isUuidValido('nao-e-um-uuid')).toBe(false);
    expect(isUuidValido('')).toBe(false);
    expect(isUuidValido('12345')).toBe(false);
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

  it('vinculo.ativo (FASE 5, task 5.5) — estado da credencial exposto', () => {
    const ativa = parseVincularResponse({
      id: 1,
      vinculo: { contaMotoristaId: 7, nome: 'Fulano', cnpjPrestadorMascarado: '12.***.***/0001-**', ativo: true },
    });
    expect(ativa.vinculo.ativo).toBe(true);

    const inativa = parseVincularResponse({
      id: 1,
      vinculo: { contaMotoristaId: 7, nome: 'Fulano', cnpjPrestadorMascarado: '12.***.***/0001-**', ativo: false },
    });
    expect(inativa.vinculo.ativo).toBe(false);
  });
});

describe('parseCriarCredencialResponse (POST .../credencial — FASE 5, task 5.5)', () => {
  it('senha AUTO-gerada -> senhaTemporaria presente', () => {
    const parsed = parseCriarCredencialResponse({
      id: 9, cnpjPrestador: '12.***.***/0001-**', ativo: true, senhaTemporaria: 'abc123XYZ',
    });
    expect(parsed).toEqual({ id: 9, cnpjPrestador: '12.***.***/0001-**', ativo: true, senhaTemporaria: 'abc123XYZ' });
  });

  it('senhaInicial fornecida pelo caller -> senhaTemporaria ausente vira undefined', () => {
    const parsed = parseCriarCredencialResponse({ id: 9, cnpjPrestador: '12.***.***/0001-**', ativo: true });
    expect(parsed.senhaTemporaria).toBeUndefined();
  });

  it('rejeita resposta sem id/cnpjPrestador', () => {
    expect(() => parseCriarCredencialResponse({ ativo: true })).toThrow(TypeError);
    expect(() => parseCriarCredencialResponse(null)).toThrow(TypeError);
  });
});

describe('parseResetCredencialResponse (POST .../credencial/reset-senha — FASE 5)', () => {
  it('aceita ok + tokenDefinicao', () => {
    const parsed = parseResetCredencialResponse({ ok: true, tokenDefinicao: 'deadbeef'.repeat(8) });
    expect(parsed.ok).toBe(true);
    expect(parsed.tokenDefinicao).toBe('deadbeef'.repeat(8));
  });

  it('rejeita resposta sem tokenDefinicao', () => {
    expect(() => parseResetCredencialResponse({ ok: true })).toThrow(TypeError);
  });
});

describe('parseAtualizarCredencialResponse (PATCH .../credencial — FASE 5)', () => {
  it('aceita id + ativo', () => {
    expect(parseAtualizarCredencialResponse({ id: 9, ativo: false })).toEqual({ id: 9, ativo: false });
  });

  it('rejeita resposta sem id', () => {
    expect(() => parseAtualizarCredencialResponse({ ativo: true })).toThrow(TypeError);
  });
});
