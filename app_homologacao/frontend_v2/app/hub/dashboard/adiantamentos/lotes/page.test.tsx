// adiantamento-motorista (FASE 7, tasks.md 7.7.1, H13): histórico de lotes
// com status e filtros. Mesmo molde de `contas/page.test.tsx`.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdiantamentosLotesPage from './page';
import { escolherNoSelect } from '@/lib/test-helpers/select';

const mockListarLotes = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => '/hub/dashboard/adiantamentos/lotes',
}));

vi.mock('@/contexts/hub-auth-context', () => ({
  useHubAuth: () => ({ permissoes: ['adiantamentos.consultar', 'adiantamentos.pagamentos_consultar'] }),
}));

vi.mock('@/lib/hub/adiantamentos-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/adiantamentos-api')>('@/lib/hub/adiantamentos-api');
  return {
    ...actual,
    listarLotes: (...args: unknown[]) => mockListarLotes(...args),
  };
});

const LOTE_BASE = {
  id: 123,
  numero: '000123',
  status: 'GERADO',
  criadoPor: { id: 1, nome: 'Ana Financeiro' },
  criadoEm: '2026-09-17T15:42:00Z',
  quantidade: 149,
  valorTotal: '48320.55',
  arquivoNome: 'transfeera_adiantamentos_2026-09-17_lote-000123.xlsx',
  arquivoSha256: 'abc123',
  downloads: 0,
  primeiroDownloadEm: null,
  canceladoEm: null,
  canceladoMotivo: null,
  concluidoEm: null,
};

describe('AdiantamentosLotesPage', () => {
  beforeEach(() => {
    mockListarLotes.mockReset();
  });

  it('mostra loading e depois a lista com status', async () => {
    mockListarLotes.mockResolvedValueOnce({ itens: [LOTE_BASE], total: 1, page: 1, pageSize: 20 });
    render(<AdiantamentosLotesPage />);

    expect(screen.getByText('Carregando histórico de lotes...')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('#000123').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Gerado').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Ana Financeiro').length).toBeGreaterThan(0);
  });

  it('lista vazia mostra o empty state', async () => {
    mockListarLotes.mockResolvedValueOnce({ itens: [], total: 0, page: 1, pageSize: 20 });
    render(<AdiantamentosLotesPage />);
    await waitFor(() => expect(screen.getByText('Nenhum lote encontrado')).toBeInTheDocument());
  });

  it('7.7.1: filtro de status repassa o valor para listarLotes', async () => {
    mockListarLotes.mockResolvedValue({ itens: [LOTE_BASE], total: 1, page: 1, pageSize: 20 });
    render(<AdiantamentosLotesPage />);
    await waitFor(() => expect(screen.getAllByText('#000123').length).toBeGreaterThan(0));

    await escolherNoSelect('Status', 'CANCELADO');

    await waitFor(() => expect(mockListarLotes).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'CANCELADO' })));
  });

  it('responsável numérico (sem objeto) mostra "Usuário #id"', async () => {
    mockListarLotes.mockResolvedValueOnce({ itens: [{ ...LOTE_BASE, criadoPor: 7 }], total: 1, page: 1, pageSize: 20 });
    render(<AdiantamentosLotesPage />);
    await waitFor(() => expect(screen.getByText('Usuário #7')).toBeInTheDocument());
  });

  it('link "Detalhes" aponta para a rota do lote', async () => {
    mockListarLotes.mockResolvedValueOnce({ itens: [LOTE_BASE], total: 1, page: 1, pageSize: 20 });
    render(<AdiantamentosLotesPage />);
    await waitFor(() => expect(screen.getByRole('link', { name: 'Detalhes' })).toHaveAttribute('href', '/hub/dashboard/adiantamentos/lotes/123'));
  });
});
