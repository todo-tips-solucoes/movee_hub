import { describe, expect, it } from 'vitest';
import { resumirRecusas } from './adiantamento-recusas';
import type { MovimentoRecusado } from './adiantamentos-api';

const r = (motivo: string, n: number): MovimentoRecusado[] =>
  Array.from({ length: n }, (_, i) => ({ entregadorId: i, nome: null, motivo, detalhe: '' }));

describe('resumirRecusas', () => {
  it('agrupa por motivo e conta — numa semana real são centenas, quase todas iguais', () => {
    expect(resumirRecusas([...r('MOVIMENTO_ABERTO', 311), ...r('SEM_CNPJ', 494)]))
      .toBe('494 sem CNPJ no hub · 311 já têm movimento aberto');
  });

  it('o que o operador consegue resolver vem primeiro, não o mais numeroso', () => {
    // MOVIMENTO_ABERTO é maioria, mas SEM_CNPJ é o acionável.
    expect(resumirRecusas([...r('MOVIMENTO_ABERTO', 300), ...r('SEM_CNPJ', 2)]))
      .toBe('2 sem CNPJ no hub · 300 já têm movimento aberto');
  });

  it('lista vazia não inventa texto', () => {
    expect(resumirRecusas([])).toBe('');
  });

  // Backend novo + front antigo: um motivo desconhecido não pode SUMIR do
  // resumo — sumir esconderia recusa do operador.
  it('motivo desconhecido aparece cru, no fim', () => {
    expect(resumirRecusas([...r('SEM_CNPJ', 1), ...r('MOTIVO_NOVO', 5)]))
      .toBe('1 sem CNPJ no hub · 5 MOTIVO_NOVO');
  });
});
