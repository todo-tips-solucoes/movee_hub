// hub-uiux-refresh (2026-08-05) — teste unitário do módulo Validação XML:
// (1) renderiza o XmlValidationCard com entidade ativa; (2) guard redireciona
// para /selecionar-entidade quando não há entidade ativa (mesmo contrato da
// tela de envio_massa de onde o card migrou — migration 0045).
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidacaoXmlApiError, type NotaRegularizada } from '@/lib/hub/validacao-xml-api';
import ValidacaoXmlHubPage, { SELECIONAR_ENTIDADE_ROUTE } from './page';

const mockReplace = vi.fn();
let mockAuth: { entidadeAtiva: number | null; carregando: boolean; permissoes: string[] };

vi.mock('@/contexts/hub-auth-context', () => ({
  useHubAuth: () => mockAuth,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

vi.mock('@/components/xml-validation-card', () => ({
  XmlValidationCard: () => <div data-testid="xml-validation-card" />,
}));

const mockListar = vi.fn();
vi.mock('@/lib/hub/validacao-xml-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/hub/validacao-xml-api')>()),
  listarRegularizadas: () => mockListar(),
}));

function nota(id: number, extra: Partial<NotaRegularizada> = {}): NotaRegularizada {
  return {
    id, nome: `Motorista ${id}`, cnpjPrestador: '12345678000199', valor: '150.50',
    dtInicial: '2026-09-01', dtFinal: '2026-09-07', regularizadaEm: '2026-10-10T13:30:00Z',
    notaAprovada: true, ...extra,
  };
}

describe('ValidacaoXmlHubPage', () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockListar.mockReset();
    mockListar.mockResolvedValue({ itens: [], total: 0, limite: 100 });
  });

  it('com entidade ativa: renderiza título e o XmlValidationCard, sem redirect', () => {
    mockAuth = { entidadeAtiva: 9001, carregando: false, permissoes: [] };
    render(<ValidacaoXmlHubPage />);
    expect(screen.getByRole('heading', { name: 'Validação XML' })).toBeInTheDocument();
    expect(screen.getByTestId('xml-validation-card')).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('sem entidade ativa: redireciona para /selecionar-entidade (guard FR-004)', () => {
    mockAuth = { entidadeAtiva: null, carregando: false, permissoes: [] };
    render(<ValidacaoXmlHubPage />);
    expect(mockReplace).toHaveBeenCalledWith(SELECIONAR_ENTIDADE_ROUTE);
  });

  describe('seção de notas enviadas após o fechamento', () => {
    beforeEach(() => {
      mockAuth = { entidadeAtiva: 9001, carregando: false, permissoes: [] };
    });

    it('lista vazia: não renderiza nada da seção (nem título, nem "nenhuma")', async () => {
      render(<ValidacaoXmlHubPage />);
      await waitFor(() => expect(mockListar).toHaveBeenCalled());
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
      expect(screen.queryByRole('heading', { name: /pagamentos retidos/i })).not.toBeInTheDocument();
      expect(screen.queryByText(/nenhuma/i)).not.toBeInTheDocument();
    });

    it('link para gerar o lote na aba Repasse: só com permissão de consultar pagamentos', async () => {
      mockListar.mockResolvedValue({ itens: [nota(1)], total: 1, limite: 100 });
      const { unmount } = render(<ValidacaoXmlHubPage />);
      await screen.findByRole('heading', { name: 'Pagamentos retidos aguardando liberação' });
      expect(screen.queryByRole('link', { name: /aba Repasse/ })).not.toBeInTheDocument();
      unmount();

      mockAuth = { entidadeAtiva: 9001, carregando: false, permissoes: ['adiantamentos.pagamentos_consultar'] };
      render(<ValidacaoXmlHubPage />);
      const link = await screen.findByRole('link', { name: /aba Repasse/ });
      expect(link).toHaveAttribute('href', '/hub/dashboard/adiantamentos/repasse');
    });

    it('renderiza os campos de cada item e diz o que o operador precisa fazer', async () => {
      mockListar.mockResolvedValue({
        itens: [nota(1), nota(2, { nome: 'Beltrano', notaAprovada: false })],
        total: 2, limite: 100,
      });
      render(<ValidacaoXmlHubPage />);
      expect(await screen.findByRole('heading', { name: 'Pagamentos retidos aguardando liberação' })).toBeInTheDocument();
      expect(screen.getByText(/liberá-lo manualmente/)).toBeInTheDocument();
      expect(screen.getAllByRole('listitem')).toHaveLength(2);
      expect(screen.getByText('Motorista 1')).toBeInTheDocument();
      expect(screen.getAllByText(/12345678000199/)).toHaveLength(2);
      expect(screen.getAllByText(/150,50/)).toHaveLength(2);
      expect(screen.getAllByText(/01\/09\/2026 a 07\/09\/2026/)).toHaveLength(2);
      expect(screen.getByText('Nota aprovada')).toBeInTheDocument();
      expect(screen.getByText('Nota recusada')).toBeInTheDocument();
      expect(screen.queryByText(/mais recentes de/)).not.toBeInTheDocument();
    });

    it('mostra a contagem total quando passa do teto', async () => {
      mockListar.mockResolvedValue({ itens: [nota(1)], total: 130, limite: 100 });
      render(<ValidacaoXmlHubPage />);
      expect(await screen.findByText(/de 130 no total/)).toBeInTheDocument();
    });

    it('erro: role=alert com "Tentar novamente" que recarrega', async () => {
      mockListar.mockRejectedValueOnce(new ValidacaoXmlApiError(500, 'Erro no servidor.', 'ERRO_SERVIDOR'));
      render(<ValidacaoXmlHubPage />);
      expect(await screen.findByRole('alert')).toHaveTextContent('Erro no servidor.');
      mockListar.mockResolvedValue({ itens: [nota(1)], total: 1, limite: 100 });
      fireEvent.click(screen.getByRole('button', { name: /tentar novamente/i }));
      expect(await screen.findByText('Motorista 1')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});
