// adiantamento-motorista (FASE 7, tasks.md 7.5.2, H07): revisão dedicada de
// uma conta bancária — dado completo, confirmação do entregador vinculado
// (FR-018) e ações de aprovar/rejeitar. Mesmo molde de
// `app/hub/dashboard/adiantamentos/[id]/page.test.tsx`.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdiantamentoContaDetalhePage from './page';
import { AdiantamentosApiError } from '@/lib/hub/adiantamentos-api';

const mockObterContaCompleta = vi.fn();
const mockAprovarConta = vi.fn();
const mockRejeitarConta = vi.fn();
// vi.hoisted — mesmo motivo de contas/page.test.tsx: o factory de 'sonner'
// roda hoisted, antes de qualquer `const` deste módulo existir.
const { mockToast } = vi.hoisted(() => ({
  mockToast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: '5021' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

vi.mock('sonner', () => ({ toast: mockToast }));

vi.mock('@/lib/hub/adiantamentos-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/adiantamentos-api')>('@/lib/hub/adiantamentos-api');
  return {
    ...actual,
    obterContaCompleta: (...args: unknown[]) => mockObterContaCompleta(...args),
    aprovarConta: (...args: unknown[]) => mockAprovarConta(...args),
    rejeitarConta: (...args: unknown[]) => mockRejeitarConta(...args),
  };
});

const CONTA_COMPLETA = {
  id: 5021,
  status: 'PENDENTE',
  origem: 'CARGA_INICIAL',
  banco: 'Banco Inter',
  agencia: '0001',
  contaMascarada: '••••8812-0',
  tipoConta: 'CORRENTE' as const,
  titularNome: 'Joana Ribeiro',
  documentoMascarado: '***.***.***-90',
  alertas: [] as string[],
  motivoRejeicao: null,
  solicitadaEm: '2026-09-16T18:22:00Z',
  revisadaEm: null,
  titularDocumento: '12345678990',
  conta: '0098812',
  contaDigito: '0',
  chavePixTipo: 'CNPJ',
  chavePix: '12345678990',
  emailComprovante: 'joana@exemplo.com',
  entregadorVinculado: { entregadorId: 42, nome: 'Joana Ribeiro' },
};

describe('AdiantamentoContaDetalhePage', () => {
  beforeEach(() => {
    mockObterContaCompleta.mockReset();
    mockAprovarConta.mockReset();
    mockRejeitarConta.mockReset();
    mockToast.success.mockReset();
    mockToast.error.mockReset();
  });

  it('7.5.2/FR-018: mostra o dado COMPLETO (documento sem máscara) e o entregador vinculado', async () => {
    mockObterContaCompleta.mockResolvedValueOnce(CONTA_COMPLETA);
    render(<AdiantamentoContaDetalhePage />);

    await waitFor(() => expect(screen.getAllByText('Joana Ribeiro').length).toBeGreaterThan(0));
    expect(screen.getByText('12345678990')).toBeInTheDocument();
    expect(screen.getByText('joana@exemplo.com')).toBeInTheDocument();
    expect(screen.getByText(/Dados completos visíveis/)).toBeInTheDocument();
  });

  it('403 sem permissão mostra mensagem específica', async () => {
    mockObterContaCompleta.mockRejectedValueOnce(new AdiantamentosApiError(403, 'Você não tem permissão para esta ação.'));
    render(<AdiantamentoContaDetalhePage />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('permissão para revisar'));
  });

  it('FR-018: aprovar exige o checkbox de confirmação marcado antes de habilitar o botão', async () => {
    mockObterContaCompleta.mockResolvedValueOnce(CONTA_COMPLETA);
    render(<AdiantamentoContaDetalhePage />);
    await waitFor(() => expect(screen.getAllByText('Joana Ribeiro').length).toBeGreaterThan(0));

    const botaoAprovar = screen.getByRole('button', { name: /Aprovar conta/ });
    expect(botaoAprovar).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox', { name: /Confirmo que a conta pertence/ }));
    expect(botaoAprovar).not.toBeDisabled();

    mockAprovarConta.mockResolvedValueOnce({ id: 5021, status: 'APROVADA' });
    mockObterContaCompleta.mockResolvedValueOnce({ ...CONTA_COMPLETA, status: 'APROVADA' });
    fireEvent.click(botaoAprovar);

    await waitFor(() => expect(mockAprovarConta).toHaveBeenCalledWith(5021, 42));
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Conta aprovada.'));
  });

  it('rejeitar exige motivo (>=3 chars) antes de habilitar a confirmação', async () => {
    mockObterContaCompleta.mockResolvedValueOnce(CONTA_COMPLETA);
    render(<AdiantamentoContaDetalhePage />);
    await waitFor(() => expect(screen.getAllByText('Joana Ribeiro').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: /^Rejeitar$/ }));
    const dialogTitulo = await screen.findByText('Rejeitar dados bancários?');
    expect(dialogTitulo).toBeInTheDocument();

    const botaoConfirmar = screen.getByRole('button', { name: 'Rejeitar alteração' });
    expect(botaoConfirmar).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Motivo (obrigatório)'), { target: { value: 'documento ilegível' } });
    expect(botaoConfirmar).not.toBeDisabled();

    mockRejeitarConta.mockResolvedValueOnce({ id: 5021, status: 'REJEITADA' });
    mockObterContaCompleta.mockResolvedValueOnce({ ...CONTA_COMPLETA, status: 'REJEITADA' });
    fireEvent.click(botaoConfirmar);

    await waitFor(() => expect(mockRejeitarConta).toHaveBeenCalledWith(5021, 'documento ilegível'));
  });
});
