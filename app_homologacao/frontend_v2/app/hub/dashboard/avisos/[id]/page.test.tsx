// hub-avisos (push-motorista, FASE 7 — tasks.md 7.4.2/7.4.3, complemento do
// E2E deferido à FASE 9): 7.4.2 (polling para exatamente ao atingir
// `concluido`, tolerância a falha transitória) é coberto na ponta do HOOK
// via fake timers (`renderHook` — mesmo idioma de `use-process-status.test.ts`,
// sem Popover/Base UI no meio, então fake timers não colidem com
// ResizeObserver/rAF); os estados visuais (loading/erro/detalhe/rótulo
// FR-022) são cobertos na ponta da PÁGINA com timers reais.
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AvisoDetalhePage, { useAvisoPolling } from './page';
import { AvisoApiError } from '@/lib/hub/avisos-api';
import type { AvisoDetalhe } from '@/lib/hub/avisos-dto';

const mockObterAviso = vi.fn();
const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: '10' }),
  useRouter: () => ({ push: mockPush, back: vi.fn() }),
}));

vi.mock('@/lib/hub/avisos-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/avisos-api')>('@/lib/hub/avisos-api');
  return {
    ...actual,
    obterAviso: (...args: unknown[]) => mockObterAviso(...args),
  };
});

const DETALHE_EM_ANDAMENTO: AvisoDetalhe = {
  id: 10,
  titulo: 'Manutenção programada',
  corpo: 'O sistema ficará indisponível às 22h.',
  status: 'em_andamento',
  modoDestinatarios: 'toda_base',
  destinatarios: {},
  criadoEm: '2026-09-01T10:00:00Z',
  iniciadoEm: '2026-09-01T10:00:05Z',
  concluidoEm: null,
  contagens: { visados: 20, pendentes: 5, processando: 3, aceitos: 10, falhas: 1, mortas: 1 },
};

const DETALHE_CONCLUIDO: AvisoDetalhe = {
  ...DETALHE_EM_ANDAMENTO,
  status: 'concluido',
  concluidoEm: '2026-09-01T10:02:00Z',
  contagens: { visados: 20, pendentes: 0, processando: 0, aceitos: 17, falhas: 2, mortas: 1 },
};

describe('AvisoDetalhePage', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mockObterAviso.mockReset();
    mockPush.mockReset();
  });

  it('renderiza o detalhe com o rótulo FR-022 ("Aceitos pelo serviço de push", nunca "lidos"/"entregues")', async () => {
    mockObterAviso.mockResolvedValue(DETALHE_CONCLUIDO);
    render(<AvisoDetalhePage />);

    expect(screen.getByText('Carregando aviso...')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Manutenção programada')).toBeInTheDocument());

    expect(screen.getByText('Aceitos pelo serviço de push')).toBeInTheDocument();
    expect(screen.queryByText(/lidos/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/entregues/i)).not.toBeInTheDocument();
    expect(screen.getByText('17')).toBeInTheDocument();
  });

  it('resume destinatários do modo empresa pelos nomes retornados', async () => {
    mockObterAviso.mockResolvedValue({
      ...DETALHE_CONCLUIDO,
      modoDestinatarios: 'empresa',
      destinatarios: { empresas: [{ id: 1, nome: 'Filial Sul' }, { id: 2, nome: 'Filial Norte' }] },
    });
    render(<AvisoDetalhePage />);
    await waitFor(() => expect(screen.getByText(/Filial Sul, Filial Norte/)).toBeInTheDocument());
  });

  it('resume destinatários do modo individual pela quantidade', async () => {
    mockObterAviso.mockResolvedValue({
      ...DETALHE_CONCLUIDO,
      modoDestinatarios: 'individual',
      destinatarios: { qtdMotoristas: 4 },
    });
    render(<AvisoDetalhePage />);
    await waitFor(() => expect(screen.getByText('4 motorista(s) selecionado(s)')).toBeInTheDocument());
  });

  it('estado de erro (sem detalhe ainda): mensagem + retry', async () => {
    mockObterAviso.mockRejectedValueOnce(new AvisoApiError(404, 'Aviso não encontrado.'));
    render(<AvisoDetalhePage />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Aviso não encontrado.'));

    mockObterAviso.mockResolvedValueOnce(DETALHE_CONCLUIDO);
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => expect(mockObterAviso).toHaveBeenCalledTimes(2));
  });
});

describe('useAvisoPolling — 7.4.2 (para exatamente em concluido; tolera falha transitória)', () => {
  const POLL_MS = 4000;

  beforeEach(() => {
    mockObterAviso.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // O `setInterval` de `iniciarPolling` nasce dentro do `.then()` da 1ª
  // busca (efeito de mount) — para `vi.advanceTimersByTimeAsync` conseguir
  // "ver" esse interval, os timers falsos precisam estar ativos DESDE ANTES
  // do render (senão o interval nasce como um timer REAL, imune ao avanço
  // manual do relógio). Diferente de `use-process-status.test.ts`, onde o
  // interval só nasce sob demanda (`startProcess()`), depois de já estarmos
  // em fake timers.

  it('para de fazer polling assim que status = concluido', async () => {
    vi.useFakeTimers();
    mockObterAviso.mockResolvedValueOnce(DETALHE_EM_ANDAMENTO).mockResolvedValueOnce(DETALHE_CONCLUIDO);
    const { result } = renderHook(() => useAvisoPolling(10));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.detalhe?.status).toBe('em_andamento');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(result.current.detalhe?.status).toBe('concluido');
    expect(mockObterAviso).toHaveBeenCalledTimes(2);

    // Mais um ciclo do intervalo NÃO dispara nova consulta — já parou.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    });
    expect(mockObterAviso).toHaveBeenCalledTimes(2);
  });

  it('tolera falha transitória isolada (não pausa antes de 3 falhas seguidas)', async () => {
    vi.useFakeTimers();
    mockObterAviso.mockResolvedValueOnce(DETALHE_EM_ANDAMENTO);
    const { result } = renderHook(() => useAvisoPolling(10));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.detalhe?.status).toBe('em_andamento');

    mockObterAviso.mockRejectedValueOnce(new Error('timeout'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(result.current.atualizacaoPausada).toBe(false);

    mockObterAviso.mockResolvedValueOnce(DETALHE_EM_ANDAMENTO);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(result.current.atualizacaoPausada).toBe(false);
  });
});
