// impeccable rodada 6 (P1-2) — o refresh da VIRADA ativo → inativo.
//
// Antes, `onRefresh` só rodava enquanto o processo estava ativo: a tela
// terminava o disparo mostrando os números do penúltimo poll. O recibo do
// disparo (e os cards) dependem desse último refresh para não mentir.
//
// Fake timers aqui (e não intervalo curto como em use-importacao-polling)
// porque o intervalo de 13s é fixo dentro do hook, sem parâmetro.
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProcessStatus } from './use-process-status';

const mockGet = vi.fn();
const mockPost = vi.fn();

vi.mock('@/lib/api-client', () => ({
  api: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

const POLL_MS = 13000;

describe('useProcessStatus — refresh na virada', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('processo parado desde sempre: não refresca à toa', async () => {
    mockGet.mockResolvedValue({ active: false });
    const onRefresh = vi.fn();
    const { result } = renderHook(() => useProcessStatus({ onRefresh }));

    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(result.current.isActive).toBe(false);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('ativo → inativo: refresca UMA vez no fim e não repete nos polls seguintes', async () => {
    mockGet.mockResolvedValue({ active: false });
    const onRefresh = vi.fn();
    const { result } = renderHook(() => useProcessStatus({ onRefresh }));
    await waitFor(() => expect(mockGet).toHaveBeenCalled());

    vi.useFakeTimers();
    await act(async () => {
      await result.current.startProcess();
    });
    expect(result.current.isActive).toBe(true);

    // 1º poll depois do início já devolve inativo — o disparo terminou.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(result.current.isActive).toBe(false);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(result.current.disparoConcluido).toBe(true);

    // Polls seguintes continuam inativos: nada de refetch em loop.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('nunca acende o recibo sem um disparo antes (mount com processo parado)', async () => {
    mockGet.mockResolvedValue({ active: false });
    // `onRefresh` estável, como na tela real (`fetchData` é useCallback): um
    // callback novo a cada render remontaria o efeito de polling do hook.
    const onRefresh = vi.fn();
    const { result } = renderHook(() => useProcessStatus({ onRefresh }));

    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(result.current.disparoConcluido).toBe(false);
  });

  it('parar na mão acende o recibo; dispensar apaga; disparo novo apaga', async () => {
    mockGet.mockResolvedValue({ active: false });
    const onRefresh = vi.fn();
    const { result } = renderHook(() => useProcessStatus({ onRefresh }));
    await waitFor(() => expect(mockGet).toHaveBeenCalled());

    await act(async () => {
      await result.current.startProcess();
    });
    await act(async () => {
      await result.current.stopProcess();
    });
    expect(result.current.disparoConcluido).toBe(true);

    act(() => result.current.dispensarRecibo());
    expect(result.current.disparoConcluido).toBe(false);

    await act(async () => {
      await result.current.startProcess();
    });
    await act(async () => {
      await result.current.stopProcess();
    });
    expect(result.current.disparoConcluido).toBe(true);

    // Um disparo novo limpa o recibo do anterior antes de qualquer poll.
    await act(async () => {
      await result.current.startProcess();
    });
    expect(result.current.disparoConcluido).toBe(false);
  });
});
