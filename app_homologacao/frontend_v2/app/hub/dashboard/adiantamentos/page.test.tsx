// adiantamento-motorista (FASE 7, tasks.md 7.3.1, H01): estados de
// loading/vazio/erro/lista da tela de solicitações. Mesmo molde de
// `app/hub/dashboard/avisos/page.test.tsx`.
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdiantamentosSolicitacoesPage from './page';
import { AdiantamentosApiError } from '@/lib/hub/adiantamentos-api';

const mockUseHubAuth = vi.fn();
const mockListarSolicitacoes = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => '/hub/dashboard/adiantamentos',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

vi.mock('@/contexts/hub-auth-context', () => ({
  useHubAuth: () => mockUseHubAuth(),
}));

vi.mock('@/lib/hub/adiantamentos-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/adiantamentos-api')>('@/lib/hub/adiantamentos-api');
  return {
    ...actual,
    listarSolicitacoes: (...args: unknown[]) => mockListarSolicitacoes(...args),
  };
});

const ITEM_BASE = {
  id: 501,
  integrationId: 'ADV-000501',
  motorista: { entregadorId: 42, nome: 'Marta Queiroz' },
  dataSolicitacao: '2026-09-17',
  dataProducao: '2026-09-16',
  status: 'LIBERADA',
  motivoStatus: null,
  valorLiquido: '150.79',
  pendencias: [],
  loteId: null,
};

describe('AdiantamentosSolicitacoesPage', () => {
  beforeEach(() => {
    mockUseHubAuth.mockReset();
    mockListarSolicitacoes.mockReset();
    mockUseHubAuth.mockReturnValue({ permissoes: ['adiantamentos.consultar', 'adiantamentos.pagamentos_consultar', 'adiantamentos.contas_consultar'] });
  });

  it('mostra loading e depois a lista com os itens reais', async () => {
    mockListarSolicitacoes.mockResolvedValueOnce({ itens: [ITEM_BASE], total: 1, page: 1, pageSize: 20 });
    render(<AdiantamentosSolicitacoesPage />);

    expect(screen.getByText('Carregando solicitações...')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('ADV-000501').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Marta Queiroz').length).toBeGreaterThan(0);
    expect(screen.getAllByText('R$ 150,79').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Adiantamento liberado').length).toBeGreaterThan(0);
  });

  it('lista vazia mostra o empty state', async () => {
    mockListarSolicitacoes.mockResolvedValueOnce({ itens: [], total: 0, page: 1, pageSize: 20 });
    render(<AdiantamentosSolicitacoesPage />);
    await waitFor(() => expect(screen.getByText('Nenhuma solicitação encontrada')).toBeInTheDocument());
  });

  it('erro de rede mostra a mensagem e o botão de tentar novamente', async () => {
    mockListarSolicitacoes.mockRejectedValueOnce(new AdiantamentosApiError(500, 'Erro no servidor. Tente novamente em instantes.'));
    render(<AdiantamentosSolicitacoesPage />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Erro no servidor'));
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeInTheDocument();
  });

  it('7.2.4 (integração com AdiantamentosAbas): sem permissão de contas, a aba Contas some da navegação', async () => {
    mockUseHubAuth.mockReturnValue({ permissoes: ['adiantamentos.consultar', 'adiantamentos.pagamentos_consultar'] });
    mockListarSolicitacoes.mockResolvedValueOnce({ itens: [], total: 0, page: 1, pageSize: 20 });
    render(<AdiantamentosSolicitacoesPage />);
    await waitFor(() => expect(mockListarSolicitacoes).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: 'Contas bancárias' })).not.toBeInTheDocument();
  });
});
