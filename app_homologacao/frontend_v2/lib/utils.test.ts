// impeccable rodada 14 (h3) — `temFiltroAtivo` decide se uma ação que
// SUBSTITUI os filtros precisa avisar. Errar para menos cala um aviso quando
// havia trabalho a perder; errar para mais enche a tela de aviso sobre nada.
import { describe, expect, it } from 'vitest';
import { initialFilters, temFiltroAtivo } from './utils';

describe('temFiltroAtivo', () => {
  it('padrão intocado não conta como filtro ativo', () => {
    expect(temFiltroAtivo(initialFilters)).toBe(false);
  });

  it('campo de texto preenchido conta', () => {
    expect(temFiltroAtivo({ ...initialFilters, nome: 'silva' })).toBe(true);
  });

  it('select fora de "all" conta', () => {
    expect(temFiltroAtivo({ ...initialFilters, enviado: 'yes' })).toBe(true);
  });

  it('varre TODAS as chaves do padrão, não uma lista à parte', () => {
    // Um filtro novo em `initialFilters` precisa entrar na conta sozinho —
    // uma lista escrita à mão aqui envelheceria em silêncio.
    for (const chave of Object.keys(initialFilters) as (keyof typeof initialFilters)[]) {
      const alterado = { ...initialFilters, [chave]: 'valor-diferente' };
      expect(temFiltroAtivo(alterado), chave).toBe(true);
    }
  });
});
