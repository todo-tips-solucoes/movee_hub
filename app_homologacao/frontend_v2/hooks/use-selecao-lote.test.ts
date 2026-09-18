// adiantamento-motorista — hooks/use-selecao-lote.test.ts (tasks.md 7.6.1)
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITE_LOTE, useSelecaoLote } from './use-selecao-lote';

const mockListarSolicitacoes = vi.fn();

vi.mock('@/lib/hub/adiantamentos-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/adiantamentos-api')>('@/lib/hub/adiantamentos-api');
  return {
    ...actual,
    listarSolicitacoes: (...args: unknown[]) => mockListarSolicitacoes(...args),
  };
});

describe('useSelecaoLote', () => {
  beforeEach(() => {
    mockListarSolicitacoes.mockReset();
  });

  it('toggle marca e desmarca um id', () => {
    const { result } = renderHook(() => useSelecaoLote());
    act(() => result.current.toggle(10));
    expect(result.current.selecionados.has(10)).toBe(true);
    act(() => result.current.toggle(10));
    expect(result.current.selecionados.has(10)).toBe(false);
  });

  it('toggleTodosDaPagina marca todos e, se já todos marcados, desmarca todos — sem afetar outras páginas', () => {
    const { result } = renderHook(() => useSelecaoLote());
    act(() => result.current.toggle(99)); // de "outra página"
    act(() => result.current.toggleTodosDaPagina([1, 2, 3]));
    expect([...result.current.selecionados].sort()).toEqual([1, 2, 3, 99]);
    act(() => result.current.toggleTodosDaPagina([1, 2, 3]));
    expect([...result.current.selecionados].sort()).toEqual([99]);
  });

  it('limpar zera a seleção', () => {
    const { result } = renderHook(() => useSelecaoLote());
    act(() => result.current.toggle(1));
    act(() => result.current.limpar());
    expect(result.current.selecionados.size).toBe(0);
  });

  it('selecionarTodosDoFiltro pagina até esgotar o total e substitui a seleção', async () => {
    mockListarSolicitacoes
      .mockResolvedValueOnce({ itens: Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })), total: 152, page: 1, pageSize: 100 })
      .mockResolvedValueOnce({ itens: Array.from({ length: 52 }, (_, i) => ({ id: i + 101 })), total: 152, page: 2, pageSize: 100 });
    const { result } = renderHook(() => useSelecaoLote());

    let total = 0;
    await act(async () => {
      total = await result.current.selecionarTodosDoFiltro({ status: 'LIBERADA' });
    });

    expect(total).toBe(152);
    expect(result.current.selecionados.size).toBe(152);
    expect(mockListarSolicitacoes).toHaveBeenCalledTimes(2);
    expect(mockListarSolicitacoes).toHaveBeenNthCalledWith(1, { status: 'LIBERADA', page: 1, pageSize: 100 });
  });

  it('selecionarTodosDoFiltro nunca ultrapassa LIMITE_LOTE (edge #25)', async () => {
    // total do filtro (6000) excede o limite de 5.000 do parceiro de pagamento.
    mockListarSolicitacoes.mockImplementation(({ page }: { page: number }) =>
      Promise.resolve({
        itens: Array.from({ length: 100 }, (_, i) => ({ id: (page - 1) * 100 + i + 1 })),
        total: 6000,
        page,
        pageSize: 100,
      })
    );
    const { result } = renderHook(() => useSelecaoLote());

    let total = 0;
    await act(async () => {
      total = await result.current.selecionarTodosDoFiltro({});
    });

    expect(total).toBe(6000);
    expect(result.current.selecionados.size).toBe(LIMITE_LOTE);
  });

  it('carregandoTodos liga durante a busca e desliga ao final', async () => {
    let resolver: (v: unknown) => void = () => {};
    mockListarSolicitacoes.mockReturnValueOnce(
      new Promise((resolve) => { resolver = resolve; })
    );
    const { result } = renderHook(() => useSelecaoLote());

    let promise!: Promise<number>;
    act(() => {
      promise = result.current.selecionarTodosDoFiltro({});
    });
    await waitFor(() => expect(result.current.carregandoTodos).toBe(true));

    resolver({ itens: [], total: 0, page: 1, pageSize: 100 });
    await act(async () => { await promise; });
    expect(result.current.carregandoTodos).toBe(false);
  });
});
