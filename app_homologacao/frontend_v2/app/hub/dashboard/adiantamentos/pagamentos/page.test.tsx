// adiantamento-motorista (FASE 7, tasks.md 7.6, H08–H11): seleção por
// página/"todas do filtro" (7.6.1), prévia com aptas/pendências (7.6.2) e
// confirmação de criação de lote com aviso de limite (7.6.3, edge #25).
// Mesmo molde de `contas/page.test.tsx`.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdiantamentosPagamentosPage from './page';
import { AdiantamentosApiError } from '@/lib/hub/adiantamentos-api';

const mockUseHubAuth = vi.fn();
const mockListarSolicitacoes = vi.fn();
const mockPreviaLote = vi.fn();
const mockCriarLote = vi.fn();
const mockPush = vi.fn();
const { mockToast } = vi.hoisted(() => ({
  mockToast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/hub/dashboard/adiantamentos/pagamentos',
  useRouter: () => ({ push: mockPush, replace: vi.fn(), back: vi.fn() }),
}));

vi.mock('sonner', () => ({ toast: mockToast }));

vi.mock('@/contexts/hub-auth-context', () => ({
  useHubAuth: () => mockUseHubAuth(),
}));

vi.mock('@/lib/hub/adiantamentos-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/adiantamentos-api')>('@/lib/hub/adiantamentos-api');
  return {
    ...actual,
    listarSolicitacoes: (...args: unknown[]) => mockListarSolicitacoes(...args),
    previaLote: (...args: unknown[]) => mockPreviaLote(...args),
    criarLote: (...args: unknown[]) => mockCriarLote(...args),
  };
});

const SOLICITACAO_BASE = {
  id: 501,
  integrationId: 'ADV-000501',
  motorista: { entregadorId: 9, nome: 'Otávio Lins' },
  dataSolicitacao: '2026-09-17T10:00:00Z',
  dataProducao: '2026-09-16',
  status: 'LIBERADA',
  motivoStatus: null,
  valorLiquido: '71.65',
  pendencias: [],
  loteId: null,
};

describe('AdiantamentosPagamentosPage', () => {
  beforeEach(() => {
    mockUseHubAuth.mockReset();
    mockListarSolicitacoes.mockReset();
    mockPreviaLote.mockReset();
    mockCriarLote.mockReset();
    mockPush.mockReset();
    mockToast.success.mockReset();
    mockToast.error.mockReset();
    mockToast.warning.mockReset();
    mockUseHubAuth.mockReturnValue({
      permissoes: ['adiantamentos.consultar', 'adiantamentos.pagamentos_consultar', 'adiantamentos.lote_criar'],
    });
  });

  it('mostra loading e depois a lista de liberadas', async () => {
    mockListarSolicitacoes.mockResolvedValueOnce({ itens: [SOLICITACAO_BASE], total: 1, page: 1, pageSize: 20 });
    render(<AdiantamentosPagamentosPage />);

    expect(screen.getByText('Carregando solicitações liberadas...')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('Otávio Lins').length).toBeGreaterThan(0));
    expect(mockListarSolicitacoes).toHaveBeenCalledWith(expect.objectContaining({ status: 'LIBERADA' }));
  });

  it('lista vazia mostra o empty state', async () => {
    mockListarSolicitacoes.mockResolvedValueOnce({ itens: [], total: 0, page: 1, pageSize: 20 });
    render(<AdiantamentosPagamentosPage />);
    await waitFor(() => expect(screen.getByText('Nenhuma solicitação liberada')).toBeInTheDocument());
  });

  it('7.6.1: selecionar um item mostra a barra de seleção com a contagem (sem somar valores no cliente)', async () => {
    mockListarSolicitacoes.mockResolvedValueOnce({ itens: [SOLICITACAO_BASE], total: 1, page: 1, pageSize: 20 });
    render(<AdiantamentosPagamentosPage />);
    await waitFor(() => expect(screen.getAllByText('Otávio Lins').length).toBeGreaterThan(0));

    const checkbox = screen.getByRole('checkbox', { name: 'Selecionar ADV-000501' });
    fireEvent.click(checkbox);

    expect(screen.getByText('1 selecionada(s)')).toBeInTheDocument();
  });

  it('7.6.2: revisar lote chama previaLote e mostra aptas e pendências com motivo', async () => {
    mockListarSolicitacoes.mockResolvedValueOnce({ itens: [SOLICITACAO_BASE], total: 1, page: 1, pageSize: 20 });
    mockPreviaLote.mockResolvedValueOnce({
      selecionadas: 1,
      aptas: [{ id: 501, integrationId: 'ADV-000501', motorista: 'Otávio Lins', valor: '71.65', bancoAgenciaContaMascarados: 'Nubank · 0001 · ••••2290-5' }],
      pendentes: [],
      quantidadeApta: 1,
      totalApto: '71.65',
    });
    render(<AdiantamentosPagamentosPage />);
    await waitFor(() => expect(screen.getAllByText('Otávio Lins').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar ADV-000501' }));
    fireEvent.click(screen.getByRole('button', { name: /Revisar lote/ }));

    await waitFor(() => expect(mockPreviaLote).toHaveBeenCalledWith([501]));
    await waitFor(() => expect(screen.getByText('Revisar lote')).toBeInTheDocument());
    expect(screen.getAllByText('ADV-000501').length).toBeGreaterThan(0);
  });

  it('7.6.2: pendências aparecem com o motivo traduzido (STATUS_PAGA → rótulo)', async () => {
    mockListarSolicitacoes.mockResolvedValueOnce({ itens: [SOLICITACAO_BASE], total: 1, page: 1, pageSize: 20 });
    mockPreviaLote.mockResolvedValueOnce({
      selecionadas: 1,
      aptas: [],
      pendentes: [{ id: 501, pendencias: ['STATUS_PAGA'] }],
      quantidadeApta: 0,
      totalApto: '0.00',
    });
    render(<AdiantamentosPagamentosPage />);
    await waitFor(() => expect(screen.getAllByText('Otávio Lins').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar ADV-000501' }));
    fireEvent.click(screen.getByRole('button', { name: /Revisar lote/ }));

    await waitFor(() => expect(screen.getByText(/Status atual: Pagamento realizado/)).toBeInTheDocument());
    expect(screen.getByText('Nenhuma solicitação apta')).toBeInTheDocument();
  });

  it('7.6.3: confirmar geração do lote envia só os ids das aptas e redireciona para o lote', async () => {
    mockListarSolicitacoes.mockResolvedValueOnce({ itens: [SOLICITACAO_BASE], total: 1, page: 1, pageSize: 20 });
    mockPreviaLote.mockResolvedValueOnce({
      selecionadas: 1,
      aptas: [{ id: 501, integrationId: 'ADV-000501', motorista: 'Otávio Lins', valor: '71.65', bancoAgenciaContaMascarados: null }],
      pendentes: [],
      quantidadeApta: 1,
      totalApto: '71.65',
    });
    mockCriarLote.mockResolvedValueOnce({ id: 999, numero: '000999', quantidade: 1 });
    render(<AdiantamentosPagamentosPage />);
    await waitFor(() => expect(screen.getAllByText('Otávio Lins').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar ADV-000501' }));
    fireEvent.click(screen.getByRole('button', { name: /Revisar lote/ }));
    await waitFor(() => expect(screen.getByText('Revisar lote')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Gerar arquivo Transfeera/ }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Gerar lote e arquivo/ }));

    await waitFor(() => expect(mockCriarLote).toHaveBeenCalledWith(expect.objectContaining({
      ids: [501], quantidadeEsperada: 1, totalEsperado: '71.65',
    })));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/hub/dashboard/adiantamentos/lotes/999'));
  });

  it('7.6.1/edge #25: "selecionar todas do filtro" nunca ultrapassa 5.000 e avisa quando o filtro é maior', async () => {
    // ids da página exibida (9001-9020) NÃO se sobrepõem aos ids 1-5000 que
    // o mock de "todas do filtro" devolve — isola o efeito de cada seleção.
    const muitos = Array.from({ length: 20 }, (_, i) => ({ ...SOLICITACAO_BASE, id: 9001 + i, integrationId: `ADV-${9001 + i}` }));
    mockListarSolicitacoes.mockResolvedValueOnce({ itens: muitos, total: 6000, page: 1, pageSize: 20 });
    render(<AdiantamentosPagamentosPage />);
    await waitFor(() => expect(screen.getAllByText('Otávio Lins').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar todas desta página' }));
    mockListarSolicitacoes.mockImplementation(({ page }: { page: number }) => Promise.resolve({
      itens: Array.from({ length: 100 }, (_, i) => ({ ...SOLICITACAO_BASE, id: (page - 1) * 100 + i + 1 })),
      total: 6000, page, pageSize: 100,
    }));
    fireEvent.click(screen.getByRole('button', { name: /Selecionar as 6000 do filtro/ }));

    await waitFor(() => expect(mockToast.warning).toHaveBeenCalled());
    // capado em exatamente 5.000 — "Revisar lote" continua habilitado (não excede).
    await waitFor(() => expect(screen.getByText('5000 selecionada(s)')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Revisar lote/ })).not.toBeDisabled();

    // uma seleção manual ADICIONAL (os 20 da página, fora do range 1-5000
    // devolvido pelo mock acima) empurra o total para 5.020 — aí sim excede.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar todas desta página' }));
    await waitFor(() => expect(screen.getByText(/excede o limite de 5000/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Revisar lote/ })).toBeDisabled();
  });

  it('sem a permissão "lote_criar" não mostra checkboxes de seleção', async () => {
    mockUseHubAuth.mockReturnValue({ permissoes: ['adiantamentos.consultar', 'adiantamentos.pagamentos_consultar'] });
    mockListarSolicitacoes.mockResolvedValueOnce({ itens: [SOLICITACAO_BASE], total: 1, page: 1, pageSize: 20 });
    render(<AdiantamentosPagamentosPage />);
    await waitFor(() => expect(screen.getAllByText('Otávio Lins').length).toBeGreaterThan(0));
    expect(screen.queryByRole('checkbox', { name: 'Selecionar ADV-000501' })).not.toBeInTheDocument();
  });
});
