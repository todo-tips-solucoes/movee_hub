// hub-importacoes (S4) FASE 6 task 6.2.4 — transição de estado reflete na
// UI (mock de polling: pending -> processing -> completed), erros
// paginados + download CSV, ações reprocessar/cancelar/baixar original
// condicionadas ao status e à permissão.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ImportacaoDetalhePage from './page';
import { ImportacaoApiError } from '@/lib/hub/importacoes-api';

const mockUseHubAuth = vi.fn();
const mockObterImportacao = vi.fn();
const mockListarErros = vi.fn();
const mockReprocessar = vi.fn();
const mockCancelar = vi.fn();
const mockBaixarOriginal = vi.fn();
const mockBaixarErrosCsv = vi.fn();
const mockPush = vi.fn();

vi.mock('@/contexts/hub-auth-context', () => ({
  useHubAuth: () => mockUseHubAuth(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: '10' }),
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/lib/hub/importacoes-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/importacoes-api')>('@/lib/hub/importacoes-api');
  return {
    ...actual,
    obterImportacao: (...args: unknown[]) => mockObterImportacao(...args),
    listarErros: (...args: unknown[]) => mockListarErros(...args),
    reprocessarImportacao: (...args: unknown[]) => mockReprocessar(...args),
    cancelarImportacao: (...args: unknown[]) => mockCancelar(...args),
    baixarOriginal: (...args: unknown[]) => mockBaixarOriginal(...args),
    baixarErrosCsv: (...args: unknown[]) => mockBaixarErrosCsv(...args),
  };
});

const DETALHE_BASE = {
  id: 10,
  tipo: 'faturamento' as const,
  contadores: { total: 100, validas: 90, invalidas: 10 },
  dataReferencia: '2026-07-01',
  iniciadoEm: '2026-07-01T10:00:00Z',
  concluidoEm: null,
  duracaoSegundos: null,
  erroResumo: null,
};

function withPermissoes(permissoes: string[]) {
  mockUseHubAuth.mockReturnValue({ permissoes });
}

describe('ImportacaoDetalhePage', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mockUseHubAuth.mockReset();
    mockObterImportacao.mockReset();
    mockListarErros.mockReset();
    mockReprocessar.mockReset();
    mockCancelar.mockReset();
    mockBaixarOriginal.mockReset();
    mockBaixarErrosCsv.mockReset();
    withPermissoes(['importacoes.consultar', 'importacoes.criar', 'importacoes.exportar']);
    mockListarErros.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('status processing: sem botões de ação (nenhum estado terminal p/ reprocessar/cancelar-fora-do-range)', async () => {
    mockObterImportacao.mockResolvedValueOnce({ ...DETALHE_BASE, status: 'processing' });
    render(<ImportacaoDetalhePage />);

    await waitFor(() => expect(screen.getByText('Processando')).toBeInTheDocument());
    // processing É cancelável (contract), mas NÃO reprocessável.
    expect(screen.getByRole('button', { name: /Cancelar/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reprocessar/ })).not.toBeInTheDocument();
  });

  it('status failed: mostra erroResumo + botão Reprocessar (não Cancelar)', async () => {
    mockObterImportacao.mockResolvedValueOnce({
      ...DETALHE_BASE,
      status: 'failed',
      erroResumo: 'Cabeçalho inválido',
    });
    render(<ImportacaoDetalhePage />);

    await waitFor(() => expect(screen.getByText('Falhou')).toBeInTheDocument());
    expect(screen.getByText('Cabeçalho inválido')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reprocessar/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cancelar/ })).not.toBeInTheDocument();
  });

  it('status completed: nenhum botão reprocessar/cancelar; baixar original visível com permissão exportar', async () => {
    mockObterImportacao.mockResolvedValueOnce({ ...DETALHE_BASE, status: 'completed', concluidoEm: '2026-07-01T10:05:00Z' });
    render(<ImportacaoDetalhePage />);

    await waitFor(() => expect(screen.getByText('Concluída')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Reprocessar/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cancelar/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Baixar original/ })).toBeInTheDocument();
  });

  it('sem permissão importacoes.exportar: botão baixar original não aparece', async () => {
    withPermissoes(['importacoes.consultar']);
    mockObterImportacao.mockResolvedValueOnce({ ...DETALHE_BASE, status: 'completed' });
    render(<ImportacaoDetalhePage />);

    await waitFor(() => expect(screen.getByText('Concluída')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Baixar original/ })).not.toBeInTheDocument();
  });

  it('aciona reprocessar: chama a API e re-busca o detalhe', async () => {
    mockObterImportacao
      .mockResolvedValueOnce({ ...DETALHE_BASE, status: 'failed', erroResumo: 'erro X' })
      .mockResolvedValueOnce({ ...DETALHE_BASE, status: 'pending', erroResumo: null });
    mockReprocessar.mockResolvedValueOnce({ id: 10, status: 'pending' });
    render(<ImportacaoDetalhePage />);

    await waitFor(() => expect(screen.getByRole('button', { name: /Reprocessar/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Reprocessar/ }));

    await waitFor(() => expect(mockReprocessar).toHaveBeenCalledWith(10));
    await waitFor(() => expect(screen.getByText('Pendente')).toBeInTheDocument());
  });

  it('aciona cancelar: chama a API e re-busca o detalhe', async () => {
    mockObterImportacao
      .mockResolvedValueOnce({ ...DETALHE_BASE, status: 'pending' })
      .mockResolvedValueOnce({ ...DETALHE_BASE, status: 'cancelled' });
    mockCancelar.mockResolvedValueOnce({ id: 10, status: 'cancelled' });
    render(<ImportacaoDetalhePage />);

    await waitFor(() => expect(screen.getByRole('button', { name: /Cancelar/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Cancelar/ }));

    await waitFor(() => expect(mockCancelar).toHaveBeenCalledWith(10));
    await waitFor(() => expect(screen.getByText('Cancelada')).toBeInTheDocument());
  });

  it('erro ao reprocessar (409 CONFLITO) mostra mensagem sem quebrar a tela', async () => {
    mockObterImportacao.mockResolvedValue({ ...DETALHE_BASE, status: 'failed' });
    mockReprocessar.mockRejectedValueOnce(new ImportacaoApiError(409, 'CONFLITO'));
    render(<ImportacaoDetalhePage />);

    await waitFor(() => expect(screen.getByRole('button', { name: /Reprocessar/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Reprocessar/ }));

    await waitFor(() => expect(screen.getByText('CONFLITO')).toBeInTheDocument());
  });

  it('tabela de erros: renderiza itens paginados com valorMascarado (LGPD) + botão CSV quando total>0', async () => {
    mockObterImportacao.mockResolvedValueOnce({ ...DETALHE_BASE, status: 'completed_with_errors' });
    mockListarErros.mockReset();
    mockListarErros.mockResolvedValueOnce({
      items: [{ numeroLinha: 3, campo: 'cnpj', motivo: 'formato inválido', valorMascarado: '12***89' }],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    render(<ImportacaoDetalhePage />);

    await waitFor(() => expect(screen.getByText('12***89')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Baixar CSV/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Baixar CSV/ }));
    expect(mockBaixarErrosCsv).toHaveBeenCalledWith(10);
  });

  it('sem erros: mostra estado vazio e nenhum botão de CSV', async () => {
    mockObterImportacao.mockResolvedValueOnce({ ...DETALHE_BASE, status: 'completed' });
    render(<ImportacaoDetalhePage />);

    await waitFor(() => expect(screen.getByText('Nenhum erro registrado nesta importação.')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Baixar CSV/ })).not.toBeInTheDocument();
  });
});
