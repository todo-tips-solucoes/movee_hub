// adiantamento-motorista (FASE 7, tasks.md 7.5.1/7.5.3, H06): estados de
// loading/vazio/erro/lista da tela de contas bancárias, e aprovação em massa
// (FR-020). Mesmo molde de `app/hub/dashboard/adiantamentos/page.test.tsx`.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdiantamentosContasPage from './page';
import { AdiantamentosApiError } from '@/lib/hub/adiantamentos-api';

const mockUseHubAuth = vi.fn();
const mockListarContas = vi.fn();
const mockAprovarContasEmLote = vi.fn();
// vi.mock é hoisted ao topo do arquivo — o factory de 'sonner' roda antes de
// qualquer `const` deste módulo ser inicializado; `vi.hoisted` garante que
// `mockToast` já exista nesse ponto (mesmo gotcha de `vi.mock('next/navigation')`
// não ter esse problema por só REFERENCIAR os mocks dentro de closures lazy).
const { mockToast } = vi.hoisted(() => ({
  mockToast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/hub/dashboard/adiantamentos/contas',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

vi.mock('sonner', () => ({ toast: mockToast }));

vi.mock('@/contexts/hub-auth-context', () => ({
  useHubAuth: () => mockUseHubAuth(),
}));

vi.mock('@/lib/hub/adiantamentos-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/adiantamentos-api')>('@/lib/hub/adiantamentos-api');
  return {
    ...actual,
    listarContas: (...args: unknown[]) => mockListarContas(...args),
    aprovarContasEmLote: (...args: unknown[]) => mockAprovarContasEmLote(...args),
  };
});

const CONTA_BASE = {
  id: 5021,
  status: 'PENDENTE',
  origem: 'CARGA_INICIAL',
  banco: 'Banco Inter',
  agencia: '0001',
  contaMascarada: '••••8812-0',
  tipoConta: 'CORRENTE' as const,
  titularNome: 'Joana Ribeiro',
  documentoMascarado: '***.***.***-90',
  alertas: [],
  motivoRejeicao: null,
  solicitadaEm: '2026-09-16T18:22:00Z',
  revisadaEm: null,
};

describe('AdiantamentosContasPage', () => {
  beforeEach(() => {
    mockUseHubAuth.mockReset();
    mockListarContas.mockReset();
    mockAprovarContasEmLote.mockReset();
    mockToast.success.mockReset();
    mockToast.error.mockReset();
    mockToast.warning.mockReset();
    mockUseHubAuth.mockReturnValue({
      permissoes: ['adiantamentos.consultar', 'adiantamentos.contas_consultar', 'adiantamentos.contas_revisar'],
    });
  });

  it('mostra loading e depois a lista com os itens reais (nunca dado desmascarado)', async () => {
    mockListarContas.mockResolvedValueOnce({ itens: [CONTA_BASE], total: 1, page: 1, pageSize: 20 });
    render(<AdiantamentosContasPage />);

    expect(screen.getByText('Carregando contas bancárias...')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('Joana Ribeiro').length).toBeGreaterThan(0));
    expect(screen.getAllByText('***.***.***-90').length).toBeGreaterThan(0);
    // 7.5.4 (SC-006): a lista NUNCA mostra o documento sem máscara.
    expect(screen.queryByText(/^\d{11}$/)).not.toBeInTheDocument();
  });

  it('lista vazia mostra o empty state', async () => {
    mockListarContas.mockResolvedValueOnce({ itens: [], total: 0, page: 1, pageSize: 20 });
    render(<AdiantamentosContasPage />);
    await waitFor(() => expect(screen.getByText('Nenhuma conta encontrada')).toBeInTheDocument());
  });

  it('erro de rede mostra a mensagem e o botão de tentar novamente', async () => {
    mockListarContas.mockRejectedValueOnce(new AdiantamentosApiError(500, 'Erro no servidor. Tente novamente em instantes.'));
    render(<AdiantamentosContasPage />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Erro no servidor'));
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeInTheDocument();
  });

  it('sem permissão de revisar, não mostra checkboxes de seleção nem a barra de aprovação em massa', async () => {
    mockUseHubAuth.mockReturnValue({ permissoes: ['adiantamentos.consultar', 'adiantamentos.contas_consultar'] });
    mockListarContas.mockResolvedValueOnce({ itens: [CONTA_BASE], total: 1, page: 1, pageSize: 20 });
    render(<AdiantamentosContasPage />);
    await waitFor(() => expect(screen.getAllByText('Joana Ribeiro').length).toBeGreaterThan(0));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('7.5.3/FR-020: seleciona uma conta, confirma no diálogo e reflete o resultado da API (aprovadas/ignoradas)', async () => {
    mockListarContas.mockResolvedValue({ itens: [CONTA_BASE], total: 1, page: 1, pageSize: 20 });
    mockAprovarContasEmLote.mockResolvedValueOnce({ aprovadas: 1, ignoradas: [] });
    render(<AdiantamentosContasPage />);

    await waitFor(() => expect(screen.getAllByText('Joana Ribeiro').length).toBeGreaterThan(0));

    const linhaSelecionar = screen.getByRole('checkbox', { name: 'Selecionar Joana Ribeiro' });
    fireEvent.click(linhaSelecionar);

    await waitFor(() => expect(screen.getByText('1 selecionada(s)')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Aprovar selecionadas' }));

    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Aprovar selecionadas' }));

    await waitFor(() => expect(mockAprovarContasEmLote).toHaveBeenCalledWith([5021]));
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('1 conta(s) aprovada(s).'));
  });

  it('FR-020: quando a API ignora alguma conta (fora do critério), mostra o aviso em vez de sucesso puro', async () => {
    mockListarContas.mockResolvedValue({ itens: [CONTA_BASE], total: 1, page: 1, pageSize: 20 });
    mockAprovarContasEmLote.mockResolvedValueOnce({ aprovadas: 0, ignoradas: [{ id: 5021, motivo: 'COM_ALERTAS' }] });
    render(<AdiantamentosContasPage />);

    await waitFor(() => expect(screen.getAllByText('Joana Ribeiro').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar Joana Ribeiro' }));
    await waitFor(() => expect(screen.getByText('1 selecionada(s)')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Aprovar selecionadas' }));

    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Aprovar selecionadas' }));

    await waitFor(() => expect(mockToast.warning).toHaveBeenCalled());
  });
});
