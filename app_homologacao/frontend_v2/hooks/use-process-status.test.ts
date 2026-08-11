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

// impeccable rodada 7 (P1) — erro de transporte não é informação sobre o
// processo. Antes, um poll que falhava zerava `isActive` e `estavaAtivoRef`:
// a tela dizia "Parado" no meio de um envio, o botão Iniciar reabilitava
// (disparo duplicado para motorista real) e a virada ativo → inativo era
// apagada, então o recibo nunca aparecia.
describe('useProcessStatus — falha de poll preserva o último estado conhecido', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('poll que falha durante o disparo NÃO declara "Parado"', async () => {
    // Começa parado para o effect inicial não criar intervalo com timer real;
    // o `startProcess` abaixo cria o polling já sob fake timers (mesmo padrão
    // dos casos acima).
    mockGet.mockResolvedValue({ active: false });
    const onRefresh = vi.fn();
    const { result } = renderHook(() => useProcessStatus({ onRefresh }));
    await waitFor(() => expect(mockGet).toHaveBeenCalled());

    vi.useFakeTimers();
    await act(async () => {
      await result.current.startProcess();
    });
    expect(result.current.isActive).toBe(true);

    mockGet.mockRejectedValue(new Error('network'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });

    // O que o operador vê: continua ativo, agora com a incerteza declarada.
    expect(result.current.isActive).toBe(true);
    expect(result.current.statusIndisponivel).toBe(true);
  });

  it('o recibo ainda aparece quando o poll falha e depois se recupera', async () => {
    mockGet.mockResolvedValue({ active: false });
    const onRefresh = vi.fn();
    const { result } = renderHook(() => useProcessStatus({ onRefresh }));
    await waitFor(() => expect(mockGet).toHaveBeenCalled());

    vi.useFakeTimers();
    await act(async () => {
      await result.current.startProcess();
    });

    mockGet.mockRejectedValue(new Error('network'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(result.current.disparoConcluido).toBe(false);

    // Rede volta e o processo terminou de verdade: a virada foi preservada.
    mockGet.mockResolvedValue({ active: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(result.current.isActive).toBe(false);
    expect(result.current.statusIndisponivel).toBe(false);
    expect(result.current.disparoConcluido).toBe(true);
  });

  // impeccable rodada 17 (h1) — os marcos que substituem o anúncio por tick.
  it('anuncia início e fim, e NADA enquanto o disparo segue', async () => {
    mockGet.mockResolvedValue({ active: false });
    const onRefresh = vi.fn();
    const { result } = renderHook(() => useProcessStatus({ onRefresh }));
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(result.current.anuncio).toBeNull();

    vi.useFakeTimers();
    mockGet.mockResolvedValue({ active: true });
    // O polling só existe a partir do disparo — e é o próprio `startProcess`
    // que sabe do início (o poll nunca veria a virada, porque ele já marca o
    // estado anterior como ativo).
    await act(async () => {
      await result.current.startProcess();
    });
    expect(result.current.anuncio).toBe('Disparo iniciado.');

    // A mensagem é transitória: sai depois de anunciada, para não ficar no
    // documento como texto permanente.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current.anuncio).toBeNull();

    // Três ciclos de polling com o disparo em andamento: NADA é anunciado.
    // É exatamente isto que a rodada corrige — antes, cada ciclo virava um
    // anúncio de progresso.
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_MS);
      });
      expect(result.current.anuncio, `ciclo ${i + 1}`).toBeNull();
    }

    mockGet.mockResolvedValue({ active: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(result.current.anuncio).toBe('Disparo concluído.');
    vi.useRealTimers();
  });
});
