// adiantamento-motorista (FASE 7, tasks.md 7.8, H14): remanescente semanal,
// exportação CSV e fechamento de apuração com a contagem de pendências por
// status quando recusado (7.8.4/D-23). Mesmo molde de `contas/page.test.tsx`.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdiantamentosRepassePage from './page';
import { AdiantamentosApiError } from '@/lib/hub/adiantamentos-api';
import { paraISO } from '@/lib/hub/periodo';

const HOJE = paraISO(new Date());

const mockUseHubAuth = vi.fn();
const mockObterRepasse = vi.fn();
const mockExportarRepasseCsv = vi.fn();
const mockFecharRepasse = vi.fn();
const mockObterConfiguracoes = vi.fn();
const { mockToast } = vi.hoisted(() => ({
  mockToast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/hub/dashboard/adiantamentos/repasse',
}));

vi.mock('sonner', () => ({ toast: mockToast }));

vi.mock('@/contexts/hub-auth-context', () => ({
  useHubAuth: () => mockUseHubAuth(),
}));

vi.mock('@/lib/hub/adiantamentos-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hub/adiantamentos-api')>('@/lib/hub/adiantamentos-api');
  return {
    ...actual,
    obterRepasse: (...args: unknown[]) => mockObterRepasse(...args),
    exportarRepasseCsv: (...args: unknown[]) => mockExportarRepasseCsv(...args),
    fecharRepasse: (...args: unknown[]) => mockFecharRepasse(...args),
    obterConfiguracoes: (...args: unknown[]) => mockObterConfiguracoes(...args),
  };
});

const REPASSE_ABERTO = {
  periodo: { inicio: '2026-09-10', fim: '2026-09-16', dataRepasse: null, situacao: 'aberto' as const },
  totais: { creditos: '1200.00', adiantamentos: '256.00', debitos: '0.00', remanescente: '944.00', motoristas: 1 },
  itens: [{ entregadorId: 42, nome: 'Joana Ribeiro', creditos: '1200.00', adiantamentos: '256.00', debitos: '0.00', remanescente: '944.00', negativo: false, emProcessamento: false }],
  naoPagosNoPeriodo: 0,
  total: 1,
  page: 1,
  pageSize: 20,
};

describe('AdiantamentosRepassePage', () => {
  beforeEach(() => {
    mockUseHubAuth.mockReset();
    mockObterRepasse.mockReset();
    mockExportarRepasseCsv.mockReset();
    mockFecharRepasse.mockReset();
    mockObterConfiguracoes.mockReset();
    mockObterConfiguracoes.mockResolvedValue({ vigente: null, historico: [] });
    mockToast.success.mockReset();
    mockToast.error.mockReset();
    mockUseHubAuth.mockReturnValue({
      permissoes: ['adiantamentos.consultar', 'adiantamentos.pagamentos_consultar', 'adiantamentos.pagamento_confirmar'],
    });
  });

  it('mostra loading e depois a lista com os totais', async () => {
    mockObterRepasse.mockResolvedValueOnce(REPASSE_ABERTO);
    render(<AdiantamentosRepassePage />);

    expect(screen.getByText('Carregando repasse...')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Joana Ribeiro')).toBeInTheDocument());
    expect(screen.getByText('Total (1 motorista(s))')).toBeInTheDocument();
  });

  it('lista vazia mostra o empty state', async () => {
    mockObterRepasse.mockResolvedValueOnce({ ...REPASSE_ABERTO, itens: [], total: 0 });
    render(<AdiantamentosRepassePage />);
    await waitFor(() => expect(screen.getByText('Nenhum motorista neste período')).toBeInTheDocument());
  });

  it('7.8.1: exportar CSV chama exportarRepasseCsv com o período', async () => {
    mockObterRepasse.mockResolvedValueOnce(REPASSE_ABERTO);
    render(<AdiantamentosRepassePage />);
    await waitFor(() => expect(screen.getByText('Joana Ribeiro')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Exportar CSV/ }));
    await waitFor(() => expect(mockExportarRepasseCsv).toHaveBeenCalledWith(expect.any(String)));
  });

  it('7.8.2: fechar apuração com sucesso mostra toast e recarrega', async () => {
    mockObterRepasse.mockResolvedValue(REPASSE_ABERTO);
    mockFecharRepasse.mockResolvedValueOnce({ apuracaoId: 7, motoristas: 1, total: '944.00', naoPagosNoPeriodo: 0 });
    render(<AdiantamentosRepassePage />);
    await waitFor(() => expect(screen.getByText('Joana Ribeiro')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Fechar apuração/ }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Fechar apuração', hidden: false }));
    void dialog;

    await waitFor(() => expect(mockFecharRepasse).toHaveBeenCalledWith(HOJE));
    await waitFor(() => expect(mockToast.success).toHaveBeenCalled());
  });

  it('7.8.4/D-23: recusa com APURACAO_COM_PENDENCIAS mostra a contagem por status, não só uma mensagem genérica', async () => {
    mockObterRepasse.mockResolvedValueOnce(REPASSE_ABERTO);
    mockFecharRepasse.mockRejectedValueOnce(
      new AdiantamentosApiError(409, 'Há solicitações pendentes neste período.', 'APURACAO_COM_PENDENCIAS', { LIBERADA: 2, FALHOU: 1 })
    );
    render(<AdiantamentosRepassePage />);
    await waitFor(() => expect(screen.getByText('Joana Ribeiro')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Fechar apuração/ }));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Fechar apuração', hidden: false }));

    const alerta = await screen.findByText('Há solicitações pendentes neste período — o fechamento foi recusado.');
    const bloco = alerta.closest('div') as HTMLElement;
    expect(bloco).toHaveTextContent('Adiantamento liberado: 2');
    expect(bloco).toHaveTextContent('Falha no pagamento: 1');
  });

  it('7.8.3: pills de descontos refletem a configuração vigente', async () => {
    mockObterConfiguracoes.mockResolvedValue({
      vigente: { descontoAdiantamentos: true, descontoDebitos: false },
      historico: [],
    });
    mockObterRepasse.mockResolvedValueOnce(REPASSE_ABERTO);
    render(<AdiantamentosRepassePage />);
    await waitFor(() => expect(screen.getByText('✓ Adiantamentos (bruto)')).toBeInTheDocument());
    expect(screen.getByText('— Débitos EntreGô')).toBeInTheDocument();
  });

  it('a configuração que chega depois não sobrescreve o período que o operador já digitou', async () => {
    let resolverConfig: (v: unknown) => void = () => {};
    mockObterConfiguracoes.mockReturnValue(new Promise((r) => { resolverConfig = r; }));
    mockObterRepasse.mockResolvedValue(REPASSE_ABERTO);
    render(<AdiantamentosRepassePage />);

    const campo = screen.getByLabelText('Período de apuração (início)') as HTMLInputElement;
    fireEvent.change(campo, { target: { value: '2026-09-01' } });
    resolverConfig({ vigente: { apuracaoDiaInicio: 1, descontoAdiantamentos: true, descontoDebitos: false }, historico: [] });

    await waitFor(() => expect(screen.getByText('✓ Adiantamentos (bruto)')).toBeInTheDocument());
    expect(campo.value).toBe('2026-09-01');
  });

  it('período fechado desabilita "Fechar apuração"', async () => {
    mockObterRepasse.mockResolvedValueOnce({ ...REPASSE_ABERTO, periodo: { ...REPASSE_ABERTO.periodo, situacao: 'fechado' } });
    render(<AdiantamentosRepassePage />);
    await waitFor(() => expect(screen.getByText('Joana Ribeiro')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Fechar apuração/ })).toBeDisabled();
  });
});
