// hub-importacoes (S4) FASE 6 task 6.1.4 — renderização do histórico
// (tabela + filtros), estados de loading/vazio/erro, paginação e gate de
// permissão do wizard de upload.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ImportacoesPage from './page';
import { ImportacaoApiError } from '@/lib/hub/importacoes-api';

const mockUseHubAuth = vi.fn();
const mockListarImportacoes = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/contexts/hub-auth-context', () => ({
  useHubAuth: () => mockUseHubAuth(),
}));

vi.mock('@/lib/hub/importacoes-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/importacoes-api')>('@/lib/hub/importacoes-api');
  return {
    ...actual,
    listarImportacoes: (...args: unknown[]) => mockListarImportacoes(...args),
  };
});

const ITEM_BASE = {
  id: 10,
  tipo: 'faturamento' as const,
  status: 'completed' as const,
  nomeArquivo: 'faturamento-junho.csv',
  totalLinhas: 100,
  linhasValidas: 100,
  linhasInvalidas: 0,
  dataReferencia: '2026-06-30',
  criadoPor: 3,
  iniciadoEm: '2026-07-01T10:00:00Z',
  concluidoEm: '2026-07-01T10:02:00Z',
  duracaoSegundos: 120,
  aguardandoLock: false,
};

function withPermissoes(permissoes: string[]) {
  mockUseHubAuth.mockReturnValue({ permissoes });
}

describe('ImportacoesPage', () => {
  beforeEach(() => {
    mockUseHubAuth.mockReset();
    mockListarImportacoes.mockReset();
    withPermissoes(['importacoes.consultar', 'importacoes.criar']);
  });

  it('mostra loading e depois a tabela com os itens do histórico', async () => {
    mockListarImportacoes.mockResolvedValueOnce({ items: [ITEM_BASE], total: 1, page: 1, pageSize: 20 });
    render(<ImportacoesPage />);

    expect(screen.getByText('Carregando importações...')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('faturamento-junho.csv').length).toBeGreaterThan(0));
  });

  it('estado vazio: nenhuma importação encontrada', async () => {
    mockListarImportacoes.mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 20 });
    render(<ImportacoesPage />);
    await waitFor(() => expect(screen.getByText('Nenhuma importação encontrada')).toBeInTheDocument());
  });

  it('estado de erro: mostra mensagem + botão de retry que refaz a busca', async () => {
    mockListarImportacoes.mockRejectedValueOnce(new ImportacaoApiError(500, 'Erro no servidor. Tente novamente.'));
    render(<ImportacoesPage />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Erro no servidor'));

    mockListarImportacoes.mockResolvedValueOnce({ items: [ITEM_BASE], total: 1, page: 1, pageSize: 20 });
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => expect(mockListarImportacoes).toHaveBeenCalledTimes(2));
  });

  it('sinaliza aguardandoLock (dec-032/CHK013) distinto de pending recém-criado', async () => {
    mockListarImportacoes.mockResolvedValueOnce({
      items: [{ ...ITEM_BASE, id: 11, status: 'pending', aguardandoLock: true }],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    render(<ImportacoesPage />);
    await waitFor(() =>
      expect(
        screen.getAllByLabelText('Aguardando outra importação do mesmo tipo terminar').length
      ).toBeGreaterThan(0)
    );
  });

  it('gate de permissão: sem importacoes.criar, o botão "Nova importação" não aparece', async () => {
    withPermissoes(['importacoes.consultar']);
    mockListarImportacoes.mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 20 });
    render(<ImportacoesPage />);
    await waitFor(() => expect(mockListarImportacoes).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Nova importação' })).not.toBeInTheDocument();
  });

  it('filtro de tipo dispara nova busca com o filtro aplicado', async () => {
    mockListarImportacoes.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    render(<ImportacoesPage />);
    await waitFor(() => expect(mockListarImportacoes).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByRole('combobox', { name: 'Tipo' }), { target: { value: 'faturamento' } });
    await waitFor(() => expect(mockListarImportacoes).toHaveBeenCalledTimes(2));
    expect(mockListarImportacoes.mock.calls[1][0]).toMatchObject({ tipo: 'faturamento' });
  });

  // impeccable rodada 4 (h4): a paginação artesanal desta tela deu lugar ao
  // `PaginationControls` compartilhado — os botões viraram ícone com rótulo
  // acessível ("Próxima página"/"Página anterior") em vez de texto. O
  // comportamento asserido é o mesmo.
  it('paginação: botão Próxima desabilitado quando já está na última página', async () => {
    mockListarImportacoes.mockResolvedValueOnce({ items: [ITEM_BASE], total: 1, page: 1, pageSize: 20 });
    render(<ImportacoesPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Próxima página' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Página anterior' })).toBeDisabled();
  });
});
