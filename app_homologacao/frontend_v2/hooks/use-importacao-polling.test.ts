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

  // F8.3 (pós-review PR #57) — 1 falha transiente de fetch NÃO deve encerrar
  // o polling permanentemente: tolera N falhas CONSECUTIVAS antes de parar.
  // Nas 3 cenários abaixo, a 1ª consulta (a do mount) sempre TEM sucesso com
  // status `processing` — precisa iniciar o polling de fato antes de testar
  // sua resiliência a falhas (o hook, por design, só liga o intervalo
  // depois de uma 1ª leitura bem-sucedida em andamento).
  it('1 falha isolada de rede (após polling já ativo): expõe `erro` mas NÃO para o polling (tolerância a falha transiente)', async () => {
    mockObterImportacao
      .mockResolvedValueOnce({ ...DETALHE, status: 'processing' }) // mount: inicia o polling
      .mockRejectedValueOnce(new ImportacaoApiError(500, 'Erro no servidor.'))
      .mockResolvedValueOnce({ ...DETALHE, status: 'completed' });
    const { result } = renderHook(() => useImportacaoPolling(1, INTERVALO_TESTE_MS));

    // Não afirma o estado intermediário 'processing' via waitFor — o
    // intervalo de teste (20ms) é mais rápido que o polling do próprio
    // `waitFor` (padrão ~50ms), então a sequência pode avançar direto até
    // 'completed' antes da 1ª checagem rodar (flakiness de timing, não um
    // bug do hook). O que importa é o estado FINAL + nunca ter pausado.
    await waitFor(() => expect(result.current.detalhe?.status).toBe('completed'));
    expect(result.current.erro).toBeNull();
    expect(result.current.atualizacaoPausada).toBe(false);
    expect(mockObterImportacao.mock.calls.length).toBeGreaterThanOrEqual(3); // 1 sucesso + 1 falha + 1 sucesso
  });

  it('3 falhas CONSECUTIVAS de rede (após polling já ativo): pausa a atualização automática (atualizacaoPausada=true) e para o polling', async () => {
    mockObterImportacao
      .mockResolvedValueOnce({ ...DETALHE, status: 'processing' }) // mount: inicia o polling
      .mockRejectedValue(new ImportacaoApiError(500, 'Erro no servidor.')); // todas as próximas falham
    const { result } = renderHook(() => useImportacaoPolling(1, INTERVALO_TESTE_MS));

    await waitFor(() => expect(result.current.detalhe?.status).toBe('processing'));
    await waitFor(() => expect(result.current.atualizacaoPausada).toBe(true));
    expect(mockObterImportacao.mock.calls.length).toBeGreaterThanOrEqual(4); // 1 sucesso + 3 falhas

    const chamadasAoPausar = mockObterImportacao.mock.calls.length;
    await esperarMs(INTERVALO_TESTE_MS * 5);
    // Depois de pausado, o intervalo foi de fato limpo — sem chamadas extras.
    expect(mockObterImportacao.mock.calls.length).toBe(chamadasAoPausar);
  });

  it('falha seguida de sucesso zera o contador de falhas consecutivas (não acumula entre ciclos separados)', async () => {
    mockObterImportacao
      .mockResolvedValueOnce({ ...DETALHE, status: 'processing' }) // mount: inicia o polling
      .mockRejectedValueOnce(new ImportacaoApiError(500, 'x'))
      .mockResolvedValueOnce({ ...DETALHE, status: 'processing' })
      .mockRejectedValueOnce(new ImportacaoApiError(500, 'x'))
      .mockResolvedValueOnce({ ...DETALHE, status: 'completed' });
    const { result } = renderHook(() => useImportacaoPolling(1, INTERVALO_TESTE_MS));

    await waitFor(() => expect(result.current.detalhe?.status).toBe('completed'));
    // Nunca deveria ter pausado — as falhas estavam intercaladas com
    // sucessos, nunca 3 seguidas.
    expect(result.current.atualizacaoPausada).toBe(false);
  });

  // F8.1 — `iniciarPolling` exposto para o caller reiniciar depois de
  // "Reprocessar" (o polling anterior já tinha parado em status terminal).
  it('iniciarPolling reinicia a consulta periódica depois de já ter parado (fluxo de "Reprocessar")', async () => {
    mockObterImportacao.mockResolvedValueOnce({ ...DETALHE, status: 'failed' });
    const { result } = renderHook(() => useImportacaoPolling(1, INTERVALO_TESTE_MS));

    await waitFor(() => expect(result.current.detalhe?.status).toBe('failed'));
    expect(mockObterImportacao).toHaveBeenCalledTimes(1);

    // Sem reiniciar, nenhuma chamada extra (comportamento pré-existente).
    await esperarMs(INTERVALO_TESTE_MS * 3);
    expect(mockObterImportacao).toHaveBeenCalledTimes(1);

    // Simula reprocessar: status volta a `pending`, caller chama
    // iniciarPolling() explicitamente.
    mockObterImportacao
      .mockResolvedValueOnce({ ...DETALHE, status: 'pending' })
      .mockResolvedValueOnce({ ...DETALHE, status: 'completed' });
    result.current.iniciarPolling();

    await waitFor(() => expect(result.current.detalhe?.status).toBe('completed'));
    expect(mockObterImportacao.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
