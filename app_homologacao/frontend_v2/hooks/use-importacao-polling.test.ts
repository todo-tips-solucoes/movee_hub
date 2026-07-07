// hub-importacoes (S4) FASE 6 task 6.2.1/6.2.4 — polling do detalhe
// enquanto `status ∈ {pending, validating, processing}`
// (contracts/importacoes-api.md §GET /importacoes/:id).
//
// Usa timers REAIS com um intervalo bem curto (`intervalMs`) — misturar
// fake timers com `waitFor` (que também depende de timers internamente)
// é frágil; o mesmo padrão real-timer já é usado nos testes de página
// desta feature (`[id]/page.test.tsx`).
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useImportacaoPolling } from './use-importacao-polling';
import { ImportacaoApiError } from '@/lib/hub/importacoes-api';

const mockObterImportacao = vi.fn();

vi.mock('@/lib/hub/importacoes-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/importacoes-api')>('@/lib/hub/importacoes-api');
  return {
    ...actual,
    obterImportacao: (...args: unknown[]) => mockObterImportacao(...args),
  };
});

const DETALHE = {
  id: 1,
  tipo: 'faturamento' as const,
  contadores: { total: 10, validas: 8, invalidas: 2 },
  dataReferencia: null,
  iniciadoEm: null,
  concluidoEm: null,
  duracaoSegundos: null,
  erroResumo: null,
};

const INTERVALO_TESTE_MS = 20;

function esperarMs(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('useImportacaoPolling', () => {
  beforeEach(() => {
    mockObterImportacao.mockReset();
  });

  it('busca 1 vez e PARA de fazer polling quando o status já é terminal (completed)', async () => {
    mockObterImportacao.mockResolvedValueOnce({ ...DETALHE, status: 'completed' });
    const { result } = renderHook(() => useImportacaoPolling(1, INTERVALO_TESTE_MS));

    await waitFor(() => expect(result.current.detalhe?.status).toBe('completed'));
    expect(mockObterImportacao).toHaveBeenCalledTimes(1);

    await esperarMs(INTERVALO_TESTE_MS * 5);
    expect(mockObterImportacao).toHaveBeenCalledTimes(1);
  });

  it('transição pending -> processing -> completed: mantém polling até status terminal', async () => {
    mockObterImportacao
      .mockResolvedValueOnce({ ...DETALHE, status: 'pending' })
      .mockResolvedValueOnce({ ...DETALHE, status: 'processing' })
      .mockResolvedValueOnce({ ...DETALHE, status: 'completed' });

    const { result } = renderHook(() => useImportacaoPolling(1, INTERVALO_TESTE_MS));

    // Intervalo de teste é curto o bastante para as 3 chamadas emendarem
    // antes do 1º poll do `waitFor` — o que já demonstra que o hook NÃO
    // trava em nenhum status intermediário (senão nunca chegaria a
    // 'completed'). O que importa auditar aqui é: (a) os 3 estados foram
    // de fato consultados em sequência (mock encadeado, 1 por chamada) e
    // (b) o polling PARA assim que o status vira terminal.
    await waitFor(() => expect(result.current.detalhe?.status).toBe('completed'));
    expect(mockObterImportacao).toHaveBeenCalledTimes(3);

    const chamadasAoParar = mockObterImportacao.mock.calls.length;
    await esperarMs(INTERVALO_TESTE_MS * 5);
    // Depois de completed, o polling já parou — sem chamadas extras.
    expect(mockObterImportacao.mock.calls.length).toBe(chamadasAoParar);
  });

  it('falha de rede: expõe mensagem de erro e para o polling', async () => {
    mockObterImportacao.mockRejectedValueOnce(new ImportacaoApiError(500, 'Erro no servidor.'));
    const { result } = renderHook(() => useImportacaoPolling(1, INTERVALO_TESTE_MS));

    await waitFor(() => expect(result.current.erro).toBe('Erro no servidor.'));
    expect(result.current.detalhe).toBeNull();

    await esperarMs(INTERVALO_TESTE_MS * 5);
    expect(mockObterImportacao).toHaveBeenCalledTimes(1);
  });
});
