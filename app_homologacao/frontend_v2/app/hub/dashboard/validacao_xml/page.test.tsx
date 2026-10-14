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
const mockMarcar = vi.fn();
const mockApagar = vi.fn();
const mockDesfazer = vi.fn();
vi.mock('@/lib/hub/validacao-xml-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/hub/validacao-xml-api')>()),
  listarRegularizadas: () => mockListar(),
  marcarJaPago: (...a: unknown[]) => mockMarcar(...a),
  apagarNota: (...a: unknown[]) => mockApagar(...a),
  desfazerJaPago: (...a: unknown[]) => mockDesfazer(...a),
}));

function nota(id: number, extra: Partial<NotaRegularizada> = {}): NotaRegularizada {
  return {
    id, nome: `Motorista ${id}`, cnpjPrestador: '12345678000199', valor: '150.50',
    dtInicial: '2026-09-01', dtFinal: '2026-09-07', regularizadaEm: '2026-10-10T13:30:00Z',
    notaAprovada: true, numeroNota: '14', jaPago: null, podeReenviarNoApp: true, ...extra,
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

  describe('ações do financeiro (Já foi pago / Apagar nota)', () => {
    const ACAO = 'adiantamentos.pagamento_confirmar';
    beforeEach(() => {
      mockMarcar.mockReset();
      mockApagar.mockReset();
      mockDesfazer.mockReset();
      mockAuth = { entidadeAtiva: 9001, carregando: false, permissoes: [ACAO] };
    });

    it('botões só aparecem com a permissão de confirmar pagamento', async () => {
      mockAuth = { entidadeAtiva: 9001, carregando: false, permissoes: [] };
      mockListar.mockResolvedValue({ itens: [nota(1)], total: 1, limite: 100 });
      const { unmount } = render(<ValidacaoXmlHubPage />);
      await screen.findByText('Motorista 1');
      expect(screen.queryByRole('button', { name: 'Já foi pago' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Apagar nota' })).not.toBeInTheDocument();
      unmount();

      mockAuth = { entidadeAtiva: 9001, carregando: false, permissoes: [ACAO] };
      render(<ValidacaoXmlHubPage />);
      expect(await screen.findByRole('button', { name: 'Já foi pago' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Apagar nota' })).toBeInTheDocument();
    });

    it('Já foi pago: confirma com referência, sai da lista e vai para "Marcados como já pagos"', async () => {
      mockListar.mockResolvedValue({ itens: [nota(1), nota(2)], total: 2, limite: 100 });
      mockMarcar.mockResolvedValue(nota(1, { jaPago: { em: '2026-10-14T12:00:00Z', manual: true, por: 'Ana', referencia: 'UneCont NF 14' } }));
      render(<ValidacaoXmlHubPage />);
      fireEvent.click((await screen.findAllByRole('button', { name: 'Já foi pago' }))[0]);
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveTextContent('Motorista 1');
      expect(dialog).toHaveTextContent('nº 14');
      fireEvent.change(screen.getByLabelText(/Referência do pagamento/), { target: { value: 'UneCont NF 14' } });
      fireEvent.click(screen.getByRole('button', { name: 'Marcar como pago' }));
      await waitFor(() => expect(mockMarcar).toHaveBeenCalledWith(1, 'UneCont NF 14'));
      expect(await screen.findByText('Marcados como já pagos (1)')).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Já foi pago' })).toHaveLength(1);
      expect(screen.getByText(/por Ana · UneCont NF 14/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Desfazer' })).toBeInTheDocument();
    });

    it('Apagar nota: confirmar fica desabilitado até informar o motivo; depois some da lista', async () => {
      mockListar.mockResolvedValue({ itens: [nota(1)], total: 1, limite: 100 });
      mockApagar.mockResolvedValue({ podeReenviarNoApp: true });
      render(<ValidacaoXmlHubPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'Apagar nota' }));
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveTextContent(/verá este movimento de novo no app/);
      const confirmar = screen.getAllByRole('button', { name: 'Apagar nota' }).find((b) => dialog.contains(b))!;
      expect(confirmar).toBeDisabled();
      fireEvent.change(screen.getByLabelText(/Motivo \(obrigatório\)/), { target: { value: '   ' } });
      expect(confirmar).toBeDisabled();
      fireEvent.change(screen.getByLabelText(/Motivo \(obrigatório\)/), { target: { value: 'Já paga pela UneCont' } });
      expect(confirmar).toBeEnabled();
      fireEvent.click(confirmar);
      await waitFor(() => expect(mockApagar).toHaveBeenCalledWith(1, 'Já paga pela UneCont'));
      expect(await screen.findByText(/Nota apagada\. Motorista 1 verá o movimento de novo no app/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Já foi pago' })).not.toBeInTheDocument();
    });

    it('Apagar nota antes do corte avisa que o motorista NÃO consegue reenviar', async () => {
      mockListar.mockResolvedValue({ itens: [nota(1, { podeReenviarNoApp: false })], total: 1, limite: 100 });
      render(<ValidacaoXmlHubPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'Apagar nota' }));
      expect(await screen.findByRole('dialog')).toHaveTextContent(/NÃO conseguirá reenviar/);
    });

    it('conciliação por planilha aparece no bloco sem Desfazer', async () => {
      mockListar.mockResolvedValue({
        itens: [nota(1, { jaPago: { em: '2026-10-13T00:00:00Z', manual: false, por: null, referencia: null } })],
        total: 1, limite: 100,
      });
      render(<ValidacaoXmlHubPage />);
      expect(await screen.findByText('Marcados como já pagos (1)')).toBeInTheDocument();
      expect(screen.getByText(/conciliação com a planilha/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Desfazer' })).not.toBeInTheDocument();
    });

    it('Desfazer devolve o item à lista de retidos', async () => {
      mockListar.mockResolvedValue({
        itens: [nota(1, { jaPago: { em: '2026-10-14T00:00:00Z', manual: true, por: 'Ana', referencia: null } })],
        total: 1, limite: 100,
      });
      mockDesfazer.mockResolvedValue(nota(1));
      render(<ValidacaoXmlHubPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'Desfazer' }));
      expect(await screen.findByRole('button', { name: 'Já foi pago' })).toBeInTheDocument();
      expect(mockDesfazer).toHaveBeenCalledWith(1);
      expect(screen.queryByText(/Marcados como já pagos/)).not.toBeInTheDocument();
    });

    it('erro da API aparece dentro do diálogo', async () => {
      mockListar.mockResolvedValue({ itens: [nota(1)], total: 1, limite: 100 });
      mockMarcar.mockRejectedValue(new ValidacaoXmlApiError(409, 'Este movimento já está marcado como pago.', 'JA_MARCADO_COMO_PAGO'));
      render(<ValidacaoXmlHubPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'Já foi pago' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Marcar como pago' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Este movimento já está marcado como pago.');
    });
  });
});
