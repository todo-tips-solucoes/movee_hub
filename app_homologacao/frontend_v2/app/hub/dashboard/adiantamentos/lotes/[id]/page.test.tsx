// adiantamento-motorista (FASE 7, tasks.md 7.7.2/7.7.3, H12+H15): detalhe do
// lote — download (H12), cancelamento com declaração pós-download (FR-035)
// e confirmação manual de pagamento por item (H15). Mesmo molde de
// `contas/[id]/page.test.tsx`.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdiantamentoLoteDetalhePage from './page';

const mockUseHubAuth = vi.fn();
const mockObterLote = vi.fn();
const mockBaixarArquivoLote = vi.fn();
const mockCancelarLote = vi.fn();
const mockConfirmarLote = vi.fn();
const { mockToast } = vi.hoisted(() => ({
  mockToast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: '123' }),
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
    obterLote: (...args: unknown[]) => mockObterLote(...args),
    baixarArquivoLote: (...args: unknown[]) => mockBaixarArquivoLote(...args),
    cancelarLote: (...args: unknown[]) => mockCancelarLote(...args),
    confirmarLote: (...args: unknown[]) => mockConfirmarLote(...args),
  };
});

const ITEM_BASE = {
  id: 501,
  nome: 'Otávio Lins',
  documentoMascarado: '**.***.***/0001-29',
  banco: 'Nubank',
  agencia: '0001',
  contaMascarada: '••••2290-5',
  tipoConta: 'CORRENTE',
  valor: '71.65',
  integrationId: 'ADV-000501',
  descricaoPix: 'Adiantamento',
  situacao: 'incluido',
  situacaoMotivo: null,
  situacaoEm: null,
};

const LOTE_GERADO = {
  id: 123, numero: '000123', status: 'GERADO', criadoPor: { id: 1, nome: 'Ana Financeiro' },
  criadoEm: '2026-09-17T15:42:00Z', quantidade: 1, valorTotal: '71.65',
  arquivoNome: 'transfeera_x.xlsx', arquivoSha256: 'abc', downloads: 0,
  primeiroDownloadEm: null, canceladoEm: null, canceladoMotivo: null, concluidoEm: null,
  itens: [ITEM_BASE], historico: [],
};

const PERMISSOES_TODAS = [
  'adiantamentos.consultar', 'adiantamentos.pagamentos_consultar',
  'adiantamentos.exportar', 'adiantamentos.reprocessar', 'adiantamentos.pagamento_confirmar',
];

describe('AdiantamentoLoteDetalhePage', () => {
  beforeEach(() => {
    mockUseHubAuth.mockReset();
    mockObterLote.mockReset();
    mockBaixarArquivoLote.mockReset();
    mockCancelarLote.mockReset();
    mockConfirmarLote.mockReset();
    mockToast.success.mockReset();
    mockToast.error.mockReset();
    mockUseHubAuth.mockReturnValue({ permissoes: PERMISSOES_TODAS });
  });

  it('mostra loading e depois o detalhe do lote com status e itens', async () => {
    mockObterLote.mockResolvedValueOnce(LOTE_GERADO);
    render(<AdiantamentoLoteDetalhePage />);

    expect(screen.getByText('Carregando lote...')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Lote 000123')).toBeInTheDocument());
    expect(screen.getByText('Gerado')).toBeInTheDocument();
    expect(screen.getByText('ADV-000501')).toBeInTheDocument();
  });

  it('7.7.2: baixar arquivo chama baixarArquivoLote e recarrega o lote', async () => {
    mockObterLote.mockResolvedValueOnce(LOTE_GERADO);
    mockBaixarArquivoLote.mockResolvedValueOnce(undefined);
    mockObterLote.mockResolvedValueOnce({ ...LOTE_GERADO, status: 'EXPORTADO', downloads: 1 });
    render(<AdiantamentoLoteDetalhePage />);
    await waitFor(() => expect(screen.getByText('Lote 000123')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Baixar arquivo Transfeera/ }));

    await waitFor(() => expect(mockBaixarArquivoLote).toHaveBeenCalledWith(123, '000123'));
    await waitFor(() => expect(screen.getByText('Exportado')).toBeInTheDocument());
  });

  it('7.7.3: cancelar lote GERADO exige só o motivo (sem checkbox de declaração)', async () => {
    mockObterLote.mockResolvedValueOnce(LOTE_GERADO);
    mockCancelarLote.mockResolvedValueOnce({ ...LOTE_GERADO, status: 'CANCELADO' });
    render(<AdiantamentoLoteDetalhePage />);
    await waitFor(() => expect(screen.getByText('Lote 000123')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar lote' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText(/não foi enviado/)).not.toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText('Motivo (obrigatório)'), { target: { value: 'Gerado com filtro errado' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar lote' }));

    await waitFor(() => expect(mockCancelarLote).toHaveBeenCalledWith(123, 'Gerado com filtro errado', false));
    await waitFor(() => expect(mockToast.success).toHaveBeenCalled());
  });

  it('7.7.3/FR-035: cancelar lote EXPORTADO exige a declaração de "não enviado"', async () => {
    mockObterLote.mockResolvedValueOnce({ ...LOTE_GERADO, status: 'EXPORTADO' });
    mockCancelarLote.mockResolvedValueOnce({ ...LOTE_GERADO, status: 'CANCELADO' });
    render(<AdiantamentoLoteDetalhePage />);
    await waitFor(() => expect(screen.getByText('Lote 000123')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar lote' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Motivo (obrigatório)'), { target: { value: 'Não foi enviado à Transfeera' } });

    const botaoConfirmar = within(dialog).getByRole('button', { name: 'Cancelar lote' });
    expect(botaoConfirmar).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('checkbox'));
    expect(botaoConfirmar).not.toBeDisabled();
    fireEvent.click(botaoConfirmar);

    await waitFor(() => expect(mockCancelarLote).toHaveBeenCalledWith(123, 'Não foi enviado à Transfeera', true));
  });

  it('7.7.2/H15: confirmar resultado marca um item como falha com motivo e envia só esse', async () => {
    mockObterLote.mockResolvedValueOnce({ ...LOTE_GERADO, status: 'EXPORTADO' });
    mockConfirmarLote.mockResolvedValueOnce({ ...LOTE_GERADO, status: 'CONCLUIDO_COM_FALHAS' });
    render(<AdiantamentoLoteDetalhePage />);
    await waitFor(() => expect(screen.getByText('Lote 000123')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Confirmar resultado' }));
    const dialog = await screen.findByRole('dialog');

    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Marcar ADV-000501 como falha/ }));
    fireEvent.change(within(dialog).getByPlaceholderText('Ex.: Conta encerrada no banco de destino'), {
      target: { value: 'Conta encerrada' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar resultado' }));

    await waitFor(() => expect(mockConfirmarLote).toHaveBeenCalledWith(123, { falhas: [{ id: 501, motivo: 'Conta encerrada' }] }));
  });

  it('lote CANCELADO não mostra ação de cancelar nem confirmar', async () => {
    mockObterLote.mockResolvedValueOnce({ ...LOTE_GERADO, status: 'CANCELADO' });
    render(<AdiantamentoLoteDetalhePage />);
    await waitFor(() => expect(screen.getByText('Lote 000123')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Cancelar lote' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirmar resultado' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Baixar arquivo Transfeera/ })).not.toBeInTheDocument();
  });
});
